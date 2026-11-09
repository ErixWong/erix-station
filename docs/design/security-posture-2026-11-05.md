# 安全现状与风险清单（2026-11-05 实测）

> **本文是什么**：一次**以实测为准**的安全面盘点——容器之间/容器到宿主到底谁够得到谁、谁能改 Traefik 规则、
> 证书私钥的读写路径、以及每条风险的**触发路径 / 影响 / 现有缓解 / 建议方案**。
> **本文不是什么**：不是规格（规格在 [`fde-platform.md`](fde-platform.md) / [`topology.md`](topology.md)），
> 也不是承诺（每条建议都标了成本与是否已定）。
>
> **方法**：所有「通/不通」都是**在真机容器里打真端口**得出的（命令见 §7），不是读代码推断。
> **边界**：本机无免密 root ⇒ **iptables 规则没有直接读**，「为什么不通」是由连通性 + Docker 已知行为反推的；
> IPv6 面、宿主机上其它监听服务、Tailscale ACL 侧未逐一枚举（见 §6）。

---

## 1. 结论摘要（一页）

| 问题 | 答案 |
|---|---|
| FDE 容器能到 Traefik 吗？ | **能**（经宿主 bridge 网关 / 宿主任意 IP），**这是设计使然**（预览 forwardAuth、agentd、LLM 网关都走它） |
| FDE 容器能**直连** portal / DB / socket-proxy / LiteLLM 吗？ | **不能**（跨 bridge 转发被 Docker 的 FORWARD 规则挡住，实测 TIMEOUT） |
| FDE 容器之间能互通吗？ | **不能**（各自独立 `/29`，实测 TIMEOUT） |
| FDE 容器能碰宿主上绑 `0.0.0.0` 的服务吗？ | **能** ⚠️（Portainer 9000、sshd 2222 实测 OPEN）——`#233` 防火墙未落地 |
| FDE 容器能改 Traefik 规则吗？ | **不能**（无 dynamic 目录挂载、无 docker socket、无写 API） |
| 那「规则被篡改」的真实入口是什么？ | **portal 被攻破**（它 root + RW 挂载 dynamic）或**宿主 shell** |
| 被篡改后最坏能怎样？ | 把宿主 2222/9000/4100 暴露到公网域名；劫持别人的预览流量；**读走 TLS 私钥**（见 R4） |
| 已经做对的部分 | `internal` API 用 **per-container bearer token**；`deploy/fde-proxy` 对建容器是**字段级 allowlist**；Traefik 对 dynamic 目录只读；**portal 的读路径不接触 TLS 私钥字节**（#462 / S4 已落地，见 §2.5） |

---

## 2. 现状：网络与身份

### 2.1 拓扑（实测，2026-11-05）

```
                     ┌─────────────── 宿主（Linux, tailscale0=100.100.0.3, eno1=192.168.20.147）
                     │
  station-edge ──────┤ network_mode: host   ← 与宿主同一网络命名空间（这是关键：它能连宿主任何 127.0.0.1 端口）
  (traefik v3.7.13)  │ entrypoints: web :8090 / websecure :8443 / adminsecure :9443
                     │
  station-portal ────┤ station_backend 172.32.0.5:8080（宿主只 publish 到 127.0.0.1:18080）
  station-db ────────┤ station_backend 172.32.0.2:5432
  station-litellm ───┤ station_backend 172.32.0.3:4000
  fde-proxy ─────────┤ station_backend 172.32.0.4:2375（自研字段级 allowlist，见 §2.4）
                     │
  fde-eric ──────────┤ fde-eric 10.200.0.0/29   容器 10.200.0.2   （网关 10.200.0.1 = 宿主）
  fde-tetris ────────┤ fde-tetris 10.200.0.8/29 容器 10.200.0.10
  fde-todo ──────────┤ fde-todo 10.200.0.24/29  容器 10.200.0.26
  fde-blind ─────────┤ fde-blind 10.200.0.32/29 容器 10.200.0.34
  fde-acc019 ────────┤ fde-acc019 10.200.0.56/29 容器 10.200.0.58
                     │
                     └── 每个 FDE 一个**独立 bridge 网络**（`fde-<name>`），网段从 `10.200.0.0/16`（溢出到 `10.201.0.0/16`）
                         的号池里切 **/29**；**后端地址固定取 `.2`**（topology §3/§4-L2）
```

### 2.2 可达性矩阵（实测，从 `fde-eric` 容器内发起）

