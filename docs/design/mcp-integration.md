# MCP 通道 P1 —— 设计契约（issue #608）

> 定位：**MCP 是「有状态能力」的载体，skill 是「一次函数调用」的载体**。本文只写 MCP 通道本身；
> 市场（发布/浏览/安装/启停）的通用契约在 [`capability-market.md`](capability-market.md)，
> 本文是它在 `kind='mcp'` 上的**扩展与偏离**。
>
> 一句话范围：**P1 只做形态①（run 内 stdio / 远端 HTTP）+ 平台注入凭据 + 单网关工具**。
> 形态②（FDE 容器内常驻）与形态③（平台侧共享 hub）在 §12 明确不做，只留字段与触发条件。

---

## 0. 结论先行（5 条）

1. **上游零改动**。MCP 走的是 notes / shell / skills 已经用的同一条宿主缝：
   `createXxxTools()` → `{schemas, executeTool}` → `runner/worker.js` 的 `baseToolSchemas` + 一条执行路由。
   `erix-llm-kit/docs/requirements.md:45` 把 MCP 列为**永久非目标**，所以客户端由宿主自己写。
2. **凭据一律平台注入**（用户决策 2026-11-16）：值加密存 portal，**永不落盘到 FDE**，run 启动时经
   `/api/internal/*` 现取，只在 worker 内存里活一次 run。用户面**没有填值入口**。
3. **工具面只加一个 `mcp` 工具**（`list / search / call / status`）。工具元数据按需拉取 + 落 DB 缓存，
   所以「装 30 个 server」不涨每轮上下文；这与技能「每轮全额铺 schema，所以限 12 个」是两条不同的账。
4. **两个独立旋钮**：`exposure`（direct / deferred / hidden）× `lifecycle`（run / run-keep-alive）。
   合成一个旋钮就会出两类事故：direct 的大 server 吃光上下文 / 要保态的 server 每 run 重建连接。
5. **`tool call` 永不重试**（可能已执行）；resources 类只读操作可重试一次。进程必须**整组 kill**。

---

## 1. 协议事实（客户端要实现的最小集）

传输两种，都只做客户端：

| 传输 | 帧 | 生命周期 | 我们的用法 |
|---|---|---|---|
| **stdio** | 换行分隔 JSON-RPC 2.0（stdin/stdout），stderr 单独收（截断保留 4 KiB 供报错） | 子进程随客户端 | 第三方 npx server、需要独立运行时的 server |
| **streamable HTTP** | `POST`，`Accept: application/json, text/event-stream`；响应可能是 JSON 或 SSE | 服务独立存活 | 公司内部 MCP hub、`srch.erix.vip/mcp` 这类 |

握手与调用（我们**只实现这些**，不实现 sampling / elicitation / UI / tasks）：

```
initialize                {protocolVersion:"2025-06-18", capabilities:{}, clientInfo:{name:"station-runner",version}}
notifications/initialized
tools/list                → {tools:[{name, description, inputSchema}]}
tools/call                {name, arguments} → {content:[{type:"text",text}...], isError?}
notifications/cancelled   {requestId, reason}   ← 用户点「停止」时发
ping                      （保活用；可选）
```

**不实现**：resources / prompts / sampling / elicitation / tasks / MCP Apps。理由：P1 的判据是「能不能把
一个 server 的工具安全地借给模型」，其余都是形态②③的配套。

**HTTP 会话**：响应头带 `Mcp-Session-Id` 时缓存并后续请求带上；`404/410` ⇒ 清缓存重握手一次（**仅握手重试，
tool call 不重试**）。

---

## 2. 三种形态（这张表决定一切）

| 形态 | 谁持有进程 | 生命周期 | 能保住什么 | P1 |
|---|---|---|---|---|
| **① run 内** | worker（`agentd.js:1106` 一 run 一 fork） | run 结束即 kill 整个进程组 | 本次 run 内的连接/会话 | ✅ 本单 |
| **② FDE 容器内常驻** | agentd（跨 run） | 空闲回收 / 崩溃重启 | 跨 run 的连接、会话、PTY、后台任务 | ❌ P2 |
| **③ 平台侧共享 hub** | 平台（跨 FDE） | 平台运维 | 跨 run + 跨 FDE，凭据与审计集中、配额 | ❌ P3 |

