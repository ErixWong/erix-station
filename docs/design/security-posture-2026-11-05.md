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
| 已经做对的部分 | `internal` API 用 **per-container bearer token**；`deploy/fde-proxy` 对建容器是**字段级 allowlist**；Traefik 对 dynamic 目录只读 |

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
| `tlsassets.js#readTlsAssets`（每次路由物化 + `GET /api/admin/tls`） | **是**（为了算 `keymtime` 指纹把整份私钥读进内存）→ R4 |
| `PUT /api/admin/tls` | 是（管理员递过来的新私钥，必须写盘） |
| `rollbackCertificateAssets` | 是（`readFile` 再 `write`）→ 可改 `copyFile` |
| `verifyLiveCertificate` | **否**（只比对证书指纹） |
| Traefik 读 `certs/tls.key` | 是（必须，属主 root + 0600，见 `edge-routing.md` §5） |

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
- **根因**：宿主 `INPUT` 链没有按来源收紧。

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

### R4（高）portal 被攻破 ⇒ **TLS 私钥可被读出**

- **现状**：`readTlsAssets()` 为了算 `keymtime` 把 `certs/tls.key` **整份读进内存**（每次路由物化、每次 `GET /api/admin/tls`）。
- **影响**：私钥是 `*.fde.erix.vip` 的 LE 证书（到 2027-02-03）⇒ 泄露后可冒充平台全部子域（含管理台、全部预览）。
- **现有缓解**：私钥 0600 root、只在 portal 容器内可读；响应/审计/日志里从不出现。
- **建议**：S4（读路径改 `stat`，回滚改 `copyFile`）——**便宜且直接砍掉这一格**。

### R5（中）Traefik 规则文件被手改不会被发现

- **现状**：`routes.yml` 由 portal 在"路由变更/启动"时重写；两次变更之间若有人改盘上文件，Traefik `watch: true` 会**立即加载**，而系统无任何对账。
- **影响**：与 R3 同后果，但入口是宿主 shell（已失守则无解），现实价值在于**误改/残留**也能被自愈。
- **建议**：S3。

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
| **S1** | **`#233` 宿主 INPUT 收紧**：只放行 FDE 网段 → `8090/8443/9443`，其余（9000/2222/3306/4100…）DROP；幂等 + fail-closed | R1、R2、R7 | 中（要写 iptables 脚本 + 演练 + 回滚） | **最高**：一次消灭"容器直连宿主控制面" | 独立 issue `#233`，未开工 |
| **S2** | **路由后端白名单不变量**：`generateTraefikConfig` 只允许 `portalBackendUrl` 与「DB 里活着的 `port_allocations` 算出的 `10.x.x.2:<port>`」，其它一律抛错 | R3 | 低（一个校验函数 + 几条用例） | 让"指向 `127.0.0.1:22` 的路由"在生成器层就生不出来 | 未开工 |
| **S3** | **路由文件漂移对账**：portal 定时（如 60s）重算 `routes.yml` 与盘上比对，不一致 ⇒ 覆盖 + 审计 `admin.routes_drift_corrected` + 告警 | R3、R5 | 低 | 手改/误改被自愈并留痕 | 未开工 |
| **S4** | **私钥读取收窄**：`readTlsAssets` 用 `stat` 取 `mtimeMs`/大小（不读字节）；回滚用 `fs.copyFile` | R4 | 很低 | portal 读路径永不接触私钥字节（只有上传那一刻必须接收） | 未开工 |
| **S5** | 用户面上 HTTPS（复用现成 `*.fde.erix.vip` 证书） | R6 | 中 | 消灭明文口令/会话 | 未开工 |
| S6 | 把"发布路由"拆成独立最小进程（只读 DB、只写一个文件，无 docker/DB 写权限） | R3/R4 的深层 | 高（重排启动与权限模型） | 结构性收敛 | 暂不建议 |

**优先级建议**：S4（半天，砍掉私钥泄露那一格）→ S2 + S3（一天，把"规则可被任意改写"关掉）→ S1（单独设计 + 演练）→ S5。

---

## 5. 已接受的风险（决策者口径，不再作为待办反复提）

| 项 | 决策 | 日期 |
|---|---|---|
| `ADMIN_IP_ALLOWLIST` 留空（管理台 9443 对 FDE 容器可达） | 「这个不需要我们考虑，这个留空就好」 | 2026-11-05 |
| 证书生命周期搬进管理台 ⇒ portal 必然能写私钥 | 用户明确要求「证书上传/更新搬进管理台」 | 2026-11-05 |
| 证书为**手工提供**（无 ACME / 无内部 CA / 无 DNS token） | 用户裁决 | 2026-11-05 |

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