| 目标 | 结果 | 判据/说明 |
|---|---|---|
| Traefik `10.200.0.1:8090` + `Host: station.<伞域>` | **200**（`/healthz`）/ **401**（`/api/me`） | 真的到 portal 了 |
| Traefik `10.200.0.1:9443` + `Host: admin.<伞域>` | **200**（`/api/site`）/ **401**（`/api/admin/users`） | 管理台入口对容器可达（R2） |
| Traefik `10.200.0.1:8090` `/api/admin/*` | **404** | #450 的边缘 deny 对容器同样生效 |
| Traefik `10.200.0.1:9443` `/api/internal/claim` | **404** | 管理台入口的 deny-api 覆盖（只放 admin/auth/me/site） |
| Traefik `10.200.0.1:8090` `/api/internal/claim`（无 token） | **401** | **过了 `internal-allow` 的 ipAllowList**（它放行的正是各 FDE 的 `/29`）⇒ 到 portal，缺 token |
| portal 容器 `172.32.0.5:8080` | **TIMEOUT** | 跨 bridge，FORWARD 无规则 |
| `station-db 172.32.0.2:5432` / `litellm 172.32.0.3:4000` / `fde-proxy 172.32.0.4:2375` | **TIMEOUT** | 同上 |
| 另一个 FDE 容器 `10.200.0.34` / `10.200.0.26` | **TIMEOUT** | 各自独立 bridge |
| 宿主 `10.200.0.1:18080`（portal 的 publish，绑 127.0.0.1） | **ECONNREFUSED** | 只绑回环 |
| 宿主 `10.200.0.1:4100`（LiteLLM，绑 127.0.0.1） | **ECONNREFUSED** | 同上 |
| 宿主 `10.200.0.1:3306`（MariaDB，绑 127.0.0.1） | **ECONNREFUSED** | 同上 |
| 宿主 `10.200.0.1:9000`（Portainer，绑 0.0.0.0） | **OPEN** ⚠️ | R1 |
| 宿主 `10.200.0.1:2222`（sshd，绑 0.0.0.0） | **OPEN** ⚠️ | R1 |
| 宿主 `10.200.0.1:1433`（MSSQL，绑 0.0.0.0） | **OPEN** ⚠️ | R1（抽样） |
| 宿主 `10.200.0.1:5432`（PostgreSQL，绑 0.0.0.0） | **OPEN** ⚠️ | R1（抽样） |
| 宿主 `10.200.0.1:19001`（v2ray 代理，绑 0.0.0.0） | **OPEN 且真能用** ⚠️⚠️ | R1（抽样：`curl -x http://10.200.0.1:19001 https://api.github.com` ⇒ **200**） |
| 宿主 `10.200.0.1:7681`（ttyd web 终端，绑 0.0.0.0） | **OPEN**（要 401 认证） | R1（抽样） |
| 宿主 `10.200.0.1:443`（nginx_reverse_proxy） | **OPEN** ⚠️ | R1（抽样） |
| 宿主 LAN IP `192.168.20.147:9000` | **OPEN** ⚠️ | 同上（换个接口 IP 一样通） |
| 宿主 tailscale IP `100.100.0.3:2222` | **OPEN** ⚠️ | 同上 |

**机制解释**（不是猜，与 Docker 默认行为一致）：容器到**宿主自身**的流量走 `INPUT` 链（默认放行到监听端口）；
容器到**另一个 bridge 网络里的容器**要经 `FORWARD` 链，而 Docker 只为自己那条 bridge 装了进出规则 ⇒ 跨网被丢。
`station-portal` 还额外只把 8080 publish 到 `127.0.0.1`，所以容器连"经宿主端口"这条也没有。

### 2.3 FDE 容器的能力面（实测）

```
privileged=false
capAdd = [SETUID, SETGID, CHOWN, DAC_OVERRIDE, FOWNER, KILL]
mounts = /srv/erix/users/<fde>/home      -> /home/erix          rw
         /srv/erix/users/<fde>/projects  -> /home/erix/projects rw
         /srv/erix/users/<fde>/cache     -> /home/erix/cache    rw
         /srv/erix/users/<fde>/platform/git -> /run/erix/git    ro
```

**没有** docker socket、**没有** `deploy/traefik/dynamic` 挂载、**没有** host 网络、**没有** privileged。
⇒ 「容器直接篡改 Traefik 规则」在能力面上就不成立。

### 2.4 谁能写 `deploy/traefik/dynamic/`（Traefik 规则文件所在目录）

| 主体 | 权限 | 说明 |
|---|---|---|
| 宿主用户 `eric` | rwx | 部署者本人 |
| `station-portal` 容器 | **rw（root）** | 生成 `routes.yml` / `llm-routes.yml` / `tls.yml`（#450 起还写 `certs/`） |
| `station-edge` | **ro** | Traefik 只读 |
| FDE 容器 | **无** | 无挂载 |

`deploy/fde-proxy`（自研，`station_backend:2375`）对 `POST /containers/create` 是**字段级 allowlist**：
名字必须 `fde-<name>`、`NetworkMode` 必须等于容器名、镜像必须在 `IMAGE_ALLOWLIST`、binds 限制在 userspace 根、
user/pids/memory 受限、env 键白名单。**所以「portal 被攻破后起个 privileged 容器挂 `/` 拿宿主 root」这条路被挡住了**
（但 portal 仍能读写 DB、能改路由文件、能读证书私钥——见 R3/R4）。

### 2.5 证书私钥的读写路径（#450/#456 引入）

| 路径 | 是否接触私钥**字节** |
|---|---|
| `tlsassets.js#readTlsAssets`（每次路由物化 + `GET /api/admin/tls`） | **否 —— 只 `stat`**（`size > 0` + `mtimeMs` 算 `keymtime`，不 `readFile`）✅ **#462 / S4 已落地** |
| `PUT /api/admin/tls` | 是（管理员递过来的新私钥，必须写盘——这是唯一必须的接触点） |
| `rollbackCertificateAssets` | **否**（`fs.copyFile`，私钥不进进程内存）✅ **#462 / S4 已落地** |
| `verifyLiveCertificate` | **否**（只比对证书指纹 + 数链深） |
| Traefik 读 `certs/tls.key` | 是（必须，属主 root + 0600，见 `edge-routing.md` §5） |

> **S4 落地记录（#462，2026-11-05）**：`readTlsAssets` 对 `certs/tls.key` 改为 `statAsset()`（只 `stat`，
> 判据仍是「普通文件 + `size > 0`」），回滚改 `fs.copyFile`（+ 显式 `chmod` 644/600）。
> 判据在 `portal/test/tls-assets.test.js`（注入 EACCES 的 `readFile` 仍判「有证书」、真 `chmod 000` 非 root 下同样）
> 与 `portal/test/tls-cert.test.js`（回滚后两文件逐字节相同 + 零次读 `prev/tls.key`）。
> **残余**：`PUT` 那一刻必须把私钥读进内存（管理员递交的字节），这条不可消除；`readPreviousCertificate`
> 只 `stat` 备份私钥（`keyPresent`），也不读字节。