**反例入库**：`touwaka/data/skills/erix-ssh` 是 frozen draft，`is_resident: 1`，SKILL.md 自述等四样东西
（常驻进程契约 / 权限边界 / 凭据处理 / 用户可见审计）——**这四样没有一样属于「包」**。它「尽力想在 skill
里做完，做完就是 MCP」。结论：ssh 这类必须形态③；`~/.erix/skills` 里**不许**出现常驻/会话/持久化形状
（发布校验会拦，见 §4.4）。

**P1 的形态字段先占位**：`resident ∈ {false, container, platform}`，P1 只接受 `false`，其余一律
`409 capability_kind_unsupported`（不假装支持）。

---

## 3. 数据模型（DDL 全文）

复用 `capability_items`（`kind='mcp'`）做目录条目；`manifest` 存 MCP 特有结构。新增两张表。

```sql
-- 0039 已建：capability_items / capability_files / fde_capability_installs（kind 列已含 'mcp'）

-- MCP 条目的 manifest 形状（jsonb，不新增列）：
-- {
--   "transport": "stdio" | "http",
--   "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"],   // stdio
--   "url": "https://srch.erix.vip/mcp",                                        // http
--   "exposure": "direct" | "deferred" | "hidden",
--   "lifecycle": "run" | "run-keep-alive",
--   "resident": false,                        // P1 只允许 false
--   "reason": "tool_surface_gt_12",           // 准入理由，见 §4.3
--   "timeout_ms": 60000,                      // 单请求超时，1..300000
--   "tools_cache": [ {"name":"...","description":"..."} ],   // runner 回填，见 §6.6
--   "tools_cache_at": "2026-11-17T00:00:00Z"
-- }

-- 配置槽声明（随包/条目走；skill 与 mcp 共用）
CREATE TABLE IF NOT EXISTS capability_params (
  item_id     uuid NOT NULL REFERENCES capability_items (id) ON DELETE CASCADE,
  name        text NOT NULL,              -- 注入名：^[A-Z][A-Z0-9_]{0,63}$（env/header 名即它）
  kind        text NOT NULL CHECK (kind IN ('config','secret')),
  inject      text NOT NULL CHECK (inject IN ('context','env','header')),
  required    boolean NOT NULL DEFAULT true,
  description text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, name),
  -- secret 只能落 env/header（context 是 skill 的进程内面，secret 进去等于交给技能代码）；
  -- 反过来 config 三种都允许（URL 这类进 context 是合理的）。
  CHECK (kind <> 'secret' OR inject IN ('env','header'))
);

-- 配置槽的值（只写不读；AES-256-GCM）
CREATE TABLE IF NOT EXISTS capability_param_values (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id         uuid NOT NULL REFERENCES capability_items (id) ON DELETE CASCADE,
  name            text NOT NULL,
  scope           text NOT NULL CHECK (scope IN ('global','fde')),
  fde_id          uuid REFERENCES users (id) ON DELETE CASCADE,   -- scope='fde' 必填
  value_encrypted bytea NOT NULL,        -- iv(12) || tag(16) || ciphertext
  updated_by      uuid REFERENCES users (id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (item_id, name) REFERENCES capability_params (item_id, name) ON DELETE CASCADE,
  CHECK ((scope = 'fde') = (fde_id IS NOT NULL))
);
-- NULL 在唯一索引里不互等 ⇒ 两条**部分**唯一索引代替复合主键
CREATE UNIQUE INDEX IF NOT EXISTS capability_param_values_global_uq
  ON capability_param_values (item_id, name) WHERE scope = 'global';
CREATE UNIQUE INDEX IF NOT EXISTS capability_param_values_fde_uq
  ON capability_param_values (item_id, name, fde_id) WHERE scope = 'fde';
```

**加密口径**（`portal/src/secrets.js`，新模块）：

- 算法 `aes-256-gcm`，key = `MCP_SECRET_KEY`（`deploy/.env`，base64 的 32 字节；**不给默认值**，
  缺失时**只允许读已有密文**，写操作 `503 secret_key_missing`）。
- 存储 `iv(12) || tag(16) || ciphertext`；AAD = `${item_id}:${name}:${scope}`（换条目/换槽位就解不开，
  防止密文被搬移）。
- **只写不读**：任何 API 都不返回明文；`GET` 只回 `{name, has_value, updated_at, updated_by}`。
- 轮换 key ⇒ 旧密文不可解 ⇒ 该槽位视为「未设置」（页面显示未设置，管理员重填），**不静默失败**。

---

## 4. 配置槽与发布校验

### 4.1 声明（发布期）

