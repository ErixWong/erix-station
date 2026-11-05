# 边缘路由：用户入口 / 管理台入口（issue #450，feat-261105-01）

> 本文是「两个入口 + 两个 host」的单一事实来源：哪个入口能打到哪些 API、deny 在哪里生效、
> 证书怎么装载、改端口要动哪几处。配置生成侧在 `portal/src/routes.js`（`routes.yml`）与
> `portal/src/tlsassets.js`（`tls.yml`），静态侧在 `deploy/traefik/traefik.yml`。
>
> 相关：#450（决策记录见 issue 最后一条评论）、#456（证书生命周期，**不在**本单）、
> #233（防火墙，未落地）、#234（CSRF 同源门）、env.md §2/§5/§10。

## 1. 两个入口

| 入口（entrypoint） | 端口 | host | 用途 |
|---|---|---|---|
| `web`（用户面，`TRAEFIK_ENTRYPOINT` 默认值） | `TRAEFIK_WEB_PORT`（dev 8090 / 生产 80） | `PORTAL_HOST` = `station.<伞域>` + 全部预览 host `<fde>-p-<port>.<伞域>` + LLM host | 用户面 SPA、用户 API、全部预览、LLM 注入 |
| `websecure`（用户面 TLS，**今天没有任何 router 挂它**） | `TRAEFIK_WEBSECURE_PORT`（dev 8443） | — | 预留（8443 今天全 404，不是回归） |
| `adminsecure`（管理台） | **写死 9443**（见 §4） | `adminHost` = `ADMIN_PUBLIC_HOST` 或 `admin.<伞域>`（现网 `admin.fde.erix.vip`） | 管理台 SPA（同一份 bundle，hash 路由）+ 管理 API + 登录相关 |

`admin.<伞域>` 被既有泛解析 `*.fde.erix.vip` 覆盖 ⇒ **零 DNS 动作**。

## 2. 每个入口只够得到自己那套 API（隔离矩阵）

管理台入口（`adminsecure`，带 `tls: {}`）只有三条 router：

| router | rule | priority | 说明 |
|---|---|---|---|
| `admin-api` | `Host(admin) && PathPrefix(/api/admin)` | 200 | 管理 API |
| `admin-auth` | `Host(admin) && (PathPrefix(/api/auth) \|\| PathPrefix(/api/me))` | 200 | 登录 / 登出 / 当前用户 / 改密 |
| `admin-spa` | `Host(admin)` | 100 | SPA 静态与前端路由（catch-all） |

用户入口（`web`）上除原有 `portal`（100）/ `internal`（200）/ 预览（200）之外，多一条 deny：

| router | rule | priority | 指向 |
|---|---|---|---|
| `admin-deny-user` | `Host(portal) && PathPrefix(/api/admin)` | 300 | `noop@internal` + `admin-deny` |

管理台入口上多一条「其余 API 一律 deny」：

| router | rule | priority | 指向 |
|---|---|---|---|
| `admin-deny-api` | `Host(admin) && PathPrefix(/api) && !PathPrefix(/api/admin) && !PathPrefix(/api/auth) && !PathPrefix(/api/me)` | 300 | `noop@internal` + `admin-deny` |

**优先级口径**：`300 (deny) > 200 (internal / 预览 / 管理 API) > 100 (portal / 管理台 SPA)`。
`internal` 的规则只匹配 `/api/internal`、与 `/api/admin` 路径不交，本可以取 150；但那样「deny 生效」
就依赖「路径永不重叠」这条隐式前提（改天给 internal 扩前缀就会静默失效）。300 把不变量写成
「deny 永远压过一切本地路由」，不依赖路径互斥推理。

**预览路由只挂用户入口**（`entryPoints: [<TRAEFIK_ENTRYPOINT>]`）：管理台 host 够不到任何人的预览。
单测钉住这一点（`portal/test/routes.test.js` 的「预览路由只挂原入口」）。

实际效果（2026-11-05 真机实测，矩阵见 §7）：