---

## 3. 风险清单

> 严重度按「对平台/宿主的实际控制权损失」排，不按理论优雅度。
> 每条都带**复现判据**，便于将来复核（命令见 §7）。

### R1（高）FDE 容器能直连宿主上**所有**绑 `0.0.0.0` 的服务

- **现状（实测，这是本文最严重的一格）**：宿主上**共 41 个端口**绑在 `0.0.0.0`/`[::]` 上，**全部**对 FDE 容器可达。
  抽样的七条全部 OPEN：`1433`(MSSQL)、`5432`(PostgreSQL)、`9000`(Portainer)、`19001`(v2ray 代理)、
  `443`(nginx)、`7681`(ttyd web 终端，要 401 认证)、`2222`(sshd)。完整清单（2026-11-05）：
  `443 1433 2201 2202 2203 2222 2223 3002 3003 3017 3123 5180 5191 5290 5432 7681 8002 8081 8088 8090 8100 8200 8201 8443 8931 8932 8933 8934 8935 8936 9000 9001 9002 9443 10095 10096 10808 18083 19001 30000 30141`。
  ⚠️ 其中 `19001` 是**能直接用的 HTTP 代理**（容器内 `curl -x http://10.200.0.1:19001 https://api.github.com` ⇒ 200）
  ⇒ 容器获得了一条**出网隧道**（绕过将来可能加的出口策略）；`7681` 是 web 终端（有 401 认证，但仍是暴力破解面）；
  `1433`/`5432` 是数据库（若有弱口令就是数据面）。
- **触发路径**：容器内 agent 跑任意代码 ⇒ `curl`/`ssh` 直接打宿主控制面。**不需要**经过 Traefik 的任何规则。
- **影响**：sshd / ttyd 是宿主 shell 入口（都有认证，但成了爆破面）；Portainer 是容器控制面；1433/5432 是数据面；
  **19001 是出网代理**（实测可用）；将来任何"顺手绑 `0.0.0.0`"的新服务**自动**对全部 FDE 容器可见——
  这就是 `#233` 至今没落地的真实代价，不是理论风险。
- **现有缓解**：**无**（`#233` 未落地）。绑 `127.0.0.1` 的服务（portal publish / LiteLLM / MariaDB）不受影响。
- **根因**：宿主没有按来源收紧。
- ⚠️ **落地约束（2026-11-05 实测，直接决定 `#233` 怎么写）**：41 个端口分属**两条不同的链**，
  只写一条会「看起来做了、其实一半没挡住」：

  | 链 | 端口（41 里） | 谁在那听 |
  |---|---|---|
  | **DOCKER-USER**（docker publish，走 DNAT/FORWARD，**INPUT 规则管不到**） | **27 个**：`443 1433 2201 2202 2203 3002 3003 3017 3123 5180 5191 5290 5432 8002 8081 8088 8100 8200 8201 9000 9001 10095 10096 10808 18083 19001 30000` | `postgresql`(5432) / `mssql`(1433) / `portainerce`(9000) / `nginx_reverse_proxy`(443) / `v2ray`(19001) / **`pi-host-1/2/3`(2201-2203 → 容器 22 端口，即 SSH 进容器)** … |
  | **INPUT**（宿主进程 / `network_mode: host`） | **11 个**：`2222 2223 30141 7681 8931 8932 8933 8934 8935 8936 9002` | 宿主 sshd(2222) / ttyd(7681) / playwright MCP(8931-8936) / `station-edge`(8090/8443/9443) |

  ⇒ **`#233` 必须同时写 `DOCKER-USER` 与 `INPUT`**；只写 INPUT 的话那 27 个（含两个数据库、Portainer、三台容器的 SSH、一个可用代理）
  **一个都不会被挡**，而 INPUT 侧确实生效 ⇒ 验收容易误判成"已完成"。

- **2026-11-05 决策者口径（把 R1 收窄）**：数据库这一类**可以继续 `0.0.0.0` + 靠 DB 内部权限控制**
  （理由：per-FDE 账号 + 库级授权比网络层控制更细，且 unix socket / per-FDE 实例两个方案被否——前者不通用〔MSSQL 无 socket〕、
  后者资源不够）。**但这条不推广到其它端口**：`9000`(Portainer 容器控制面) / `2201-2203`(SSH 进容器) / `19001`(可用出网代理)
  与 DB 权限无关，**仍须关闭**。⇒ `#233` 的默认 DROP 目标收窄成「控制面 + 出网 + 容器 SSH」这三类，DB 按登记表放行。
  详见 §9。

### R2（中）管理台入口 9443 对 FDE 容器可达

- **现状**：容器内 `Host: admin.<伞域>` 打 9443 ⇒ `/api/site` **200**、`/api/admin/users` **401**（只差登录）。
- **决策者口径（2026-11-05）**：`ADMIN_IP_ALLOWLIST` **留空**，明确「这个不需要我们考虑」。⇒ 这是**已接受**的现状。
- **影响**：容器内的 agent 能看见/尝试登录管理台（爆破面）；`#233` 落地后自动消失。
- **现有缓解**：登录限流 + 密码 scrypt + （可选的）TOTP/邮箱验证码。

### R3（高）portal 被攻破 ⇒ Traefik 规则可被任意改写（后端无白名单）

