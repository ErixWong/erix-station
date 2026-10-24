// materializer：把 DB desired state 物化为 FDE 用户空间文件（D-6 直写宿主 bind mount）。
// 依据：docs/design/user-space.md（路径映射/文件清单/原子写/manifest/generation/权限/失败状态机）。
// 纯渲染（可单测）+ 原子落盘 + materialize_outbox 消费（revision head 语义 / latest-wins / 失败退避）。

import fs from 'node:fs';
import path from 'node:path';
import {
  sha256,
  atomicWriteFile,
  ensureDirSafe,
  readFileIfExists,
  assertSafePath,
  writeTempFile,
  commitTempFile,
} from './fsutil.js';
import { OBSERVATION_FRESHNESS_SECONDS } from './portalloc.js';

// 容器内用户名固定 erix（⚠️ 待决策者确认，user-space §2.4）。
export const FDE_CONTAINER_USER = 'erix';
export const CONTAINER_HOME = `/home/${FDE_CONTAINER_USER}`;

// 平台文件权限（user-space §6.2）：普通平台文件 0644，manifest 0444。
const FILE_MODE = 0o644;

// GitHub 钉位 CONNECT 代理（平台随开户下发到 ~/bin/github-pinproxy.py，AGENTS.md「GitHub 拉取」节引用）。
// 为什么平台下发而不是让 agent 现写（2026-10-24 实证）：touwakamate 工位 clone 六连败后，agent 自己
// 重新发明了同款代理（1.3KB、写进不持久的 /tmp）——能赌对，但每个 session 重发明一次就是 N 份会过期
// 的平行真相；脚本本体收进单一真相通道（同 AGENTS.md 自己的理由）。纯 TCP 转发，TLS 端到端，不碰凭据。
// 候选 IP 是历史实测值（含真机验证过的 .3/.4 与 20.205.243.16x）；全拨失败时 AGENTS.md 有自探判据。
const GITHUB_PINPROXY_SCRIPT = String.raw`#!/usr/bin/env python3
# GitHub 钉位 CONNECT 代理（平台物化下发，平台管理、勿改；用法见 ~/AGENTS.md「GitHub 拉取」节）。
# 背景：公司 DNS 间歇性把 github 域名指向不可达的旧边缘地址（TCP 连得上、HTTP 不回话）。
# 本脚本只监听 127.0.0.1，收到 CONNECT 后把 github 域名拨到候选可用 IP；纯 TCP 转发，
# TLS 端到端，证书由 git/curl 自己校验，token/代码对本脚本透明。
# 用法：python3 ~/bin/github-pinproxy.py [端口]    # 默认 18080
#   git -c http.proxy=http://127.0.0.1:<端口> fetch origin
import socket, sys, threading

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 18080
BY_HOST = {
    'github.com': ['140.82.112.4', '140.82.113.4', '140.82.114.4', '140.82.112.3', '20.205.243.166'],
    'api.github.com': ['20.205.243.168', '20.205.243.166', '140.82.113.4', '140.82.112.4'],
    'codeload.github.com': ['140.82.114.4', '140.82.113.4', '140.82.112.4', '20.205.243.166'],
    'objects.githubusercontent.com': ['140.82.112.4', '140.82.113.4', '140.82.114.4'],
    'raw.githubusercontent.com': ['140.82.112.4', '140.82.113.4', '140.82.114.4'],
}
PREFERRED = {}

def pump(a, b):
    try:
        while True:
            d = a.recv(65536)
            if not d:
                break
            b.sendall(d)
    except OSError:
        pass
    finally:
        try:
            b.shutdown(socket.SHUT_WR)
        except OSError:
            pass

def handle(c):
    buf = b''
    while b'\r\n\r\n' not in buf:
        d = c.recv(4096)
        if not d:
            c.close()
            return
        buf += d
    try:
        method, hostport, _ = buf.split(b'\r\n', 1)[0].decode().split()
    except ValueError:
        c.close()
        return
    if method != 'CONNECT':
        c.sendall(b'HTTP/1.1 400 Bad Request\r\n\r\n')
        c.close()
        return
    host, _, port = hostport.rpartition(':')
    port = int(port or 443)
    order = list(BY_HOST.get(host, []))
    if PREFERRED.get(host) in order:
        order.remove(PREFERRED[host])
        order.insert(0, PREFERRED[host])
    s = None
    for ip in (order or [host]):
        try:
            s = socket.create_connection((ip, port), timeout=6)
            if host in BY_HOST:
                PREFERRED[host] = ip
            break
        except OSError:
            pass
    if s is None:
        c.sendall(b'HTTP/1.1 502 Bad Gateway\r\n\r\n')
        c.close()
        return
    c.sendall(b'HTTP/1.1 200 Connection established\r\n\r\n')
    rest = buf.split(b'\r\n\r\n', 1)[1]
    if rest:
        s.sendall(rest)
    threading.Thread(target=pump, args=(c, s), daemon=True).start()
    pump(s, c)
    c.close()
    s.close()

srv = socket.socket()
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(('127.0.0.1', PORT))
srv.listen(64)
print('github-pinproxy on 127.0.0.1:%d' % PORT, flush=True)
while True:
    conn, _ = srv.accept()
    threading.Thread(target=handle, args=(conn,), daemon=True).start()
`;
const MANIFEST_MODE = 0o444;
// 目录权限：工作区目录传 2770，.erix 0750（user-space §6.2）。
// 2770 是历史遗留的意图值，**落盘恒为 0770**（mkdir 交不出 setgid；chown 交出属组后的下一轮 chmod
// 在 portal 缺 CAP_FSETID 时被内核静默清掉）——口径已定 0770，setgid 不承载任何行为。
// **别补 CAP_FSETID、也别把字面量改成 0o0770**；理由见 docs/design/user-space.md §6.2 / issue #273。
const WORKSPACE_DIR_MODE = 0o2770;
const ERIX_DIR_MODE = 0o750;