| 请求 | 用户入口 | 管理台入口 |
|---|---|---|
| `GET /`（用户 host） | 200（SPA） | **404**（该 host 不在管理台入口上） |
| `GET /api/sessions`（用户 host） | 200（到 portal） | — |
| `GET /api/admin/*`（用户 host） | **404 deny**（不到 portal） | — |
| `GET /`（管理 host） | **404**（该 host 不在用户入口上） | 200（SPA） |
| `GET /api/admin/*`（管理 host） | — | 200（到 portal） |
| `GET /api/auth/*`、`/api/me`（管理 host） | — | 200（到 portal） |
| `GET /api/sessions`、`/api/internal/*`（管理 host） | — | **404 deny**（不到 portal） |
| `GET /`（预览 host） | 200/403（预览链） | **404**（预览不挂管理台入口） |

> `PathPrefix` 是**字符串前缀**语义（实测：`/api/adminx` 也落在 `/api/admin` 的判定里）。真实 API 面
> 没有 `admin*` 前缀但非 `/api/admin` 的端点，因此不产生实际影响；若将来新增，改规则时要注意这一点。

## 3. deny 的实现（为什么是 ipAllowList + rejectStatusCode: 404）

`admin-deny` 中间件：

```yaml
admin-deny:
  ipAllowList:
    sourceRange: ["192.0.2.0/24"]   # RFC 5737 TEST-NET-1：文档专用、不可路由、永不匹配真实客户端 ⇒ 恒拒
    rejectStatusCode: 404
```

- **为什么不是 `headers.customResponseCode`**：Traefik v3.7 没有「直接返状态码」的中间件
  （实测 `strings traefik | grep -i customresponse` 只有 `CustomResponseHeaders`）。`headers` 只能改响应头。
- **为什么不是空 `sourceRange`**：实测 Traefik 会打
  `ERR error="sourceRange is empty, IPAllowLister not created" entryPointName=web routerName=deny-a@file`
  ——中间件**根本没被创建**，路由回落 catch-all → **静默放行**。这条 ERR 也是
  「`ADMIN_IP_ALLOWLIST` 为空时生成器**根本不输出** `admin-allow` 中间件」的直接原因（见 §6）。
- **service 指向 `noop@internal`**（Traefik 内建服务）：deny 路由永远不会真的把请求代理出去。万一
  `admin-deny` 中间件因故没生效，得到的是 Traefik 自己的 `418`，**不是**把请求送到 portal —— fail-closed。
- **状态码 404**（不是 403/401）：不告诉探测者「这里有个受保护的东西」。响应体是 Traefik 的
  `Not Found`（deny 命中）或 `404 page not found`（无路由命中），两者与后端响应体可区分（§7 的判据之一）。

## 4. 端口：为什么写死 9443，以及「改端口要动哪两处」

**实测结论（2026-11-05，`traefik:v3.7.13` + 本仓静态文件 + 一次性容器）**：静态配置里的
`${VAR:default}` **不会被插值**，`TRAEFIK_ENTRYPOINTS_*_ADDRESS` 这类 env 静态覆盖在
`--configFile` 下同样被忽略：

```
# address: "${TRAEFIK_ADMIN_PORT:19443}"，env TRAEFIK_ADMIN_PORT=19443
ERR Command error error="command traefik error: error while building entryPoint adminsecure:
    building listener: error opening listener: listen tcp: lookup tcp/19443}: unknown port"
# address: "${TRAEFIK_ADMIN_PORT}"，env TRAEFIK_ADMIN_PORT=19443
ERR ... listen tcp: address ${TRAEFIK_ADMIN_PORT}: missing port in address
# 文件里不写 adminsecure、只给 TRAEFIK_ENTRYPOINTS_ADMINSECURE_ADDRESS=:19443
/api/entrypoints → [('traefik', ':8080'), ('web', ':8090'), ('websecure', ':8443')]   # 新入口不存在
```

⇒ 地址写死 `:9443`。由此产生的**两处耦合**：

1. `deploy/traefik/traefik.yml` 的 `adminsecure.address: ":9443"`（Traefik 真正 listen 的端口）；
2. `deploy/.env` 的 `TRAEFIK_ADMIN_PORT=9443`（compose 注入 portal，用来推导管理台 URL / 展示）。

**为什么没有 `ports:` 映射**：`station-edge` 是 `network_mode: host`，宿主端口 = 容器端口；host 网络下
Docker 会 `WARNING: Published ports are discarded when using host network mode` 把映射静默丢掉
（compose 连警告都不给），写上去只是一条假声明。所以「宿主端口跟着部署面走」在 host 网络下不成立，
只能靠**两处字面量一致**。