- **现状**：`generateTraefikConfig` 只校验**格式**（hostname / entrypoint / CIDR 是安全 token），**不校验后端地址**；
  而 portal 以 root 跑、对 dynamic 目录 rw ⇒ 它能写出"`Host(x)` → `http://127.0.0.1:2222`"这样的路由。
  实测该形态**真的能通**（一次性容器验证：`Host(portainer.test)` → `http://127.0.0.1:9000` 返回 200；
  TLS 终止的 TCP router → `127.0.0.1:2222`，SSH banner 出现在 TLS 流里，`ssh -o ProxyCommand` 能走完协议）。
- **影响**：宿主 2222/9000/4100 被搬到公网域名后面；预览流量可被劫持到攻击者容器（同域 cookie 风险）；可挂钓鱼页。
- **现有缓解**：`api: false`（无 Traefik dashboard）；Traefik 对 dynamic 只读；`fde-proxy` 挡住"起 privileged 容器"。
- **建议**：S2（后端白名单不变量）+ S3（漂移对账）。
- **🟡 部分处置（#474 S2，2026-11-09，口径见 §10）**：从 2026-11-09 起，portal **经生成器**写出的路由已经不可能
  指向白名单外的后端（构造期 + 发布前最终文本两道），`ClientIP(0.0.0.0/0)` 这类放大也拦在渲染边界。
  **残余风险（说完全）**：本节描述的是「portal 这个进程能写那个目录」——S2 拦的是**我们自己的代码**生成不出坏路由，
  被攻破的 portal **仍然可以直接 `writeFile` 一份自己拼的 YAML** 绕过生成器（它是 root、目录就在它手里）。
  那一半只能靠 S3（被看见）+ 权限模型收敛（S6 那类）兜，**不要把 S2 当成已关掉 R3**。

### R4（高）portal 被攻破 ⇒ **TLS 私钥可被读出**

- **现状（2026-11-05 记录）**：`readTlsAssets()` 为了算 `keymtime` 把 `certs/tls.key` **整份读进内存**（每次路由物化、每次 `GET /api/admin/tls`）。
- **影响**：私钥是 `*.fde.erix.vip` 的 LE 证书（到 2027-02-03）⇒ 泄露后可冒充平台全部子域（含管理台、全部预览）。
- **现有缓解**：私钥 0600 root、只在 portal 容器内可读；响应/审计/日志里从不出现。
- **✅ 已处置（#462 / S4，2026-11-05）**：读路径改 `stat`、回滚改 `copyFile` ⇒ **portal 的读路径永不接触私钥字节**
  （只剩 `PUT` 那一刻必须接收管理员递来的私钥）。**残余风险**：portal 进程一旦被攻破，仍可**主动**去
  `readFile(certs/tls.key)`（它是 root 且文件就在它的可写目录里）——S4 砍掉的是「日常读写路径上的无意暴露面」，
  不是「被攻破后的能力」。要真正砍掉后者得动权限模型（S6 那类结构性收敛）。

### R5（中）Traefik 规则文件被手改不会被发现

- **现状**：`routes.yml` 由 portal 在"路由变更/启动"时重写；两次变更之间若有人改盘上文件，Traefik `watch: true` 会**立即加载**，而系统无任何对账。
- **影响**：与 R3 同后果，但入口是宿主 shell（已失守则无解），现实价值在于**误改/残留**也能被自愈。
- **建议**：S3。
- **🟡 部分处置（#474 S3 一期，2026-11-09，口径见 §10）**：每 60s + 启动一次重算期望态并与盘上比（字节 + mode + 属主 +
  是否普通文件 + symlink），不一致 ⇒ **只告警 + 写审计，不写盘**。
  所以本节的症状从「不会被发现」变成「会被发现并留痕，但**不会自愈**」——二期（自动覆盖）未完，前置条件见 §10.4。

### R6（中）用户面至今是明文 HTTP

- **现状**：`websecure`（8443）一条路由都没挂；用户面全部走 `web`（8090 明文）——口令、会话 cookie、对话内容在局域/尾网内明文传输。
- **影响**：同网段嗅探即可拿到会话；`COOKIE_PROFILE=dev-http` 时 cookie 连 `Secure` 都没有。
- **现有缓解**：网络层靠 tailscale 加密（若确实只在 tailnet 内访问）。
- **备注**：现成证书 `*.fde.erix.vip` **同时覆盖 `station.<伞域>`** ⇒ 上 HTTPS 不需要另签证书，属独立一单（要动 `TRAEFIK_ENTRYPOINT` + 全站 router 加 `tls:{}` + cookie profile 切 `prod`）。

### R7（中，R1 的根因）`#233` 宿主防火墙未落地

- **现状**：`topology.md` 的加固清单里 `iptables-nft` 幂等 + fail-closed 那一条至今没有实现。
- **影响**：R1 直接成立；将来新起的任何 `0.0.0.0` 服务自动对全部 FDE 容器可见。
- **建议**：S1（这是唯一能一次消灭 R1/R2 的方案）。

### R8（低）`/api/internal/*` 对 FDE 网段开放

- **现状**：`internal-allow` 的 `sourceRange` = 各 FDE 的 `/29`（实测 `claim` 无 token ⇒ 401，说明确实到了 portal）。
- **为什么风险低**：`authenticateContainer` 用 **per-container bearer token**（`containers.runner_token_hash`）识别身份，
  FDE 容器只能冒充**自己**（token 在自己 env 里），动不了别人的 run/transcript；token 被吊销即失效。
- **残余**：没有按容器的速率限制（一个容器可以高频打 claim/heartbeat 消耗 portal 资源）——属健壮性问题，不是越权。

### R9（低，设计如此）预览端口段对 FDE 容器可达

- 预览端口在 FDE 容器自己的 netns 里监听，宿主不 publish；Traefik 通过 `10.x.x.2:<port>` 回连。
  容器之间跨 bridge 不通（实测）⇒ 一个 FDE 摸不到另一个 FDE 的预览端口。**这条是对的，别改。**