| 字段 | 规则 | 拒绝码 |
|---|---|---|
| `name` | `^[A-Z][A-Z0-9_]{0,63}$`；同一 item 内唯一；不得落在保留名集合 | `capability_slot_invalid` |
| `kind` | `config` \| `secret` | 同上 |
| `inject` | `context`（仅 skill）\| `env`（stdio）\| `header`（http）；与 kind 的交叉约束见 §3 的 CHECK | 同上 |
| `required` | 布尔 | 同上 |
| `description` | 非空（管理员填给运维看的「这是什么」） | 同上 |

**保留名黑名单**（照 touwaka `buildSkillEnvironment` 的思路，防「参数把安全关键变量顶掉」）：
`PATH` `HOME` `NODE_OPTIONS` `LD_PRELOAD` `LD_LIBRARY_PATH` `PYTHONPATH` `PYTHONSTARTUP`
`HTTP_PROXY` `HTTPS_PROXY` `NO_PROXY` `ALL_PROXY` `NODE_EXTRA_CA_CERTS` `SSL_CERT_FILE`
以及我们自己的 `ERIX_*` `STATION_*` `SKILL_*` `MCP_*`。命中 ⇒ `400 capability_slot_invalid`（`details.name`）。

### 4.2 注入面（运行期）

| 条目 kind | inject | 落地 |
|---|---|---|
| skill | `context` | `skillModule[tool](input, { ...ctx, secrets })`；**不改 `process.env`**（技能是 in-process，改 env 会污染整个 worker 且被 delegation 子 run 继承） |
| mcp stdio | `env` | 子进程 env（`spawn(..., {env:{...process.env, ...resolved}})`） |
| mcp http | `header` | 请求头（值原样，不做前缀拼接；要 `Bearer x` 就在值里写 `Bearer x`） |

**取值优先级**：`fde` 覆盖 > `global` > `default_value`（仅 `config`）。**缺必填** ⇒ 该 server **不注册**
（工具面里没有它）+ 一条 `MSG.LOG warn`（`mcp server skipped: missing slots [X,Y]`）；`enabled` 操作在
API 层就被 409 拦（§7.2），所以正常路径不会出现「装了但静默不生效」。

### 4.3 准入理由（MCP 专属，必填）

`reason ∈ {stateful, tool_surface_gt_12, shared_quota, credential_boundary}`。缺失 ⇒
`400 capability_reason_required`。理由进 DTO 与 UI（用户面显示「为什么它是 MCP 而不是技能」）。
`skill` 条目带 `reason` ⇒ 忽略（不报错）。

> 口径：**默认形态是 skill**。MCP 只在「跨调用要保住东西 / 工具面 > 12 / 需要平台侧共享配额 /
> 凭据必须留在平台」至少占一条时才被接受。

### 4.4 skill 包的红色形状（本单同时补）

`validateBundle` 增加静态扫描（**硬拒**，`400 capability_package_shape`）：

- `detached: true`（自建常驻进程）
- 模块级 `setInterval(` / `setTimeout(`（顶层长驻）
- `listen(` / `createServer(`（监听端口）
- `node-pty` / `pty.spawn`
- 写包外持久目录（字面量 `~/.erix/`、`/var/`、`/srv/` 出现在写调用参数里）
- 声明常驻字段（`is_resident` / `resident: true`）

理由：这些形状在 skill 里几乎必然是错的（§2 反例）；要常驻就该走形态②③。

---

## 5. 物化（runner 的输入，两处）

### 5.1 `~/.erix/mcp.json`（**不含任何值**）

```json
{
  "version": 1,
  "servers": [
    {
      "name": "github",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "exposure": "deferred",
      "lifecycle": "run",
      "timeout_ms": 60000,
      "slots": [{ "name": "GITHUB_TOKEN", "inject": "env", "required": true }]
    },
    {
      "name": "searxng-hub",
      "transport": "http",
      "url": "https://srch.erix.vip/mcp",
      "exposure": "direct",
      "lifecycle": "run-keep-alive",
      "timeout_ms": 60000,
      "slots": [{ "name": "AUTHORIZATION", "inject": "header", "required": true }]
    }
  ]
}
```

硬口径：

- **形状不是标准 `mcpServers`**（标准形状会让别的工具误以为可直接用，而里面没有值）⇒ 自定义
  `{version, servers[]}`，注释里写明「值在平台，经内部通道现取」。
