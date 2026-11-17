# 技能包编写指南（skill authoring）

> 给**发布技能的人**（管理员）与**写技能代码的人**（含 agent）看。契约来源：
> [`capability-market.md`](capability-market.md) §3（包规范/校验）、[`mcp-integration.md`](mcp-integration.md) §4（配置槽、红色形状）。
> 本文只写「怎么写一个能被市场收下、能被模型正确调用」的包；发布/安装的产品面见前两份。

---

## 0. 先决定：skill 还是 MCP？

**默认是 skill。** 只有下面任意一条成立，才做成 MCP（上架时必须选一条理由，否则市场拒收）：

| 理由 | 判据 |
|---|---|
| `stateful` | 跨调用/跨 run 要保住东西：连接、会话、PTY、后台任务、游标 |
| `tool_surface_gt_12` | 工具数 > 12（技能上限 12，且每个工具每轮都付上下文） |
| `shared_quota` | 要被多个 FDE 共享同一份配额/限流 |
| `credential_boundary` | 凭据必须留在平台侧、且需要平台侧持有连接 |

**skill 的边界 = 一次函数调用**。任何要活过这次调用的东西（进程、连接、会话、缓存文件、后台任务）
都不属于包——`erix-ssh` 就是反面教材：它想当 server，做完就成了 MCP，最后冻成 draft
（`touwaka/data/skills/erix-ssh/SKILL.md`）。

---

## 1. 包结构

```
<slug>/
├── skill.mjs            # 必需：唯一入口（声明 tools + 导出同名执行函数）
├── SKILL.md             # 可选但强烈建议：给模型按需读的说明书
└── scripts/             # 可选：一组脚本（任意语言，见 §3）
    ├── extract.mjs
    └── ocr.py
    references/ assets/  # 可选：文档/模板等非执行文件
```

校验硬约束（发布时机器判，不过就 400）：

| 项 | 规则 | 拒绝码 |
|---|---|---|
| 根文件 | **只允许** `skill.mjs` 与 `SKILL.md` | `unexpected_root_file` |
| 子目录 | 只允许 `scripts/` `references/` `assets/`（可多层） | `unexpected_dir` |
| 子目录里的 `skill.mjs` | 禁止（不会被任何入口读到） | `entrypoint_in_subdir` |
| 文件数 / 单文件 / 总量 | ≤ 50 / ≤ 512 KiB / ≤ 2 MiB | `bytes` / `files` |
| 路径 | 相对、无 `..` 段、无反斜杠、≤200 字符 | `path` |
| `slug` | `^[a-z0-9][a-z0-9-]{0,63}$`，且**必须等于** `skill.id` | `skill_id_mismatch` |
| `tools` | 1..12 条；`name` 匹配 `^[a-z][a-z0-9_]{1,63}$` 且唯一；`description` ≥20 字符 | `tools_count` / `tool_name_*` / `tool_description_short` |
| `when_to_use` | 8..500 字符，**必填**（模型的路由信号） | `when_to_use` |

> 依赖：包里**不要**带 `node_modules`。需要依赖时技能自己在首次运行时装（容器有网），或者把纯 Node 实现
> 写在 `scripts/` 里（零依赖优先——上游 `bin/mcp.js` 就是手写客户端，不引 SDK）。

---

## 2. `skill.mjs` 契约

```js
export async function getSkillDefinition() {
  return {
    schema_version: 1,                       // 固定 1
    skill: { id: 'pdf-tools', entrypoint: 'skill.mjs' },   // id 必须等于 slug
    tools: [{
      name: 'pdf_extract',
      // ⚠ description 是模型唯一的路由信号：写「做什么 + 什么时候用」，别写「帮助处理 PDF」
      description: '抽取 PDF 的文本与表格。当用户要读、转换或检查 PDF 内容时使用。',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'PDF 文件路径（相对项目目录）' } },
        required: ['path'],
      },
    }],
  };
}

export async function pdf_extract({ path }) {   // 函数名必须与 tool.name 完全一致
  return '...';                                  // 返回字符串即可；长结果自己截断
}
```

三条最容易踩的：