---

## 4. 建议方案（按性价比）

| # | 方案 | 对应风险 | 成本 | 收益 | 状态 |
|---|---|---|---|---|---|
| **S1** | **`#233` 宿主防火墙收紧（收窄版）**：`DOCKER-USER` + `INPUT` 两条链都写；默认 DROP `{9000, 2201-2203, 19001, 2222, 7681, 8931-8936…}`，放行 `各 FDE /29 → 8090/8443/9443`，DB（5432/1433）**按登记表放行**；幂等 + fail-closed | R1、R2、R7 | 中（iptables 脚本 + 演练 + 回滚；**两条链缺一不可**） | **最高**：消灭"容器直连宿主控制面/出网/容器 SSH" | 独立 issue `#233`，未开工；范围按 2026-11-05 决策收窄（见 §9） |
| **S2** | **路由后端白名单不变量**：只允许 `portalBackendUrl`（全等）、预览后端（**池内网段 + 该 FDE 的前缀 + 端口 22000–29999 + 主机 `.2`**）、`llmGatewayUrl`（全等）、`noop@internal`；另加 **hostname 保留集**（预览 host 不得等于/覆盖 `portalHost`/`adminHost`/`llmHost`）与 **CIDR 池归属**（`parseCidr` 只验语法，实测 `0.0.0.0/0` 放行）；两道校验（构造期 + 发布前最终文本） | R3 | 低（校验函数 + 用例） | 让"指向 `127.0.0.1:22` 的路由"「抢占平台 origin 的路由」「`ClientIP(0.0.0.0/0)` 放大 key 注入」在生成器层就生不出来 | **#474 —— ✅ 已实现（一期，2026-11-09）**：判据与两道校验见 §10 落地记录 |
| **S3** | **路由文件漂移对账**（**分两期**）：一期 = 每 60s 重算并比对 **字节 + mode/属主/是否普通文件/symlink**，不一致 **只告警+审计、不写盘**；二期 = 自动覆盖（前置：跨写者锁 + last-known-good + 一期零误报）。只保护三份受管文件，`routes-lan.yml` 等手工文件**不纳管**（只告警） | R3、R5 | 低 | 手改/误改/权限漂移被看见并留痕 | **#474 —— 一期 ✅ 已实现（2026-11-09，只监控不修复，见 §10）；二期（自动覆盖）未开工** |
| **S4** | **私钥读取收窄**：`readTlsAssets` 用 `stat` 取 `mtimeMs`/大小（不读字节）；回滚用 `fs.copyFile` | R4 | 很低 | portal 读路径永不接触私钥字节（只有上传那一刻必须接收） | **✅ 已实现**（#462，2026-11-05；判据见 §2.5 落地记录） |
| **S5** | 用户面上 HTTPS（复用现成 `*.fde.erix.vip` 证书） | R6 | 中 | 消灭明文口令/会话 | 未开工 |
| S6 | 把"发布路由"拆成独立最小进程（只读 DB、只写一个文件，无 docker/DB 写权限） | R3/R4 的深层 | 高（重排启动与权限模型） | 结构性收敛 | 暂不建议 |
| **S7** | **FDE 专用 DB 协议代理**（像 `fde-proxy` 管 docker socket 那样：容器只连代理，代理按 FDE 身份选库/账号并做协议级限制） | R1 的"共享 DB"分支 | **高**（要自己实现/维护 DB 协议层） | 共享 DB 场景下最强的控制点（per-FDE 身份、限流、审计、可关停） | **⏳ 补充方案，后期再考虑**（2026-11-05 决策者口径） |

**优先级建议**：~~S4（半天，砍掉私钥泄露那一格）~~ **已完成** → S2 + S3（一天，把"规则可被任意改写"关掉）→ S1（单独设计 + 演练）→ S5。

---

## 5. 已接受的风险（决策者口径，不再作为待办反复提）

| 项 | 决策 | 日期 |
|---|---|---|
| `ADMIN_IP_ALLOWLIST` 留空（管理台 9443 对 FDE 容器可达） | 「这个不需要我们考虑，这个留空就好」 | 2026-11-05 |
| 证书生命周期搬进管理台 ⇒ portal 必然能写私钥 | 用户明确要求「证书上传/更新搬进管理台」 | 2026-11-05 |
| 证书为**手工提供**（无 ACME / 无内部 CA / 无 DNS token） | 用户裁决 | 2026-11-05 |
| **数据库容器可以继续 publish 到 `0.0.0.0`**，访问控制交给 **DB 内部权限**（per-FDE 账号 + 库级授权）；`unix socket 挂载`（不通用：MSSQL 无 socket）与 `per-FDE 独立实例`（资源不够）两个方案**被否** | 决策者：「本来也是按数据库账号限制 access 的，数据库内部做好权限控制比啥都强」 | 2026-11-05 |
| 上述口径**只覆盖数据库**；`9000` / `2201-2203` / `19001` 等控制面与出网端口不在此列，仍须按 `#233` 关闭 | 同上（推论） | 2026-11-05 |

---

## 6. 未验证 / 本文的边界

1. **iptables 规则未直接读取**（本机无免密 root）：§2.2 的"为什么不通"是由连通性 + Docker 已知行为**反推**的。
   要做成硬判据，得在 `#233` 的验收里直接 dump 规则。