- **逐字节确定**：按 `name` 升序，无时间戳/随机量；无安装 ⇒ `{"version":1,"servers":[]}`。
- root:root 0644（与 `capabilities.json` 同列），FDE 可读、不可写。
- **秘密扫描用例**（`docs/design/user-space.md` §4.1.2 的硬要求）：`materializer.test.js` 补一条
  「`mcp.json` 里不出现任何密钥形状」。

### 5.2 `~/.erix/capabilities.json` 增加 `mcp` 段（metadata cache）

```json
{
  "version": 1,
  "skills": [ ... 原样 ... ],
  "mcp": [
    { "name": "github", "description": "GitHub 仓库与 PR 操作", "exposure": "deferred",
      "tools": ["create_issue", "get_pull_request"] }
  ]
}
```

- `description` = 条目 `summary`（必填，模型靠它决定要不要 search）；`tools` 来自 `manifest.tools_cache`，
  **可能为空**（还没人跑过）⇒ 渲染成 `tools: []`，索引段写「工具清单未知，call 前先 search」。
- 索引段（§6.5）只列 `name + description + 工具数`，**不列工具名**（工具名进上下文就是几百 token）。

---

## 6. runner 侧实现

### 6.1 模块划分

```
runner/lib/mcp-client.js   传输层：stdio / http，握手、请求超时、会话、取消、进程组 kill
runner/lib/mcp-tool.js     工具面：一个 mcp 工具（list/search/call/status）+ 元数据索引 + 审批闸
runner/lib/mcp-servers.js  取配置：读 ~/.erix/mcp.json + 经内部通道取值 → 组装成 client 的输入
runner/worker.js           接线：装配 schemas、执行路由、run 收尾 close()、reviewOnly 排除
```

### 6.2 关键签名（实现按这个写，测试按这个钉）

```js
// mcp-client.js
export function createMcpClient({ server, resolved, log, spawnImpl, fetchImpl })
// → { name, exposure, lifecycle, listTools({signal}) → [{name,description,inputSchema}],
//     callTool(toolName, args, {signal}) → {text, isError, truncated, fullPath},
//     status() → {state:'idle'|'starting'|'ready'|'error'|'closed', error?},
//     close() → Promise<void> }        // 幂等；stdio 走 stdin.end() → SIGTERM → 200ms → SIGKILL(进程组)

export function createMcpPool({ servers, resolveSlots, log })  // servers 来自 mcp.json
// → { get(name), list(), closeAll(), missing: [{name, slots:[]}] }

// mcp-tool.js
export function createMcpTool({ pool, metadata, approve, log })
// → { schemas: [MCP_SCHEMA], executeTool(name, input, ctx) }
//   ctx: { signal, runId, sessionId, cwd }   ← 审批与取消都要用
```

### 6.3 `mcp` 工具的动作面（schema 固定，**不随 server 数变化**）

```jsonc
{
  "name": "mcp",
  "description": "调用平台配置的 MCP 服务器。action=list 看有哪些 server 与状态；search 找工具（元数据缓存，server 未连也能搜）；call 调工具；status 看连接态。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "action": { "type": "string", "enum": ["list", "search", "call", "status"] },
      "server": { "type": "string", "description": "server 名（call 时必填，可用 search 结果里的 server）" },
      "tool":   { "type": "string", "description": "工具名（call 时必填）" },
      "args":   { "type": "object", "description": "工具参数（原样透传给 server）" },
      "query":  { "type": "string", "description": "search 关键词（匹配 server 名 / 工具名 / 描述）" }
    },
    "required": ["action"]
  }
}
```

动作语义：

| action | 行为 | 失败 |
|---|---|---|
| `list` | 列 server：`name / exposure / status / 工具数`（不列工具名） | 单个 server 错误不影响其余 |
| `search` | 在**元数据缓存**上做不区分大小写子串匹配（server 名 + 工具名 + 描述），返回 `server + tool + 一行描述`（**不回 inputSchema**，除非 `describe:true` 扩展位留空） | 无命中 ⇒ 明说「无命中，可能该 server 还没被调用过（元数据未回填）」 |
| `call` | 解析 `tool` 属于哪个 server（缓存里查；查不到 ⇒ 报「未知工具，先 search」），必要时懒启动，然后 `tools/call` | 超时 `mcp_call_timeout`；连接失败 `mcp_unreachable`；server 返回 `isError` ⇒ 结果文本 + `isError:true` 标记 |
| `status` | 每个 server 的 `{state, lastError, toolsCached}` | 不触发连接 |

### 6.4 生命周期状态机（每 server 一份）