1. **执行函数必须从 entrypoint 模块导出**。loader 逐个检查 `tools[].name` 是不是 entrypoint 的导出函数，
   缺一个就**整包被跳过**（`missingExecutors`）。多文件时必须 `export { x } from './scripts/x.mjs'`。
2. **参数是模型填的**，不是管理员配的。想给管理员/平台配的东西（端点、token）走配置槽（§4），不要塞进
   `inputSchema` 让模型去猜。
3. **`inputSchema` 写清楚**：每个属性都要 `description`（模型唯一的用法说明）。枚举用 `enum`。

---

## 3. 一组脚本（多文件 / 外部脚本）

**① 多文件模块（推荐）**

```js
// skill.mjs —— 只做声明 + 转出
export { pdf_extract } from './scripts/extract.mjs';
export { pdf_render } from './scripts/render.mjs';
export async function getSkillDefinition() { /* …声明两个 tool… */ }
```

**② 外部脚本（python / bash / node 都行）**

```js
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));   // ⚠ 唯一正确的自定位方式

export async function ocr({ image }) {
  const script = path.join(HERE, 'scripts', 'ocr.py');
  const out = await run('python3', [script, image]);          // 显式解释器：落盘没有可执行位
  return out.stdout;
}
```

**⚠ 三条硬事实**：

- **必须用 `import.meta.url` 定位包内文件**。loader 不 chdir、不把技能目录传给你；`process.cwd()` 是
  **用户的项目目录**（`runner/skills/github/skill.mjs:121` 就是这个形状）。
- **落盘文件是 0644，没有可执行位** ⇒ 不能 `./scripts/x.sh`，要 `bash scripts/x.sh` / `python3 …` / `node …`。
- 子进程要自己设 `timeout` 并在超时后 `kill`：技能是 **in-process**，没有 per-tool 超时，hang 住会挂整个 run。

---

## 4. 配置槽与密钥（P1 起可用）

需要「平台配的端点/凭据」时，**不要**让用户在页面上填，也**不要**写死在包里：

1. 发布时声明槽位（管理员填值，加密存平台）：

| 字段 | 规则 |
|---|---|
| `name` | `^[A-Z][A-Z0-9_]{0,63}$`（这就是注入名） |
| `kind` | `config`（URL 这类）\| `secret`（token 这类） |
| `inject` | skill 用 `context`；`secret` **不许**用 `context`（会交给技能代码） |
| `required` | 缺了就不许启用 |
| `description` | 给运维看的「这是什么」 |

2. 运行期从 **`context` 的第二参**取，**不要读 `process.env`**：

```js
export async function web_search(input, context) {
  const base = context?.secrets?.SEARXNG_URL ?? 'http://localhost:8080';   // 缺省值自留兜底
  const key  = context?.secrets?.SEARXNG_KEY;                              // 可能 undefined
  // …
}
```

为什么不让改 `process.env`：技能是 in-process `import()`，改 env 会**污染整个 worker**（同一 run 的其他工具
都看得见），还会被 delegation 子 run 继承，且 run 之间清不干净。

**保留名黑名单**（不允许做槽位名，防「参数把安全关键变量顶掉」）：`PATH` `HOME` `NODE_OPTIONS`
`LD_PRELOAD` `LD_LIBRARY_PATH` `PYTHONPATH` `HTTP(S)_PROXY` `NO_PROXY` `NODE_EXTRA_CA_CERTS`
`SSL_CERT_FILE` 以及 `ERIX_*` / `STATION_*` / `SKILL_*` / `MCP_*`。

---

## 5. 禁止形状（发布时硬拒：`capability_package_shape`）

| 形状 | 为什么 |
|---|---|
| `detached: true` | 自建常驻进程 ⇒ 孤儿、无生命周期管理 |
| 模块级 `setInterval(` / `setTimeout(` | 顶层长驻 ⇒ run 结束仍在跑 |
| `listen(` / `createServer(` | 监听端口 ⇒ 绕过 ingress，且没人回收 |
| `node-pty` / `pty.spawn` | PTY 会话属于形态②③ |
| 写包外持久目录（`~/.erix/`、`/var/`、`/srv/` 出现在写调用参数里） | 状态该由平台持有 |
| 声明常驻（`is_resident` / `resident: true`） | 见 `mcp-integration.md` §2 的形态表 |