2. **IPv6 面未枚举**：宿主有 `2408:…` / `fd19:…` 地址，容器侧 IPv6 是否可达未测（Docker 默认不给容器分配 IPv6，但没验证）。
3. **宿主机其它监听服务未逐个枚举**：只测了 9000/2222/3306/4100/18080/8090/8443/9443。§7 给了枚举命令。
4. **Tailscale ACL 侧**：`100.100.0.3` 能被谁访问取决于 tailnet ACL，本文只证明"容器能到"。
5. **portal 被攻破的具体入口**（某个 API 漏洞）未做渗透测试；R3/R4 讨论的是"**一旦**被攻破"的爆炸半径。
6. **预览应用自身**（用户写的 dev server）的漏洞不在本文范围——它本来就在容器里跑任意代码。

---

## 7. 复现附录（本文所有实测命令）

```bash
# ① FDE 容器 → 各处（端口级连通性）
docker exec fde-eric node -e '
const net=require("net");
const t=[["portal","172.32.0.5",8080],["db","172.32.0.2",5432],["fde-proxy","172.32.0.4",2375],
         ["litellm","172.32.0.3",4000],["edge:8090","10.200.0.1",8090],["edge:9443","10.200.0.1",9443],
         ["host portainer","10.200.0.1",9000],["host sshd","10.200.0.1",2222],
         ["other fde","10.200.0.34",8080]];
const one=([n,h,p])=>new Promise(r=>{const s=net.connect({host:h,port:p});const d=v=>{s.destroy();r(`${n} => ${v}`)};
  s.setTimeout(2500,()=>d("TIMEOUT"));s.on("connect",()=>d("OPEN"));s.on("error",e=>d(e.code));});
(async()=>{for(const x of t) console.log(await one(x));})();'

# ② 带 Host 的语义级探测（是否真到 portal）
docker exec fde-eric sh -c '
curl -s -o /dev/null -w "user /healthz %{http_code}\n"   -H "Host: station.fde.erix.vip" http://10.200.0.1:8090/healthz
curl -s -o /dev/null -w "user /api/admin %{http_code}\n"  -H "Host: station.fde.erix.vip" http://10.200.0.1:8090/api/admin/users
curl -sk -o /dev/null -w "admin /api/site %{http_code}\n" -H "Host: admin.fde.erix.vip:9443" https://10.200.0.1:9443/api/site
curl -s -o /dev/null -w "internal(no token) %{http_code}\n" -X POST -H "Content-Type: application/json" -H "Host: station.fde.erix.vip" -d "{}" http://10.200.0.1:8090/api/internal/claim'

# ③ 容器能力面
docker inspect fde-eric --format 'privileged={{.HostConfig.Privileged}} capAdd={{.HostConfig.CapAdd}} net={{.HostConfig.NetworkMode}}'
docker inspect fde-eric --format '{{range .Mounts}}{{.Source}} -> {{.Destination}} rw={{.RW}}{{"\n"}}{{end}}'

# ④ 网络与网段
for c in $(docker ps --format '{{.Names}}' | grep '^fde-'); do
  net=$(docker inspect $c --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}')
  docker network inspect $net --format "{{.Name}} {{range .IPAM.Config}}{{.Subnet}}{{end}}"
done

# ⑤ 宿主上所有 0.0.0.0 监听（R1 的完整暴露面；2026-11-05 = 41 个端口）
ss -ltn | awk '$4 ~ /^(0\.0\.0\.0|\*|\[::\])/ {print $4}' | sed 's/.*://' | sort -un
# 从容器侧逐个验证可达性（把端口列表喂进去即可）：
#   docker exec fde-eric node -e '...net.connect({host:"10.200.0.1",port:<p>})...'
# 19001 是可用的 HTTP 代理，验证：curl -x http://10.200.0.1:19001 https://api.github.com   ⇒ 200

# ⑥ Traefik 规则文件的可写主体
ls -ld /home/eric/projects/erix-station/deploy/traefik/dynamic
docker inspect station-portal --format '{{range .Mounts}}{{.Source}} -> {{.Destination}} rw={{.RW}}{{"\n"}}{{end}}'
docker inspect station-edge   --format '{{range .Mounts}}{{.Source}} -> {{.Destination}} rw={{.RW}}{{"\n"}}{{end}}'

# ⑦ 「规则能把宿主端口搬出去」的真机形态（一次性容器，验完删；不要碰现网 edge）
#    http:  Host(portainer.test) -> http://127.0.0.1:9000         ⇒ 200 + Portainer HTML
#    tcp:   HostSNI(ssh.test) + tls:{} -> 127.0.0.1:2222          ⇒ SSH banner 出现在 TLS 流里
#    客户端: ssh -o ProxyCommand="openssl s_client -quiet -connect host:18444 -servername ssh.test" -p 2222 …
```

---

## 8. 变更记录

- 2026-11-05：初版。基于 v0.1.53 部署后的真机实测（#450 管理台独立入口上线、LE 证书装入之后）。
- 2026-11-05（同日补）：S4 已落地（#462，私钥读路径改 `stat`）；新增 **§9 共享数据库的机制选项**——
  `unix socket` / `per-FDE 实例` 两个方案被否，**数据库继续 `0.0.0.0` + DB 内部权限控制**（附四条前提与残余风险），
  `DB 协议代理` 记为 **S7 补充方案（后期考虑）**；`#233` 因此**收窄**到「控制面 + 出网 + 容器 SSH」三类，
  并记下 `DOCKER-USER`(27) / `INPUT`(11) 两条链的实测划分。

---

## 9. 附：给 FDE 共享数据库的机制选项（2026-11-05 决策记录）

> 触发这次讨论的问题是：「Traefik 的后端白名单只要 portal / 预览 / LLM 三类够不够？FDE 要访问数据库是不是也要过 Traefik？」
> 答案：**不用过 Traefik**——那是东西向流量，走网络 + 防火墙。但「怎么让 FDE 到一个数据库」本身有六种机制，
> 每一种的隔离性质与代价都不同。本节把结论落档，避免下次重新推一遍。