```
idle ──call/search 命中且需要工具元数据──▶ starting ──握手成功──▶ ready
  ▲                                            │失败                 │
  └────────── idle（lifecycle='run' 每次 call 后可停） ◀── error ──────┘
```

- `lifecycle='run'`：**每次 call 后不主动停**（同 run 内复用），run 结束统一 `closeAll()`。
- `lifecycle='run-keep-alive'`：同上，但**额外**保证跨 call 不重建（P1 两者行为一致，差别在 P2 才有意义
  ——P1 保留字段是为了上架时不返工；实现里用同一个 `closeAll()` 收尾，注释写明这一点）。
- `error` 态：**下一次 call 允许重试连接一次**（`failure-backoff`：连续失败 ≥3 次则本 run 内不再尝试，
  直接报 `mcp_unreachable`，避免每次 call 都烧 30s 超时）。

### 6.5 上下文注入（L3 扩展）

`runner/lib/capability-index.js` 增加一段（与「平台技能」并列）：

```
## 平台 MCP 服务（能力市场）
- github — GitHub 仓库与 PR 操作；工具 2 个（未知则写「工具清单未知」）；用法：mcp({action:"search"}) 找工具后 call
```

硬口径沿用 §6 的四条（只来自原文 / 字节确定 / 失败降级 / 总段 ≤4 KiB 含 MCP 段，超出按 name 截尾）。
`exposure='hidden'` 的 server **不进这段**（隐藏就是隐藏，只靠 `search` 偶然命中也不该——见 §9）。

### 6.6 元数据回填（让 `search` 在 server 挂掉时仍可用）

`list`/`search`/`call` 任一次成功拿到 `tools/list` 后，若与缓存不同 ⇒
`POST /api/internal/mcp/tools-cache`（per-container token）`{slug, tools:[{name,description}]}`，
portal 写 `manifest.tools_cache` + `tools_cache_at`，下次物化进 `capabilities.json`。

**为什么由 runner 回填而不是管理台「测试连接」**：portal 绝不执行第三方代码（§10）。管理台看到的工具清单
永远来自「某台 FDE 真的连过」，UI 上注明 `tools_cache_at`。

### 6.7 结果处理

- 文本块拼接（`content[].type==='text'` 取 `text`；`image`/`resource` 只回占位 `[image omitted]`）。
- **>20 KiB 掐中间**：保留头 12 KiB + 尾 8 KiB，中间写 `…N chars truncated…`，全文落
  `/tmp/erix-mcp/<runId>-<rand>.txt`，结果里给路径（pi 的同款口径）。
- 结果进 `tool_result` 时带 `duration_ms`（引擎自己记）+ `server`/`tool` 两个字段（便于 UI 显示来源）。

### 6.8 取消与收尾

- `options.signal` 一路传到 `fetch`（HTTP）与「写 `notifications/cancelled` + kill 子进程组」（stdio）。
- run 收尾（`finally`）：`pool.closeAll()`；**先 `stdin.end()` → `SIGTERM` → 200 ms → `SIGKILL` 到进程组**
  （`spawn(..., {detached:true})` 让子进程自成进程组，否则 `npx` 那层壳会留孤儿）。
- 收尾失败只 `warn`，不影响 run 终态。

---

## 7. portal 侧实现

### 7.1 模块

- `portal/src/secrets.js`（新）：AES-GCM 封装 `encryptValue/decryptValue/resolveSlots`。
- `portal/src/market.js`（扩展）：
  - `validateMcpFields(fields)`：`transport/command|url/args/exposure/lifecycle/resident/timeout_ms/reason/slots`
  - `validateBundle` 增加 §4.4 的红色形状扫描（skill 侧）
  - `installCapability`：`kind='mcp'` ⇒ **不落盘**，只写 `fde_capability_installs` + 排队物化
  - `setCapabilityEnabled`：`kind='mcp'` 且 `enabled=true` ⇒ 先 `resolveSlots`，缺必填 ⇒ 409
  - `resolveMcpServersForFde({pool, config, fde})`：组装内部通道响应（含明文值）
- `portal/src/materializer.js`：`renderMcpJson(servers)`（§5.1）+ `renderCapabilitiesJson` 增 `mcp` 段（§5.2）。

### 7.2 API（`docs/api/portal.md` 新增 §4.18）