**一致性有机器判据**：`portal/test/deploy-env-defaults.test.js` 读静态文件的 `adminsecure.address`、
compose 的插值默认值、`loadConfig({}).adminPort` 三者逐字比对，任一处单独改动都会红。

**改端口 = 改两处 + 重启边缘**（静态配置只在启动时读）：改完 `deploy/traefik/traefik.yml` 与
`deploy/.env` 后 `docker compose up -d --force-recreate station-edge`（重建 portal 以拿到新 env）。
管理台**不提供**端口写入口（Traefik entryPoint 地址只能在静态配置里，写错的代价是整个边缘起不来 =
用户面 + 全部预览 + 管理台一起下线；真要 UI 化，正解是另起一个只管管理台、静态配置由 portal 生成的
边缘实例）。

## 5. 证书装载面（D5）

```
<TRAEFIK_DYNAMIC_DIR_HOST>/            # 宿主 ./deploy/traefik/dynamic，两容器同路径挂载
├── routes.yml          # portal routes.js 全量重建（禁手改）
├── llm-routes.yml      # LLM 段 + per-FDE key 明文，mode 600（portal 全量重建）
├── tls.yml             # ← 本单新增：只声明证书装载面（portal tlsassets 物化，禁手改）
└── certs/
    ├── tls.crt         # 运维手工放置（fullchain，644）
    └── tls.key         # 运维手工放置（私钥，600）
```

- **三个文件互不重叠、各自独立物化**：`tls.yml` 里没有 `http:` 段，`routes.yml` 里没有任何
  `certFile`。任一份坏掉都不该连坐另外两份（这正是「两文件齐才生成 tls.yml」的理由：一份指向不存在
  文件的 `tls.yml` 会让 file provider 整个目录加载失败，连带丢全部路由）。
- **生成条件**：`certs/tls.crt` 与 `certs/tls.key` 都存在**且非空** ⇒ 写 `tls.yml`；
  任一缺失 / 空文件 / 不是普通文件 / 读失败 ⇒ **删除**已存在的 `tls.yml`（幂等，ENOENT 视为成功）。
- **生成物内容**：`tls.stores.default.defaultCertificate` + `tls.certificates`（两条都写：前者是
  SNI 不匹配时的兜底证书，只有后者时访问未覆盖的名字会拿到 Traefik 内建自签证书）。
  私钥**只以路径形式**出现（正文/日志/DB 里都没有它）。
- **reload 把手**：生成物带一行随证书变化的注释
  `# fingerprint=sha256:<证书字节哈希> keymtime=<私钥 mtimeMs>`。Traefik 的 file provider 是**文件驱动**
  的：只替换 `certs/*` 而不动 `tls.yml` 不一定触发 reload，改这一行必然触发。#456（证书上传/校验/回滚）
  换证时重写 `tls.yml` 即可，**不需要重启边缘**（实测：删/放证书后服务端证书在数秒内切换，§7）。
- **失败隔离**：证书面的任何失败（无证书、不可读、写不进）都**不抛**、不影响 `routes.yml` /
  `llm-routes.yml` 的发布——只降级成「管理台入口用 Traefik 内建自签证书」。用户面与全部预览的
  可用性高于管理台的证书质量。
- **首次证书的鸡生蛋问题**：portal 容器启动即物化一次 `tls.yml`，但**证书是运维手工放的** ⇒
  第一次部署时 `certs/` 是空的，管理台入口会以 Traefik 内建自签证书应答（浏览器告警、`__Host-`
  cookie 在 `COOKIE_PROFILE=prod` 下仍然可用，因为浏览器把它当作不可信站点但 Secure 属性成立）。
  放好证书后**不需要重启**：`tls.yml` 会在下一次路由物化（启动/任一路由变更）时生成，或按 #456 的
  上传面主动重写；最省事的做法是放好证书后重建一次 portal（`docker compose up -d station-portal`）。
- **证书必须覆盖 `admin.<伞域>`**（#456 的硬校验口径）：不覆盖时浏览器报证书名不匹配，
  与「管理台有自己的 SSL 证书」这条需求直接冲突。

## 6. 来源白名单（`ADMIN_IP_ALLOWLIST`，D4）