### 9.1 现状（实测，2026-11-05）

| 数据库容器 | publish 形态 | FDE 容器能到吗 |
|---|---|---|
| `postgresql` | **`0.0.0.0:5432`** | **OPEN** |
| `mssql` | **`0.0.0.0:1433`** | **OPEN** |
| `mariadb` | `127.0.0.1:3306` | ECONNREFUSED |
| `fde-workshop-db` | `127.0.0.1:5433` | 到不了 |
| **`station-db`（平台自己的库）** | **无 publish**（只在 `station_backend` 内） | **TIMEOUT** ✅ |

⇒ 能不能到，取决于 **publish 绑在哪个地址**，与 Traefik 无关。`station-db` 的"不 publish"是正确姿势的样板。

### 9.2 五种机制对比

| # | 机制 | 隔离性质 | 代价 / 陷阱 | 2026-11-05 结论 |
|---|---|---|---|---|
| 1 | 容器 **publish 到 `0.0.0.0`** | 网络层无隔离，全靠 DB 自身认证 | 对**所有**网卡与来源开放（LAN / tailnet / 任何容器网段 / 将来任何新网卡） | **对数据库这一类：接受**（见 §9.3）；**对其它服务不适用** |
| 2 | **bind mount unix socket**（PG / MariaDB 有，MSSQL 无） | 最强（文件权限级，不经网络） | 不通用；共享 socket 目录本身又引入一个信任面 | **否**（决策者：不通用） |
| 3 | **per-FDE 独立 DB 实例** | 强（FDE↔FDE 天然隔离） | N 个实例的内存/维护成本 | **否**（决策者：资源不够） |
| 4 | **共享 docker 网络**（DB + 各 FDE 加入） | ⚠️ **会同时打开 FDE↔FDE**（都是该网络成员） | Docker 没有"A↔B 但不许 A↔C"的内建能力 | 不推荐 |
| 5 | **宿主端口 + `DOCKER-USER` 按来源放行** | 中（`-s <FDE /29> -p tcp --dport 5432 -j ACCEPT`，其余 DROP） | 要维护"来源网段 → 端口"登记表 | 过渡可用（`#233` 的机制） |
| 6 | **DB 协议代理**（本文件 §4 的 S7） | 最强（per-FDE 身份、限流、审计、可单独关停） | **要自己实现/维护 DB 协议层**，工作量大 | **⏳ 补充方案，后期再考虑** |

### 9.3 已拍板：数据库按"0.0.0.0 + DB 内部权限"走

决策者原话：「本来也是按数据库账号限制 access 的，数据库内部做好权限控制比啥都强」。

**成立的前提（四条，缺一条这个结论就不成立）**：

1. **per-FDE 独立 DB 账号**（不是共用管理员/root）；
2. 只授**自己那个库/schema**，不给 `CONNECT` 到别人的库、不给 `pg_read_all_data` 之类的跨库读；
3. 密码足够强，且**与平台库（`station-db`）凭据不同源**；
4. 关掉默认库、收紧 `public` schema 的默认权限（PG 的经典坑）。

**残余风险（如实记录，不是"已解决"）**：

- agent 拿到密码后可能被**提示注入 exfiltrate** ⇒ DB 侧只能限制"能看到什么"，限制不了"能不能拿到"；
- **pre-auth 漏洞面**：PG/MSSQL 的历史 CVE 大多发生在认证之前，网络层不设防等于把这段暴露给每个 FDE 容器；
- 暴力破解/凭据填充的来源变多（每个 FDE 都是一个来源）。

### 9.4 与 `#233` 的关系（范围因此收窄）

因为数据库这一类被接受，`#233` 不再需要"一刀切关掉 41 个端口"，而是：

```
默认 DROP 目标（无争议，与业务无关）
  · 9000            Portainer —— 容器控制面
  · 2201-2203       pi-host-1/2/3 的 22 端口 —— 可直接 SSH 进容器
  · 19001           v2ray —— 实测可用的 HTTP 代理（一条出网隧道）
  · 2222 / 7681 / 8931-8936   宿主 sshd / ttyd / playwright MCP（INPUT 侧）
放行
  · 各 FDE /29 → 8090 / 8443 / 9443        预览 forwardAuth、agentd、LLM 网关
  · 各 FDE /29 → 5432 / 1433（按登记表）    共享数据库（本节的决策）
```

⚠ 仍然必须**两条链都写**（`DOCKER-USER` 27 个 + `INPUT` 11 个，见 R1 的落地约束）——这是本节的直接推论，
也是 `#233` 最容易做假的地方。

### 9.5 将来若要更强的隔离

按代价排序：`DOCKER-USER 按来源放行`（已有机制）→ `DB 协议代理`（S7，工作量大但控制最强）→ `per-FDE 独立实例`（资源换隔离）。
其中 **S7 是唯一能在"共享一个 DB"前提下同时做到 per-FDE 身份 + 限流 + 审计 + 单点关停的方案**，
但它需要实现 DB 协议层（PG/MSSQL 的握手与查询流），因此列为**后期可选**，不在当前路线图内。

---

## 10. 落地记录：#474（S2 后端白名单 + S3 一期只读监控，2026-11-09）

代码落点：`portal/src/routebackends.js`（判据 + 两道校验）、`portal/src/routes.js`（唯一构造点与发布三态）、
`portal/src/routesdrift.js`（S3 一期对账）、`portal/src/cli.js`（monitor 起停）。测试：`portal/test/route-backends.test.js`、
`portal/test/routes-drift.test.js`。

### 10.1 S2：四类后端与两条附加不变量