**管理面**（`/api/admin/market/*`，仅管理台入口可达）：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/admin/market/items` | `kind='mcp'` 时字段面见 §4.1/§4.3；**不需要 bundle** |
| PUT | `/api/admin/market/items/:id` | 同上（改 transport/args/slots 要 bump version） |
| GET | `/api/admin/market/items/:id/secrets` | `{slots:[{name,kind,inject,required,has_value,updated_at,updated_by}]}` —— **永不含值** |
| PUT | `/api/admin/market/items/:id/secrets` | `{values:{NAME:"…"}}`（只写；`null` 值 = 删除该槽位值） |

**用户面**（`/api/market/*`）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/market/items` | 每条带 `kind / reason / exposure / secrets_ready`（`secrets_ready=false` ⇒ 前端禁用「启用」并显示「等待管理员配置凭据」） |
| POST | `/api/market/items/:slug/install` | `kind='mcp'` ⇒ 只写绑定；缺凭据允许安装（不可启用） |
| POST | `/api/market/items/:slug/enabled` | `kind='mcp'` 且缺必填槽 ⇒ `409 capability_secret_missing`（`details.missing:[names]`） |

**内部通道**（`/api/internal/*`，per-container token）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/internal/mcp/servers` | `{servers:[…resolved…], missing:[{name,slots}]}`；**明文值**；审计一条（只记 server/slot 名） |
| POST | `/api/internal/mcp/tools-cache` | `{slug, tools:[{name,description}]}` ⇒ 写 `manifest.tools_cache` |

### 7.3 错误码（新增）

| 码 | HTTP | 场景 |
|---|---|---|
| `capability_reason_required` | 400 | MCP 条目缺准入理由 |
| `capability_slot_invalid` | 400 | 槽位名/kind/inject/保留名不合法 |
| `capability_secret_missing` | 409 | 启用时缺必填槽（`details.missing`） |
| `capability_package_shape` | 400 | skill 包命中 §4.4 红色形状 |
| `secret_key_missing` | 503 | 写值但 `MCP_SECRET_KEY` 未配置 |
| `mcp_unreachable` | 502 | 运行期连接失败（只在内部/运行期出现，不进市场 API） |
| `mcp_call_timeout` | 504 | 运行期单请求超时 |

---

## 8. 前端

### 8.1 管理台（`AdminMarketView.vue` 扩展）

- 发布/编辑表单加 `kind` 切换；`kind='mcp'` 时字段组替换为：
  `transport(stdio|http)` · `command`+`args`（stdio）/ `url`（http）· `exposure` · `lifecycle` ·
  `timeout_ms` · **`reason`（必选下拉，带一行解释）** · `slots` 可增删行（name/kind/inject/required/description）。
- 条目详情新增「凭据」区：每槽一行 `name / kind / has_value / updated_at` + 「设置」按钮（modal 输入一次，
  保存后只显示「已设置」）；**没有任何「查看」入口**（后端也不给）。
- 工具清单区：显示 `manifest.tools_cache` + `tools_cache_at`，为空时写明「还没有 FDE 连过这个 server」。

### 8.2 用户面（`MarketView.vue` 扩展）

- 卡片加 `kind` 徽标（`skill` / `mcp`）与 `reason` 的一句话（i18n 映射，不显示英文枚举）。
- MCP 卡片：显示 `exposure` 与工具数；`secrets_ready=false` ⇒ 「启用」按钮 disabled + 文案
  「等待管理员配置凭据」（**不显示缺哪个槽的细节**——用户无从处理，只会增加噪音；管理员面才给细节）。
- **没有填值输入框**（用户决策）。

### 8.3 i18n

`market.kind.{skill,mcp}` · `market.reason.{stateful,tool_surface_gt_12,shared_quota,credential_boundary}` ·
`market.mcp.{secretsPending,exposure.{direct,deferred,hidden},toolsUnknown}` ·
`admin.market.secrets.{title,set,hasValue,missing,keyMissing}` · `admin.market.form.mcp.*`。
`localeParity.spec.ts` 会拦漏翻。

---

## 9. 审批闸（接既有槽位）

- `approvals` 表与 `MSG.APPROVAL_REQUEST` / `MSG.APPROVAL_DECISION` 都已存在但**未接线**
  （`runner/lib/shell-tools.js:9` 自述「审批 v1 = 自动执行 + 审计」）。
- MCP 是第一个真实用例：`call` 前判断 `需要审批` 的条件 =
  `exposure === 'hidden'` **或** 工具名命中 `^(delete|remove|drop|purge|privileged|sudo|kill|reset)_`。
- 流程：worker 发 `MSG.APPROVAL_REQUEST` → agentd 落 `approvals` 行（pending）→ portal 供用户在工作台点
  「批准/拒绝」→ 回 `MSG.APPROVAL_DECISION` → worker 继续或返回 `mcp_approval_denied`。
- 超时（10 min）由 portal 打 `expired`（既有口径）；worker 侧超时按拒绝处理。
- **P1 的降级口径**：若审批通道尚未打通（取决于 agentd/portal 侧接线工作量），则 `hidden` 工具**直接不可达**
  （`mcp_tool_hidden`），**绝不自动执行**。这条必须实现，不能留空。

---

## 10. 安全红线（实现时逐条自检）

1. **portal 绝不执行第三方代码**：不 `import()` 技能包、不 spawn MCP server、不「测试连接」。
2. **密钥不落盘到 FDE**：`mcp.json` / `capabilities.json` 里只有槽位声明；值只在 worker 内存里活一次 run。
3. **不记录值**：任何日志/事件/审计/错误详情里不得出现值（包括 `spawn` 失败的 stderr 里可能回显的 env）。
   实现要求：`redact()` 在把 server 配置写日志前先过一遍（按槽位名替换成 `***`）。
4. **`tool call` 永不重试**（可能已执行）；只有 `initialize` / `tools/list` 允许一次重试。
5. **进程组 kill**：`detached: true` + `process.kill(-pid, sig)`，收尾必须执行。
6. **保留名黑名单**（§4.1）不得被绕过（校验在 portal，注入在 runner，两侧都判）。
7. **隐藏就是隐藏**：`hidden` 不进索引段、`list` 里显示但 `search` 不返回其工具（要 call 必须显式指名，
   且必须过审批）。
8. **超时必有上限**：单请求 `timeout_ms`（默认 60 s，≤300 s）；stdio 首帧超时同值。

---

## 11. 测试矩阵（实现即写，缺一条不算完成）

**portal**
- `portal/test/market-mcp.test.js`：transport/slots/reason 校验 10 条负例（含保留名、secret+context 组合、
  非法 exposure/lifecycle、resident≠false、url 非 http(s)、command 含空格）；`kind='mcp'` 安装**不落盘**；
  启用缺槽 409 + `details.missing`；`GET secrets` 不含值；`PUT secrets` 后 `has_value=true`；
  `MCP_SECRET_KEY` 缺失时写值 503、读已有密文仍可解（用测试 key 注入）。
- `portal/test/materializer-mcp.test.js`：`mcp.json` 形状 + 按 name 升序 + 两次渲染逐字节相同 +
  **秘密扫描**（值不出现）+ 空安装为 `{"version":1,"servers":[]}`；`capabilities.json` 的 `mcp` 段
  （`tools_cache` 空/有值两态）。
- `portal/test/secrets.test.js`：加解密往返、AAD 不匹配解不开、key 长度校验、密文被搬移（换 item）解不开。

**runner**
- `runner/test/mcp-client.test.js`：用假传输（注入 `spawnImpl`/`fetchImpl`）覆盖：握手顺序、
  `tools/list` 缓存、`tools/call` 成功/`isError`、单请求超时、`initialize` 失败重试一次而 `call` 不重试、
  `close()` 幂等且发 `stdin.end → SIGTERM → SIGKILL`（假进程记录信号序列）、HTTP `Mcp-Session-Id` 缓存与 404 重握手。
- `runner/test/mcp-tool.test.js`：`list/search/call/status` 四动作；**server 全挂时 `search` 仍从缓存命中**；
  `call` 未知工具报「先 search」；`hidden` 工具：未接审批 ⇒ `mcp_tool_hidden`，接了审批 ⇒ 发 `APPROVAL_REQUEST`
  且拒绝后返回 `mcp_approval_denied`；`signal` 取消传递（断言收到 `notifications/cancelled`）。
- `runner/test/mcp-servers.test.js`：读 `mcp.json` + 内部通道解析值；缺槽 ⇒ 该 server 不注册且返回 `missing`；
  保留名在 runner 侧二次拒绝。
- `runner/test/capability-index.test.js` 扩展：`mcp` 段渲染（含 `tools: []` 未知态）、字节确定、4 KiB 截断。

**前端**
- `AdminMarketView.spec.ts` 扩展：kind=mcp 表单字段组、reason 必选（缺则不发请求）、slots 行增删、
  凭据面板只显示「已设置/未设置」（源码级断言：**不存在**读取值的请求）。
- `MarketView.spec.ts` 扩展：kind 徽标、reason 文案、`secrets_ready=false` 时启用按钮 disabled + 文案、
  **无填值输入框**（DOM 断言）。
- `localeParity.spec.ts`：新增 key 双语成对。

**真机 e2e（主 agent 亲自）**
1. 起一个 **mock MCP server**（stdio node 脚本，暴露 `echo` 工具，回显参数）；
2. admin 发布 `kind='mcp'` 条目（stdio + 一个 `ECHO_PREFIX` 槽，reason=stateful）→ 设置槽值 → 发布；
3. `eric` 安装 + 启用 → 宿主 `~/.erix/mcp.json` 出现该 server 且**不含值**；
4. 会话里 `mcp({action:"list"})` 看到它、`search` 找到 `echo`、`call` 返回 `PREFIX:hello`（证明值注入生效）；
5. 把槽值删掉再启用 ⇒ 409 `capability_secret_missing`；
6. `hidden` 工具：不可达 / 或走审批拒绝（按 §9 的降级口径取证）；
7. 点「停止」与 run 正常结束两种收尾 ⇒ 宿主 `ps` 无残留 mock server 进程（`pgrep -f mock-mcp` = 0）；
8. server 端口/进程被 kill 后再 `call` ⇒ 只降级报错，run 正常结束。

---

## 12. 不做（P2 / P3，附触发条件）

| 项 | 触发条件 |
|---|---|
| **形态②**：FDE 容器内常驻 MCP 服务（agentd 管生命周期/空闲回收/崩溃重启） | 出现「必须跨 run 保住连接」的需求（例：每 run 重连耗时 >5 s，或要 PTY/后台任务） |
| **形态③**：平台侧共享 hub（ssh 类、内部 API 桥、任务队列、配额/幂等、完成回调唤醒 run） | 出现「多 FDE 共享同一服务/凭据」的需求，或 ssh 类要上架 |
| resources / prompts / sampling / elicitation / tasks / MCP Apps | 有具体业务场景（如「读远端文档资源」）再评估 |
| codemode 类脚本执行器 | 先有「脚本工具」能力 |
| OAuth | 上游 server 只支持 OAuth 且业务必须用 |
| 技能子进程隔离 | 出现「技能 hang 住打死 run」的真机事故（ADR-008 现状不变） |

---

## 13. 设计依据：pi 两套实现的对照（为什么是这两个旋钮）

| 决策点 | pi 内置 MCP | pi-mcp-adapter v7 | 我们的选择 |
|---|---|---|---|
| 工具面 | 每 server `exposure ∈ {codemode(默认), deferred, direct, hidden}` + `toolExposure` 通配 | 一个 `mcp` 代理工具（≈200 token）+ `scriptTools` | **一个 `mcp` 工具**；`exposure` 保留 direct/deferred/hidden（无 codemode） |
| 进程 | session 启动拉起**全部** enabled，跑到 session 结束 | 首次调用才启，闲置 10 min 停；`lazy-keep-alive` 可保活 | 形态①：**run 内**懒启、run 收尾全停；`lifecycle` 字段为 P2 预留 |
| 上下文告知 | `mcp_servers` 段（每 server 一行 description），变更时**追加**不重写（保缓存） | 同 | `capabilities.json` 的 `mcp` 段 + 索引段（沿用字节确定） |
| 元数据 | 连接后拉 `tools/list` | metadata-cache（停掉也能 search） | **DB 缓存 + runner 回填**（portal 不连 server） |
| 凭据 | `mcp.json` env / `!command`；OAuth 落 JSON 文件 | OAuth 进 OS keychain | **平台注入**（加密入库，内部通道现取，容器内不落盘） |
| 重试 | resources 遇 408/429/5xx 重试一次；**tool call 不重试** | 同 + failure-backoff | 同（连续失败 ≥3 次本 run 内熔断） |
| 长结果 | >20 KB 掐中间 + 全文落临时文件 | 同 + `extract` | 同（`/tmp/erix-mcp/`） |
| 危险工具 | 交给权限扩展 | 内置 `approveTools` | 接既有 `approvals` 槽位；未接线则 `hidden` 直接不可达 |
| 装 server | `pi mcp add` + `/reload` | 对话里 `install by URL` | **只给管理员**（发布流程）；用户只能装已发布条目 |

**不照搬的三条**：`install by URL`（等于给用户任意代码执行 + 任意出网）、OAuth/keychain（容器里没有，
且与「凭据只在平台」冲突）、session 启动全拉起（我们是 per-run worker，且 pi 的实测是 100 server = 7 GB）。