需要以上任何一条 ⇒ 这个能力应该做成 **MCP**（并选一条准入理由）。

---

## 6. 执行环境事实（写代码前必须知道）

| 事实 | 含义 |
|---|---|
| 技能在 **worker 进程内** `import()` 执行 | 没有沙箱；一个未捕获的进程级崩溃会打死这次 run |
| **一 run 一 worker 进程** | 模块级变量只在本次 run 内有效；跨 run 必然丢 |
| 执行身份 `erix-worker`(1002):`erix`(1000) | 家目录可读、项目目录可写；不要指望 root |
| `cwd` = 用户的项目目录 | 相对路径写文件会落进用户项目，**要落中间文件请用 `/tmp/`** |
| 没有 per-tool 超时 | 自己给子进程设 timeout；同步长循环会卡住整轮 |
| 每个工具 schema **每轮都发**（≈200 token） | 工具越少越好；30 个动作请合成 1 个工具 + `action` 参数 |
| 审查 run（review-only）与 delegation 子 run **不装技能** | 别把关键能力做成「只有技能有」 |

---

## 7. `SKILL.md` 怎么写

模型只在需要时才 `readFile` 它（路径由平台在提示词索引段里给出），所以：

- **frontmatter**：`name`（= slug）、`description`（一句话，写「做什么 + 何时用」）。
- 正文写**怎么用、边界、坑**：输入从哪来、输出长什么样、失败怎么判、不要做什么。
- 不要把整份 API 文档抄进来（按需读也要付 token）；不要写「本技能很强大」这类话。
- 与工具 `description` 的分工：**description 决定「要不要调」，SKILL.md 决定「怎么调」**。

---

## 8. 发布前自测（5 分钟）

在 FDE 容器里（或任何装了 `erix-agent` 的目录）：

```bash
# 1) 结构自检：入口能加载、tools 合法
node -e "import('./skill.mjs').then(async m=>{
  const d = await m.getSkillDefinition();
  console.log(d.schema_version, d.skill, d.tools.map(t=>t.name));
  for (const t of d.tools) if (typeof m[t.name] !== 'function') throw new Error('缺执行函数: '+t.name);
})"

# 2) 真跑一次执行体（用真实参数，别用假数据糊过去）
node -e "import('./skill.mjs').then(m=>m.pdf_extract({path:'/tmp/sample.pdf'})).then(r=>console.log(r.slice(0,200)))"

# 3) 让 loader 真的装配一次（与生产同一条路径）
node -e "import('erix-agent/tools').then(async m=>{
  const b = await m.buildSkillTools({home:process.env.HOME, cwd:process.cwd(), bundledDir:null, builtinNames:[]});
  console.log('tools:', b.tools.map(t=>t.name), 'errors:', b.errors);
})"
```

发布 checklist：

- [ ] `skill.id` == slug（目录名）
- [ ] 每个 tool 的 `description` 写了「何时用」，≥20 字符
- [ ] 每个 `inputSchema` 的属性都有 `description`
- [ ] 脚本用 `import.meta.url` 定位；子进程设了 timeout
- [ ] 没有 §5 的禁止形状
- [ ] `when_to_use` 写清「什么情况下该用」而不是「这是什么」
- [ ] 本地真跑过一次执行体，不是只看它 import 成功

---

## 9. 版本与升级

- 包内容按 `(条目, 版本)` **不可变**存库；改版 = 新版本行 + `items.version` 前移。
- 已装旧版本的 FDE **不会自动升级**：用户点「重装」才落新版（平台不对账磁盘，见 `capability-market.md` §4）。
- 卸载只删 `<slug>/` 目录；DB 里的包留档，所以重装不需要重新上传。

---

## 10. 反例清单（评审时最常被打回的三种）

1. **把 server 塞进 skill**：自己起常驻进程、自己存会话文件、自己维护连接池 ⇒ 应该做 MCP（`erix-ssh`）。
2. **工具爆炸**：把一个 API 的 20 个端点做成 20 个工具 ⇒ 合成 1 个工具 + `action`/`resource` 参数。
3. **description 写「帮助处理 X」**：模型不知道何时该调 ⇒ 写「当用户要 A、B、C 时使用」。