| 后端 | 判据 | 说明 |
|---|---|---|
| portal | 字符串**全等** `config.portalBackendUrl` | 不做「看起来像」的模糊匹配 |
| 预览 | `http://<subnetBase+2>:<port>`，且网段 ∈ FDE IPAM 池（`10.200.0.0/16` / `10.201.0.0/16`）、前缀 = 该 FDE 登记前缀、端口整数 ∈ `[22000, 29999]`、主机**恰为** subnetBase+2 | ⚠ 是 `base+2` 不是「任何 `.2`」更不是「ip+1」；`.2` 由唯一构造点生成，**DB 里的 `backend_url` 不参与判定** |
| LLM 网关 | 字符串**全等** `config.llmGatewayUrl` | — |
| 内部哨兵 | 字面量 `noop@internal` | — |

- **hostname 保留集**：预览 host 必须由 `fdeName + port + baseDomain` **逐字重算**并相等，且不得等于
  `portalHost` / `adminHost` / `llmHost` / `portalInternalHosts` 中任何一个——否则一条预览 `Host()` 就能抢走平台 origin。
- **CIDR 池归属（四判据）**：语法（`parseCidr`）+ **网络地址规范**（host bits 必须为 0）+ **池归属** + **与该 FDE 关联**。
  只有语法是不够的：实测 `parseCidr('0.0.0.0/0')` 会放行，而 `ClientIP(0.0.0.0/0)` 正好把 per-FDE key 的注入面放大到全网。
  **管理员 IP allowlist 不受池限制**（那是另一个信任域，管理员本来就能填任意网段）。

### 10.2 两道校验与发布三态

1. **构造期**：`buildPreviewBackendUrl` / `buildPreviewAllocation` / 各 `assert*`——坏值生不出对象。
2. **发布前**：`assertRenderedRouteText()` 对**最终 YAML 文本**做结构断言。这一道防的是「绕过构造点直接塞字符串」
   和「以后有人加第二条渲染路径」。⚠ 断的是**文本**不是 AST：**不引入 YAML parser**（红线），所以是「行/键结构 + 值必须命中白名单」的断言，不是解析。

**三态**（严格分开，混起来就会误删路由）：

- **合法空**（该 FDE 没有 LLM binding）⇒ 允许 `unlink llm-routes.yml`；
- **有效** ⇒ 原子写（临时文件 + rename）；
- **失败**（拿不到数据 / 校验不过）⇒ **保留 last-known-good**，绝不用半截配置盖掉已经在工作的那份。

「空」和「拿不到」是两回事：前者该删文件，后者该什么都不做。

### 10.3 S3 一期：只读对账的口径

- 每 60s + 启动一次（周期写死在代码里，**不是** env 旋钮）；重入时等同一轮，不静默丢拍。
- 期望态与发布面**同一份代码**（`readRouteDesiredState` + 两个生成器 + `renderTlsConfig()` + 第二道断言）⇒ 白名单改了这里自动跟上，不存在「第二份模板」。
- 比对顺序：symlink / 是否普通文件 → mode（`routes.yml` 0644、`llm-routes.yml` **0600**、`tls.yml` 0644）→ 属主 → 字节。
  **字节相同也要报**：`llm-routes.yml` 0600 被改成 0644 = per-FDE 虚拟 key 明文变成同组/他人可读。
- 未纳管的 `*.yml`（含 `routes-lan.yml`）**只列出、不删不改**。
- **输出字段白名单**：文件名 / kind / stage / 时间 / sha256 前 8 位 / 字节数 / mode / uid-gid / 失败阶段。
  **日志与审计里绝不出现 YAML 正文、token、diff**（有用例拿 canary 明文盯这一条）。
- 审计：`audit_log.action = 'admin.routes_drift_detected'`，`details` 就是上面那组元数据（JSONB）；**零漂移一条都不写**（60s 一轮会灌满）。
- **算不出来 ⇒ 整轮 skip + warn、零 finding**：不把「拿不到」当「应当不存在」——否则报的是假漂移，二期还会据此误删。

### 10.4 二期（自动覆盖）的前置条件——不要跳过

① 跨写者锁（运维/别的脚本也写这个目录）；② last-known-good 语义已具备（§10.2 ✅）；③ 一期观察期内**零误报**；
④ `unlink` 需要目录写权限，而写目录 ⇒ 能把目录改名 ⇒ 得把属主 chown 回去。四条不齐就上自动覆盖，
等于把「有人手改」变成「每 60 秒和运维打架一次」。

### 10.5 运维怎么看（一期不会自愈）

```bash
docker logs station-portal 2>&1 | grep '\[routes-drift\]'
```

```sql
SELECT created_at, action, details FROM audit_log
 WHERE action = 'admin.routes_drift_detected' ORDER BY id DESC LIMIT 20;
```

`details` 的样子（这就是全部信息量，没有正文）：

```json
{"file":"llm-routes.yml","kind":"metadata","stage":"mode",
 "sha_before8":"1f2e3d4c","sha_after8":"1f2e3d4c","bytes":412,
 "mode_expected":"600","mode_actual":"644"}
```

⇒ 两个 sha 相同 = 字节没动，只是权限被放宽。处理办法：改回生成器那份（重启 portal 重发布，或让 portal 下一次路由变更覆盖）。

**边界（如实）**：白名单校验**不在模块 import 期**执行——config 坏时应该是一条可读的启动错误，不是进程在 `import` 里崩。
本文写「S2 已实现」的范围是「portal **经生成器**写出的路由」；被攻破的 portal 直接 `writeFile` 仍绕过 S2（见 R3 的残余风险），那一半归 S3 看见 + 权限模型收敛。