- 逗号分隔 CIDR；**空 = 不挂 `ipAllowList` = 放行全部**（= 今天的现状，默认不破坏现网）。
- 非空 ⇒ 三条管理台 router 都挂 `admin-allow`（`ipAllowList.sourceRange` 逐项等于 env 解析结果）。
- 单个条目非法 ⇒ 丢弃该条 + warn；全部非法 ⇒ 额外 warn「管理台入口不再受来源限制」（安全含义不能靠人推）。
- **为什么空清单时生成器根本不输出中间件**：空 `sourceRange` 会被 Traefik 拒建（见 §3 的 ERR 原文），
  而「挂一个不存在的中间件」比不挂更危险（router 会被禁用）。所以「空 = 不出现」，不是「空 = `sourceRange: []`」。
- 背景（#450 §D3）：本机 `*.fde.erix.vip → 100.100.0.3`（Tailscale），平台只在 tailnet 内可达；
  但 **FDE 容器能经桥网关访问宿主任意监听端口**（#233 防火墙至今未落地）⇒ 新端口对容器可达。
  这条 env 是运维**当场能收紧**的旋钮，不是「已经安全了」的声明。

## 7. 真机验证记录（2026-11-05，一次性容器；现网容器一个没动）

方法：`traefik:v3.7.13` + **本仓真实静态文件** + 用真实生成器产出的 `routes.yml`/`tls.yml`；
后端用 nginx（自定义 conf：所有路径 `return 200 "BACKEND-HIT <path>"`，`access_log /dev/stdout`）
⇒ **每个请求在后端日志里恰好一行**，「deny 没产生后端请求」用 access log 判定（不是猜状态码）。

- **listen 端口**：从同网另一容器直连 edge 容器的 `9443`（不经 docker 端口映射）握手成功 ⇒
  `adminsecure` 确实 listen 在 9443；`8090` 同法可证。
- **证书装载**：放入自签证书（CN=`admin.fde.erix.vip`）后 `openssl s_client -servername` 读到
  `subject=CN = admin.fde.erix.vip`（不是 `TRAEFIK DEFAULT CERT`）⇒ `tls.yml` 生效。
  抽掉 `certs/tls.key` ⇒ `tls.yml` 被删 ⇒ **不重启**服务端证书回落 `CN = TRAEFIK DEFAULT CERT`；
  放回私钥 ⇒ 又变回 `CN = admin.fde.erix.vip`（全过程 routes 仍正常应答）。
- **隔离矩阵**（状态码 + 后端命中数一致）：用户入口 `/api/admin/users` → 404 + **0** 次后端命中；
  管理台入口 `/api/sessions`、`/api/internal/x` → 404 + **0** 次后端命中；管理台入口 `/`、
  `/api/admin/users`、`/api/auth/login`、`/api/me` → 200 + 各有 1 次后端命中。
- **来源白名单**：`ADMIN_IP_ALLOWLIST=10.0.0.0/8,100.64.0.0/10`（客户端不在内）⇒ 管理台三条路由全 403，
  用户面 200 不变，管理台请求 0 次后端命中；改成 `172.17.0.0/16`（客户端在内）⇒ 管理台 200、
  `/api/sessions` 仍 404（deny 不受白名单影响）。
- 已知噪声：删除 `tls.yml` 时 Traefik 会打一行
  `ERR Error occurred during watcher callback ... tls.yml: no such file or directory`，随后自愈
  （实测删除后 `routes.yml` 的路由仍正常应答）。这是 file provider 对「文件消失」事件的正常反应。

## 8. 排查手册

| 症状 | 大概率原因 |
|---|---|
| 管理台入口连接被拒 | 边缘没重启（静态配置只在启动时读）；或改端口只改了一处（§4） |
| 管理台入口 404（连 SPA 都 404） | `routes.yml` 没生成管理台段（`adminHost` 缺失）；或 `admin-deny-api` 规则写错（`/api` 前缀盖住了 `/`） |
| 管理台入口证书名不匹配 | 放的证书没覆盖 `admin.<伞域>`；或 `certs/tls.key` 缺失导致 `tls.yml` 被删（回落内建自签） |
| 管理台入口 403 | `ADMIN_IP_ALLOWLIST` 非空且当前来源不在名单里（`403 Forbidden` 来自 `admin-allow`） |
| 管理台入口 404 但用户入口正常 | 正常（deny 生效）：该 host 在用户入口上不存在、或该 API 不在管理台白名单里 |
| 用户面 `/api/admin/*` 变 404 | 正常（#450 之后就是这样）；要调管理 API 走管理台 host:9443 |