function json(obj) {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// 纯渲染（同 DB 快照 → 字节级相同输出）
// ---------------------------------------------------------------------------

export function renderConfigJson({ llmBaseUrl }) {
  // erix-agent v0.3.5 实测：createJsonFileModelConfigProvider 读 `slots.{default,audit,fold}` 嵌套结构，
  // 且 OpenAI provider 字段为 `endpoint`（非 baseURL）。占位 key + endpoint，零真实 LLM 凭据（runner §6.3/§11）。
  const endpoint = `${String(llmBaseUrl).replace(/\/+$/, '')}/v1`;
  return json({
    slots: {
      // 占位 model 用真实存在且 relay 支持的名字（#79 教训：冷启动竞态回退时会真发请求，
      //      虚构名会被 relay 拒绝——占位即兜底，必须可用）。
      default: { apiKey: 'erix-placeholder', endpoint, model: 'deepseek-flash' },
      audit: { apiKey: 'erix-placeholder', endpoint, model: 'deepseek-flash' },
      fold: { apiKey: 'erix-placeholder', endpoint, model: 'deepseek-flash' },
    },
  });
}

export function renderMcpJson() {
  return json({ mcpServers: {} });
}

export function renderHomeAgentsMd({ fdeName }) {
  return [
    '# FDE 工位约定',
    '',
    '> 本文件由平台（materializer）生成，属平台所有（root:root 0644）；改动会被对账重物化覆盖。',
    '',
    '## 目录约定',
    '',
    `- 一个项目 = \`~/projects/<project>\`（本容器用户 ${FDE_CONTAINER_USER}）——目录即项目，无注册`,
    '- 一个 run 直接在项目目录 `~/projects/<project>` 工作，交付物留在项目目录内',
    '- **端口一律从 `~/.erix/ports.json` 取**，不要自己挑；dev server 绑 `0.0.0.0`',
    // 端口呈现优化·防止层第 1 条（观测 MVP 同期的规范层）：同一项目新旧两个 dev server 各占一口
    // 是真机实证过的迷局（用户面对两个长得一样的预览地址分不清哪个是活的）。平台只观测展示不代删，
    // 「先停旧、复用原号」是 agent 侧义务。红线同本节：零端口数字、零域名字面量。
    '- **复用端口前先看旧进程**：清单里的号若已被你自己上一轮的 dev server 占着（同目录/同仓库的旧实例），先停旧进程、**在原号上重起**；不要另领新号——一个项目同时占两口，用户就分不清哪个预览地址是活的（平台会在端口面板如实展示两处监听，但僵尸进程只会制造困惑）',
    // issue #240 引入、#246 交付①改口径：端口事实的「告知」落点之一（另一个是 runner 的 SYSTEM_PROMPT）。
    // 平台在开户时从**全局号池 22000–29999**里给每个 FDE 发一整段预览域名（默认 10 个一段，
    // 管理员可改），号码由平台决定且可回收 ⇒ 这里**不写死端口区间**：清单本身就是唯一真相
    // （写死就会出现「文档说 4000–4009、盘上是 22000–22009」那类告知失败，#246）。
    '- 预览域名由平台在开户时**分配一整段**（默认 10 条，每条带真实 `url`）：**`~/.erix/ports.json` 的清单就是唯一真相**，不要凭记忆猜端口，也不要要求平台加号；不够用就在清单里复用',
    '- 回流走 fork/PR，不直接在主干改',
    '- `node_modules` 每项目一份；依赖缓存（npm cache / pnpm store / corepack / pip）**已由镜像默认指到 `~/cache`**——不要把 store/cache 改到 `~/projects` 下（会在项目列表里长出 `.pnpm-store` 这类目录），也不要在项目里建 `.pnpm-store`',
    '',
    // issue #257 + #258（工单 feat-261012-01）：**平台侧应用要求链的单一真相就落在这一节**。
    // 为什么落在 `~/AGENTS.md` 而不是 runner 的 `SYSTEM_PROMPT`（决策者 2026-10-12 定稿，#258
    // `#issuecomment-6117800165`）：提示词与 portal 常量是两个包里的两份文案，规则抄进提示词就是
    // 埋下第二个会过期的真相源（同 AGENTS.md §8.10「工具名从注册面取、不手抄清单」）；提示词只留
    // 「先读 `~/AGENTS.md`」的强制指针。前 6 条的实证来源是演练记录 docs/ops/drill-2026-10-12.md §三
    // （一个最普通的前后端分离 to-do 要满足 6 条，当时有 3 条压根没告知，靠人发第 3、4 条消息才修通）；
    // 第 7 条来自 issue #262（R-2 演练：应用自己的 cookie 会话在预览域名下必死）+ #263 复测（边缘对
    // `Cookie` 头是**全方法一致**剥除，半通猜想已证伪）。措辞是决策者在 #262 评论里定的稿，不许自行改写语义。
    // 第 8 条来自 issue #285（工单 feat-261014-01，告知面的最后一公里）：前 7 条管「服务怎么起才能被访问到」，
    // 第 8 条管「起好之后有没有把用户能点的那个地址说出来」——容器内 `~/.erix/ports.json` 每条分配**自带现成的
    // `url` 字段**（#246 的告知面），缺的从来不是信息而是行为约束。措辞是决策者定稿：它是**告知义务**，
    // 不是一种错误形态 ⇒ **不往「错误形态对照」表里加行**；逐 host 放行的规则**回指第 6 条**，不在此重述
    // （同一规则住两处 = 两份会过期的真相，同 §8.10）。
    // ⚠ 红线：本节**不许出现端口数字 / 端口区间 / 伞域字面量**（号段与域名都是生成值），由
    //   portal/test/materializer.test.js 钉死；#259（jail 只读例外）落地前家目录文件只能 `cat`。
    '## 预览访问：外部浏览器要用这个应用，必须满足这 8 条',
    '',
    '> 平台负责把请求送到容器，但**容器内不做端口管控**：下面 8 条全在你这一侧，缺一条就有一种挂法（第 8 条缺了不会挂，但用户拿不到能点的地址）。',
    '',
    '1. **端口从 `~/.erix/ports.json` 取**——前后端各占清单里的一条，不要发明端口，也不要凭记忆猜。条目里 `in_use: true` = 此刻有进程在听（平台观测，可能滞后），**优先避开**；真撞上了 `bind` 会报错，换清单里下一个号重试即可。`in_use: null` = 无观测数据，**不要当成空闲**。',
    '2. **服务监听 `0.0.0.0`**（容器内），绑 `127.0.0.1` 等于没人接。',
    '3. **把预览 host 加进 dev server 自己的主机白名单**：host 就取该条分配记录里的 `url`（**窄范围优先**，用到的逐条列全）。后缀匹配（一次放开整棵子域）可以接受，但要在注释里说明它放开了整棵子域；**不要 `allowedHosts: true` / `"all"` 一把梭**。配置项名字各框架不同——Vite 是 `server.allowedHosts`，webpack-dev-server 是 `devServer.allowedHosts`，其它框架按你实际用的版本核实，别一律叫 `allowedHosts`。',
    '4. **跨预览端口调用要带凭据**：前端 `fetch` 传 `credentials:\'include\'`（XHR 用 `withCredentials`）。平台的通行凭证是**每条 host 各自的 host-only `HttpOnly` cookie**，不带凭据会被边缘拒成 `403`，且响应体里的 `code` 是 `preview_ticket_required`。',
    '5. **后端 CORS 不能回 `*`**：带凭据的请求必须**回显请求的 `Origin`**，并带 `Access-Control-Allow-Credentials: true` 与 `Vary: Origin`（`*` 与凭据不兼容）。`OPTIONS` 预检按规范**不带凭据**，要在鉴权**之前**直接答掉，否则「缺票据」会被伪装成「应用 CORS 配错」。',
    '6. **每条预览 host 各需一次放行**：前端那条 host 有票 ≠ 后端那条也有票。现阶段用户需逐条点「打开预览」；自测跨 host 调用前，先把用到的每条 host 都各自放行一次。',
    // 第 7 条（issue #262，措辞为决策者定稿）：应用侧 cookie 会话在预览域名下必死——#263 已证伪「半通」猜想，
    // 边缘对 `Cookie` 头是**全方法一致**剥除（routes.js 每条预览 router 都挂 `strip-cookie`）。
    '7. **应用自己的登录态不要用 Cookie**——边缘会剥掉整个请求的 `Cookie` 头（**所有方法一致**，by design）：浏览器收到的 `Set-Cookie` 能种上，但之后任何请求都不会把它带回应用，**「POST 登录成功、GET 立刻 401/未登录」就是这个形状**。正确做法：登录接口把 token 放进**响应体**，前端 `localStorage` 保存，之后每个请求带 `Authorization: Bearer <token>`。（第 4 条的 `credentials:\'include\'` 只服务于平台票据 cookie 的放行判定，不改变本条。）',
    // 第 8 条（issue #285，措辞为决策者定稿）：告知义务。红线同上——**零端口数字**（对外入口不是 `:<端口>`
    // 这句只写形状不写号）、**零伞域字面量**；逐 host 放行**回指第 6 条**，不重述规则。
    '8. **报「服务已起」时，把用户能点的那个地址说出来**：从 `~/.erix/ports.json` 里取该端口对应的那条 **`url` 原值**，在回复里给出**完整 URL**，并直接给成 `markdown 链接` 让用户可点——**不要只报端口号**：对外入口不是 `:<端口>`，裸端口号对用户没有意义。同时提醒用户：该地址需要先从门户「打开预览」放行，且按第 6 条**每条 host 各需一次**（前后端分离应用要分别放行两次）。',
    '',
    '**错误形态对照**（先分清是谁给的，再决定改哪一侧）：',
    '',
    '- `403` + 正文含 `Blocked request. This host (…) is not allowed.` ⇒ **应用给的**（dev server 主机白名单，第 3 条）。',
    '- `403` + 体形如 `{"error":{"code":"preview_ticket_required",…}}` ⇒ **平台边缘给的**（凭据 / 票据链路，第 4、6 条）。',
    '- `502 Bad Gateway` ⇒ 平台已放行，但**那个端口上没人在监听**（回到第 1、2 条：端口取清单、绑 `0.0.0.0`）。',
    '- `POST` 登录成功、随后 `GET` 变未登录/401 ⇒ **应用自己的 cookie 会话被边缘剥光**（第 7 条）——不是平台鉴权问题（平台缺票给的是 `403` + `preview_ticket_required` 体）。',
    '- 前端渲染错误时把响应里的 `code` / `message` 显示出来；把响应对象直接塞进模板会得到 `[object Object]`，把上面这些线索全吃掉。',
    '',
    '## clone 方式',
    '',
    '- 平台不 clone、不下发 git 凭据；SSH key / token 由你在容器内自行配置（等同你自己的开发机）',
    '- 空目录：`git clone <地址> .`（`.` 后缀 = clone 进当前目录）',
    '- 或直接 `git init` 新建；目录非空时 clone 到临时目录再搬移',
    '',
    '## 环境事实（先查再用，不要重复安装）',
    '',
    '- Node 22 / npm / pnpm（corepack）、python3 + venv/pip、gcc/g++/make、.NET SDK 8 已预装',
    '- **Playwright 浏览器已烘焙在 `/ms-playwright`（chromium + headless shell），无需 `playwright install`**；浏览器不在 PATH 上（`which chromium` 为空是正常的），用 `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` 或 `chromium.executablePath()` 定位',
    '- `which` 探测不到 ≠ 未安装；先查 `/ms-playwright`、`/usr/local/lib/node_modules` 再动手',
    '',
    '## git',
    '',
    '- clone 与 git 凭据（SSH key / token）由你在容器内自行配置（等同你自己的开发机）',
    '- 平台不 clone、不下发 git 凭据，**也不替你提交**：首次运行时平台只会对还不是仓库的目录执行一次 `git init -b main`',
    '- **收工即提交**：任务完成（含你新建/修改的文件，未跟踪的与改过的同样算没兜底）就 `git commit`，有远端就 `git push`。',
    '  别把改动留在工作区——工作台的状态灯靠这个判断，一直亮着就说明没收工',
    '- **一个目录里有多个仓库就逐个仓库分别提交**：父目录的仓库**不包含**子目录里的仓库，在父目录提交是白干的',
    '- 目录还没有远端 ⇒ 提醒用户自行配置（平台不代配）',
    '',
    // GitHub 连通性（2026-10-24 真机：某工位 clone 六连败后靠 tarball 快照才拿到代码）。
    // 只写「症状 + 怎么自己找可用 IP + 兑底手段」，不把可用 IP 当清单拄进来（同上面不写端口号池的理由）。
    '## GitHub 拉取：clone 超时先查解析，不是断网',
    '',
    '- 出口链路没封，但公司 DNS 常把 `github.com` / `api.github.com` 指向一两个**不可达的旧边缘地址**（现象：TCP 连得上、TLS 握得上、HTTP 不回话）。所以 `git clone` 反复超时/挂死时，先怀疑解析结果。',
    '- 3 秒定性（通了就确认是解析问题）：`timeout 10 curl -s -o /dev/null -w "%{http_code}\n" --max-time 8 --resolve github.com:443:<候选IP> https://github.com`，多个候选试到一个返 2xx/3xx 的即拿它当可用 IP；`getent hosts github.com` 看到与可用地址不同即中招。',
    '- 可用期间的正确做法：直接起平台已下发的钉位代理 `python3 ~/bin/github-pinproxy.py`（只监听回环、监听端口见脚本首行用法注释，平台管理别改；端口被占可传参换），再 `git -c http.proxy=http://127.0.0.1:<端口> fetch origin`——**保完整历史**（git 无 `https.proxy` 配置键，`http.proxy` 对 https 远端同样生效）。自己另写代理时脚本放 `~/bin` 不放 `/tmp`（`/tmp` 不持久）。',
    '- 兑底（拿不到代理时）：`codeload.github.com/<owner>/<repo>/tar.gz/HEAD` 拉默认分支快照——**没有历史**，拿到后记得用上面的方法 `git fetch` 补回。',
    '- 容器内**没有 ssh 客户端**，不要规划 SSH 备选路径；`codeload.github.com` 通常不受该解析问题影响。',
    '',
    `（FDE 标识：${fdeName}）`,
    '',
  ].join('\n');
}

// P5 去项目化（directory-as-project §3/§5）：ports.json 升为 FDE 级单一文件 ~/.erix/ports.json——
// allocations 不再按项目分组（port_allocations.project_id 已退役，迁移 0008）。
export function renderPortsJson({ fdeName, allocations, generation, observedPorts = null }) {
  // schema 2（#361）：只载**分配事实**（哪些号归我 + 逐条现成 url），使用面事实不上文件。
  // 旧字段 state/role/run_id/scope/exposure 剃除：P5 后 role 恒 spare、run_id 恒 NULL、
  // state 只表示「放行过一次」——全是使用面幻觉，agent 消费不了还误导。
  // in_use = 新鲜观测镜像（≤45s）的**咨询位**：起服务前避开被占的口；仲裁仍是 bind()
  //（内核原子 test-and-set，EADDRINUSE 即拒绝）——平台不据观测做任何管控，#246 不变。
  // observedPorts=null ⇒ 无观测数据（旧 agentd / 观测表不可用），in_use 整体降级为 null（=「不知道」，≠空闲）。
  const ports = allocations.map((a) => Number(a.port)).sort((x, y) => x - y);
  return json({
    schema: 2,
    fde: fdeName,
    generation,
    block: ports.length > 0 ? { start: ports[0], end: ports[ports.length - 1] } : null,
    allocations: allocations.map((a) => ({
      port: Number(a.port),
      url: a.url,
      in_use: observedPorts === null ? null : observedPorts.includes(Number(a.port)),
    })),
  });
}

export function renderManifest({ fdeName, generation, entries, materializedAt }) {
  // files 键字典序（幂等序列化，user-space §5.5）。
  const keys = Object.keys(entries).sort();
  const files = {};
  for (const k of keys) {
    files[k] = { sha256: entries[k].sha256, revision: entries[k].revision };
  }
  return json({
    schema: 1,
    fde: fdeName,
    generation,
    materialized_at: materializedAt instanceof Date ? materializedAt.toISOString() : materializedAt,
    files,
  });
}

/**
 * 计算 hostPath（宿主路径 = <root>/<fde> 前缀 + 容器相对路径）。
 * 容器绝对路径 /home/erix/... → 宿主 <root>/<fde>/home/...。
 * D8 修订 + P5：projects/cache 是独立挂载（user-space §2.4），worktrees 挂载已拆除（#81 P2.5）。
 */
export function hostPathFor(root, fdeName, containerPath) {
  const rel = containerPath.replace(new RegExp(`^${CONTAINER_HOME}/`), '');
  const top = rel.split('/')[0];
  // 容器内 projects/cache 是独立挂载（user-space §2.4），直接映射到 <root>/<fde>/<top>；
  // 其余（home 内容：AGENTS.md、.erix/* 等）映射到 <root>/<fde>/home/<rel>。
  if (top === 'projects' || top === 'cache') {
    return path.join(root, fdeName, rel);
  }
  return path.join(root, fdeName, 'home', rel);
}

/**
 * 纯函数：由 DB desired state 渲染该 FDE 全部平台文件（不含 manifest）。
 * P5：项目级物化（.gitignore / .erix/ports.json / .erix/AGENTS.md）整体退役——平台文件只落家目录
 * 骨架 + FDE 级 ports.json；旧项目脚手架靠 stale 清理（manifest 机制）自然移除。
 * @returns { files: [{ containerPath, hostPath, content, mode }] }
 */
export function buildFilePlan({ fdeName, baseDomain, llmBaseUrl, allocations, observedPorts, root, generation }) {
  const files = [];
  const add = (containerPath, content, mode = FILE_MODE) => {
    files.push({ containerPath, hostPath: hostPathFor(root, fdeName, containerPath), content, mode });
  };

  add(`${CONTAINER_HOME}/AGENTS.md`, renderHomeAgentsMd({ fdeName }));
  add(`${CONTAINER_HOME}/bin/github-pinproxy.py`, GITHUB_PINPROXY_SCRIPT);
  add(`${CONTAINER_HOME}/.erix/config.json`, renderConfigJson({ llmBaseUrl }));
  add(`${CONTAINER_HOME}/.erix/mcp.json`, renderMcpJson());
  add(`${CONTAINER_HOME}/.erix/ports.json`, renderPortsJson({ fdeName, allocations, observedPorts, generation }));
  return files;
}

// ---------------------------------------------------------------------------
// 落盘（原子写 + 权限 + 属主 + 幂等 + manifest 提交点 + 删除清理）
// ---------------------------------------------------------------------------

/**
 * 创建 materializer（root/uid/gid 可注入，供单测隔离；生产 root=0, uid/gid=1000）。
 */
export function createMaterializer({ root, uid = 1000, gid = 1000, log = console }) {
  if (!root) throw new Error('materializer root is required');

  function ensureWorkspaceDirs(files) {
    // 顶层 userspace root：0755 root:root（仅 portal 可写，user-space §6.2）。
    ensureDirSafe(root, root, { mode: 0o755, uid: null, gid: null, log });
    // 逐文件父目录：<root>/<fde> 及以下工作区目录传 2770（落盘 0770，见 WORKSPACE_DIR_MODE 注释），.erix 0750，属主 erix(1000)。
    const seen = new Set();
    for (const f of files) {
      const dir = path.dirname(f.hostPath);
      const rel = path.relative(path.resolve(root), path.resolve(dir));
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      let acc = path.resolve(root);
      for (const seg of rel.split(path.sep)) {
        acc = path.join(acc, seg);
        if (seen.has(acc)) continue;
        seen.add(acc);
        const mode = seg === '.erix' ? ERIX_DIR_MODE : WORKSPACE_DIR_MODE;
        ensureDirSafe(root, acc, { mode, uid, gid, log });
      }
    }
  }

  /**
   * 渲染 + 落盘该 FDE 全部平台文件 + manifest（提交点）。
   * 返回 manifest 内容与最终 generation（供测试断言）。
   */
  async function materialize({ fdeName, baseDomain, llmBaseUrl, allocations, observedPorts, generation, prevManifest, materializedAt = new Date() }) {
    const rootReal = path.resolve(root);
    const prevFiles = (prevManifest && prevManifest.files) || {};

    const files = buildFilePlan({ fdeName, baseDomain, llmBaseUrl, allocations, observedPorts, root: rootReal, generation });

    ensureWorkspaceDirs(files);

    // 3) 逐文件原子写（内容不变则跳过，user-space §8.2）；记录最终 entries。
    // F6：用 lstat 判断（不跟随 symlink）——即使同内容，目标为 symlink 也强制走 atomicWriteFile，
    //    由 assertSafePath 拒绝（materialize_path_tampered），绝不静默保留 symlink。
    const entries = {};
    let contentChanged = false;
    for (const f of files) {
      const prev = prevFiles[f.containerPath];
      const newSha = sha256(f.content);
      let current = null;
      let isSymlink = false;
      try {
        const st = fs.lstatSync(f.hostPath);
        if (st.isSymbolicLink()) isSymlink = true;
        else current = readFileIfExists(f.hostPath);
      } catch {
        current = null;
      }
      const changed = isSymlink || current !== f.content;
      if (changed) contentChanged = true;
      const revision = changed ? (prev?.revision ?? 0) + 1 : (prev?.revision ?? 0);
      if (changed) {
        atomicWriteFile(f.hostPath, f.content, { mode: f.mode, root: rootReal });
      }
      entries[f.containerPath] = { sha256: newSha, revision };
    }

    // M2：stale-only 变更也算「变更」——本次实际会删除的 stale 文件数 > 0 时，materialized_at 必须更新。
    // 预扫描（不实际删除），保证「先备好新 manifest 再删除」的提交点顺序不被打乱。
    const desiredPaths = new Set(Object.keys(entries));
    const staleScan = collectStaleFiles(prevFiles, desiredPaths, rootReal, fdeName);
    const anyChanged = contentChanged || staleScan.candidates.length > 0;

    // F8：内容未变（且无 stale 删除）时沿用旧 manifest 的 materialized_at，保证同快照字节级相同（幂等）。
    const effectiveMaterializedAt = (!anyChanged && prevManifest?.materialized_at)
      ? prevManifest.materialized_at
      : materializedAt;

    // 4) 提交点（F5）：新 manifest 先写 tmp（不 rename）→ 删除 stale → 最后 rename manifest。
    //    先备好新 manifest 再删除，避免「删了 stale 才发现 manifest 写失败」破坏旧版本。
    const manifestPath = path.join(rootReal, fdeName, 'home', '.erix', 'manifest.json');
    const manifestContent = renderManifest({ fdeName, generation, entries, materializedAt: effectiveMaterializedAt });
    if (readFileIfExists(manifestPath) !== manifestContent) {
      const tmp = writeTempFile(manifestPath, manifestContent, { mode: MANIFEST_MODE, root: rootReal });
      try {
        removeStaleFiles(prevFiles, desiredPaths, rootReal, fdeName, log);
        // L5：commitTempFile 返回 false（rename 已提交但目录 fsync 失败）时按失败处理，不标记发布成功。
        if (!commitTempFile(tmp, manifestPath, { root: rootReal })) {
          throw new Error(`fsync directory failed after manifest rename: ${manifestPath}`);
        }
      } catch (err) {
        try {
          fs.unlinkSync(tmp);
        } catch {}
        throw err;
      }
    } else {
      removeStaleFiles(prevFiles, desiredPaths, rootReal, fdeName, log);
    }

    return { generation, manifest: manifestContent, files: entries };
  }

  return { materialize, ensureWorkspaceDirs };
}

/**
 * 平台管理路径的精确判定（不用「后缀猜」）：只认平台自己会生成的路径——
 * home/.erix 目录、home/AGENTS.md（精确）、projects/<project>/.gitignore（恰好在项目根）、
 * projects/<project>/.erix/*。用户自建的嵌套 .gitignore/AGENTS.md（如 projects/<project>/<repo>/.gitignore）不在此列。
 *
 * 导出理由（工单 feat-261012-01）：`~/AGENTS.md` 自 #257/#258 起是平台约束的**单一真相**，
 * 「它算平台文件」这条判定必须直接钉住（`portal/test/materializer.test.js`）——走行为面只能证伪
 * 反面（用户嵌套同名文件存活），正面分支（rel === 'AGENTS.md'）因为 AGENTS.md 恒在 desired plan 里
 * 而无法从 stale 清理路径跑到。
 */
export function isPlatformManagedPath(containerPath) {
  if (typeof containerPath !== 'string' || !containerPath.startsWith(`${CONTAINER_HOME}/`)) return false;
  const rel = containerPath.slice(CONTAINER_HOME.length + 1);
  if (rel === 'AGENTS.md') return true;
  if (rel === 'bin/github-pinproxy.py') return true;
  if (rel.startsWith('.erix/')) return true;
  if (!rel.startsWith('projects/')) return false;
  const parts = rel.split('/');
  // projects/<project>/.gitignore（项目根，不含再往下的嵌套 repo 路径）
  if (parts.length === 3 && parts[2] === '.gitignore') return true;
  // projects/<project>/.erix/<file>
  if (parts.length === 4 && parts[2] === '.erix') return true;
  return false;
}

/**
 * 预扫描上一版 manifest 中需要删除的 stale 文件（不实际删除）。
 * 返回 { candidates: [{containerPath, hostPath}], skipped: [{containerPath, message}] }。
 * 与 removeStaleFiles 共用同一判定，保证「预判将被删」与「实际删除」一致。
 */
function collectStaleFiles(prevFiles, desiredContainerPaths, root, fdeName) {
  const rootReal = path.resolve(root);
  const fdeRoot = path.resolve(rootReal, fdeName);
  const candidates = [];
  const skipped = [];
  for (const containerPath of Object.keys(prevFiles)) {
    if (desiredContainerPaths.has(containerPath)) continue;
    try {
      // F1：删除路径来自磁盘 prevManifest，不可信——无论是否平台管理路径，先重新规范化 + assertSafePath，
      // 强制处于当前 FDE root 之内；任何逃逸 / 含 symlink 的可疑路径跳过并告警（不删、不 500）。
      const hostPath = path.resolve(hostPathFor(rootReal, fdeName, containerPath));
      const rel = path.relative(fdeRoot, hostPath);
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`stale path escapes FDE root: ${containerPath}`);
      }
      assertSafePath(fdeRoot, hostPath);
      // 只清理「平台管理路径集合」中、且已不在本次 desired plan 的文件；其余一律不动（不告警，属用户自建文件）。
      if (!isPlatformManagedPath(containerPath)) continue;
      if (fs.existsSync(hostPath)) candidates.push({ containerPath, hostPath });
    } catch (e) {
      skipped.push({ containerPath, message: e.message });
    }
  }
  return { candidates, skipped };
}

function removeStaleFiles(prevFiles, desiredContainerPaths, root, fdeName, log) {
  const { candidates, skipped } = collectStaleFiles(prevFiles, desiredContainerPaths, root, fdeName);
  for (const s of skipped) {
    log.warn?.(`[materializer] skip stale file ${s.containerPath}: ${s.message}`);
  }
  let deleted = 0;
  for (const { containerPath, hostPath } of candidates) {
    try {
      fs.unlinkSync(hostPath);
      deleted += 1;
    } catch (e) {
      log.warn?.(`[materializer] skip stale file ${containerPath}: ${e.message}`);
    }
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// materialize_outbox 消费（revision head / latest-wins / 失败退避）
// ---------------------------------------------------------------------------

const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
const MAX_ATTEMPTS = 5;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function readFdeDesiredState(pool, fdeId, config) {
  // issue #183：awaiting_credential 也是「活」状态（容器/工作区已在，只是 Git 凭据待补），
  // 平台文件应照常物化——凭据待补不应阻塞 ~/.erix（否则 agent 每次 run 都 ENOENT config.json）。
  // 仅排除 disabled（offboarding 后不再物化）。
  const user = await pool.query(
    `SELECT id, fde_name FROM users WHERE id = $1 AND status IN ('active', 'awaiting_credential')`,
    [fdeId],
  );
  if (user.rows.length === 0) return null;
  const fdeName = user.rows[0].fde_name;
  // P5：FDE 级单一 ports.json——allocations 平铺（不再按项目分组；projects 表不再参与物化）。
  const allocs = await pool.query(
    `SELECT id, scope, port, role, run_id, url, exposure, state
       FROM port_allocations WHERE fde_id = $1 AND state <> 'released' ORDER BY port`,
    [fdeId],
  );
  // #361：in_use 咨询位的数据源 = 新鲜观测（与门户列端点同口径 45s）。观测表不可用 ⇒ null 降级，
  // 分配告知照常——ports.json 的第一职责（告知分配）永不被观测面拖死。
  let observedPorts = null;
  try {
    const obs = await pool.query(
      `SELECT DISTINCT port FROM port_observations
        WHERE fde_id = $1 AND observed_at > now() - interval '${OBSERVATION_FRESHNESS_SECONDS} seconds'`,
      [fdeId],
    );
    observedPorts = obs.rows.map((r) => Number(r.port));
  } catch {
    // 观测表缺失/读失败：咨询位降级 null
  }
  return {
    fdeName,
    allocations: allocs.rows,
    observedPorts,
    llmBaseUrl: config.llmPublicBaseUrl,
    baseDomain: config.baseDomain,
  };
}

async function readPrevManifest(root, fdeName) {
  const p = path.join(root, fdeName, 'home', '.erix', 'manifest.json');
  const raw = readFileIfExists(p);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 领取 materialize_outbox head 行（revision==head），并丢弃 revision<head 的晚到旧事件。 */
async function claimMaterializeRows(pool, workerId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE materialize_outbox o
         SET state = 'published', published_at = now(), last_error = NULL
        FROM materialize_revisions r
       WHERE o.fde_id = r.fde_id AND o.revision < r.revision AND o.state = 'pending'`,
    );
    const rows = await client.query(
      `UPDATE materialize_outbox o
          SET state = 'processing', claimed_at = now(), lease_until = now() + interval '60 seconds', worker_id = $1
        WHERE o.state = 'pending'
          AND o.id IN (
            SELECT o2.id FROM materialize_outbox o2
            JOIN materialize_revisions r ON r.fde_id = o2.fde_id AND r.revision = o2.revision
            WHERE o2.state = 'pending'
            ORDER BY o2.created_at
            FOR UPDATE OF o2 SKIP LOCKED
            LIMIT 10
          )
        RETURNING o.id, o.fde_id, o.revision, o.op`,
      [workerId],
    );
    await client.query('COMMIT');
    return rows.rows;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function markMaterializePublished(pool, id) {
  await pool.query(
    `UPDATE materialize_outbox SET state = 'published', published_at = now(), last_error = NULL WHERE id = $1`,
    [id],
  );
}

async function markMaterializeFailed(pool, id, error) {
  const r = await pool.query(
    `UPDATE materialize_outbox SET attempts = attempts + 1, last_error = $2,
       state = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE 'pending' END,
       claimed_at = NULL, lease_until = NULL, worker_id = NULL
     WHERE id = $1 RETURNING state`,
    [id, String(error?.message ?? error), MAX_ATTEMPTS],
  );
  return r.rows[0]?.state;
}

/**
 * 消费一轮 materialize_outbox。返回 { processed, stale } 供测试/观测。
 */
export async function runMaterializerOnce(pool, config, { log = console, workerId = 'materializer-1' } = {}) {
  const mat = createMaterializer({
    root: config.userSpaceRoot,
    uid: config.fdeUid ?? 1000,
    gid: config.fdeGid ?? 1000,
    log,
  });
  const rows = await claimMaterializeRows(pool, workerId);
  let processed = 0;
  for (const row of rows) {
    try {
      const state = await readFdeDesiredState(pool, row.fde_id, config);
      if (!state) {
        await markMaterializePublished(pool, row.id);
        continue;
      }
      const prevManifest = await readPrevManifest(config.userSpaceRoot, state.fdeName);
      await mat.materialize({
        fdeName: state.fdeName,
        baseDomain: state.baseDomain,
        llmBaseUrl: state.llmBaseUrl,
        allocations: state.allocations,
        observedPorts: state.observedPorts,
        generation: Number(row.revision),
        prevManifest,
      });
      await markMaterializePublished(pool, row.id);
      processed += 1;
    } catch (err) {
      log.warn?.(`[materializer] failed fde=${row.fde_id}: ${err.message}`);
      await markMaterializeFailed(pool, row.id, err);
    }
  }
  return { processed, claimed: rows.length };
}

/** 崩溃恢复：回收 processing 且租约过期的孤儿行（materializer 启动/定时调用）。 */
export async function recoverMaterializeOrphans(pool) {
  await pool.query(
    `UPDATE materialize_outbox
        SET state = 'pending', attempts = attempts + 1, claimed_at = NULL, lease_until = NULL, worker_id = NULL
      WHERE state = 'processing' AND lease_until < now()`,
  );
}

/** 启动全量重物化所有 FDE（portal 重启后从 DB 重建缺失状态，user-space §8.1）。 */
export async function rebuildAllFdes(pool, config, { log = console } = {}) {
  const mat = createMaterializer({
    root: config.userSpaceRoot,
    uid: config.fdeUid ?? 1000,
    gid: config.fdeGid ?? 1000,
    log,
  });
  const users = await pool.query(
    // issue #183：与 readFdeDesiredState 同口径——awaiting_credential 照常物化，disabled 跳过。
    `SELECT id, fde_name FROM users WHERE fde_name IS NOT NULL AND status IN ('active', 'awaiting_credential')`,
  );
  for (const u of users.rows) {
    const state = await readFdeDesiredState(pool, u.id, config);
    if (!state) continue;
    const rev = await pool.query(`SELECT revision FROM materialize_revisions WHERE fde_id = $1`, [u.id]);
    const generation = Number(rev.rows[0]?.revision ?? 1);
    const prevManifest = await readPrevManifest(config.userSpaceRoot, state.fdeName);
    await mat.materialize({ ...state, generation, prevManifest });
  }
  return users.rows.length;
}

/** 启动一个常驻消费循环（由 cli serve 调用）。 */
export function startMaterializerLoop(pool, config, { log = console, workerId = 'materializer-1', onPause } = {}) {
  let stopped = false;
  let consecutiveFailures = 0;
  (async () => {
    // 启动全量重物化（幂等：内容不变不重写，user-space §8.1）。
    try {
      await rebuildAllFdes(pool, config, { log });
    } catch (err) {
      log.warn?.(`[materializer] startup rebuild failed: ${err.message}`);
    }
    while (!stopped) {
      try {
        await recoverMaterializeOrphans(pool);
        await runMaterializerOnce(pool, config, { log, workerId });
        consecutiveFailures = 0;
        await sleep(250);
      } catch (err) {
        consecutiveFailures += 1;
        log.warn?.(`[materializer] loop error: ${err.message}`);
        onPause?.('materializer', err);
        const backoff = BACKOFF_MS[Math.min(consecutiveFailures - 1, BACKOFF_MS.length - 1)];
        await sleep(backoff);
      }
    }
  })();
  return {
    stop() {
      stopped = true;
    },
  };
}
