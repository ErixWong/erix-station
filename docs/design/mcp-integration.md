# MCP 通道 P1 —— 设计契约（issue #608）

> 定位：**MCP 是「有状态能力」的载体，skill 是「一次函数调用」的载体**。本文只写 MCP 通道本身；
> 市场通用契约在 [`capability-market.md`](capability-market.md)，技能包规范在
> [`skill-authoring.md`](skill-authoring.md)。
>
> 范围：**P1 只做形态①（run 内 stdio / 远端 HTTP）**。形态②（FDE 容器内常驻）与形态③（平台侧共享 hub）
> 在 §12 明确不做，只留字段与触发条件。

**版本**：v2（2026-11-17）。v1 经 copilot 只读审计给出 10 条必修，全部已吸收；
审计结论与逐条处置见 issue #608 的评论（v2 变更表）。

---

## 0. 结论先行（8 条）

1. **上游零改动**。MCP 走 notes / shell / skills 已用的同一条宿主缝：
   `createXxxTools()` → `{schemas, executeTool}` → `worker.js` 的 `baseToolSchemas` + 一条执行路由。
   `erix-llm-kit/docs/requirements.md:45` 把 MCP 列为永久非目标 ⇒ 客户端由宿主自写。
2. **凭据一律平台注入**（用户决策）：加密存 portal，**平台管理的文件里不出现值**，run 启动时**由 agentd 代取**
   （worker 不持 per-container token，见 §6.1），只在 worker 内存里活一次 run。
3. **工具面默认只加一个 `mcp` 工具**（list/search/call/status）；`exposure='direct'` 的工具**额外展开成独立工具**
   （§4.3 给出两个取值的**可观察差异**，否则这个旋钮就是死配置）。
4. **`exposure='hidden'` 在 P1 = 装了但不生效**（不物化、不进缓存、不进索引段、不可调）。
   原因是**审批通道尚未交付**（`agentd.js:1157-1160` 现在对 `APPROVAL_REQUEST` 一律回 denied；
   审批 API/UI 明确未交付）⇒ P1 采取 **fail-closed**：危险工具只能标 hidden，不做「弹窗批准」。
5. **进程组必须由 agentd 回收**：MCP 子进程 `detached:true` 自成进程组，**不随 worker 组退出**；
   复用 #288 已建的「子进程组登记 + 所有终止路径补杀」机制（`runner/agentd.js:931-938,1027-1030`）。
6. **`tool call` 永不重试**（可能已执行）；只有 `initialize` / `tools/list` 允许一次重试。
7. **元数据缓存随 `mcp.json` 物化**（direct 带 `inputSchema`，deferred 只带 name/description），
   所以冷启动即可 `search`；首次发现由 `list` 对空缓存 server 触发一次 `tools/list` 并回填 DB。
8. **迁移是新文件 `0040-mcp-channel.sql`**，不改 `0039`、不改 `docs/data/schema.sql` 的 baseline。

---

## 1. 协议事实（客户端最小集 + 传输细节）

| 传输 | 帧 | 生命周期 |
|---|---|---|
| **stdio** | 换行分隔 JSON-RPC 2.0；stderr 单独收（保留末 4 KiB 供报错） | 子进程，`detached:true`（自成进程组） |
| **streamable HTTP** | `POST`，请求头 `content-type: application/json`、`accept: application/json, text/event-stream`；响应可能是 JSON 或 SSE | 远端服务 |

握手与调用（**只实现这些**）：

```
initialize                {protocolVersion:"2025-06-18", capabilities:{}, clientInfo:{name:"station-runner",version}}
notifications/initialized
tools/list                → {tools:[{name, description, inputSchema}]}
tools/call                {name, arguments} → {content:[{type:"text",text}...], isError?}
notifications/cancelled   {requestId, reason}     ← 用户点停止时发
```

**HTTP 细节（必须实现，别留给实现者猜）**

- 协议版本协商：客户端发 `2025-06-18`；服务端回不同版本时**接受服务端的**（记日志），不重试。
- 响应 `Mcp-Session-Id` ⇒ 缓存并在后续请求带 `mcp-session-id` 头；`404/410` ⇒ 清缓存**重握手一次**
  （仅此一处重试）。
- SSE 解析：逐帧读 `data:` 行，遇到与请求 `id` 匹配的 JSON-RPC 响应即结束；`event:` 行忽略（我们不用 stream 事件）。
- 超时：单请求 `timeout_ms`（默认 60 s，1..300000）；**超时后 abort 连接，不重试**。
- 重定向：`fetch` 默认跟随（≤3 跳），跨 origin 时**丢弃 `Authorization` 等注入头**（防凭据被重定向带走）。
- **URL 策略**：只允许 `http` / `https`（`file:`/`gopher:`/`data:` 一律 400）。私网/回环地址**允许**
  （内部 hub 就是私网），但管理台保存时给一行提示「容器内 `127.0.0.1` 指容器自己」。
  URL 只能由管理员配置，用户面不可传。

**不实现**：resources / prompts / sampling / elicitation / tasks / MCP Apps / OAuth（§12）。

---

## 2. 三种形态（这张表决定一切）

| 形态 | 谁持有进程 | 生命周期 | 能保住什么 | P1 |
|---|---|---|---|---|
| **① run 内** | worker（一 run 一 fork，`agentd.js:1106`） | run 结束 kill 进程组 | 本次 run 内的连接/会话 | ✅ |
| **② FDE 容器内常驻** | agentd（跨 run） | 空闲回收 / 崩溃重启 | 跨 run 的连接、会话、PTY、后台任务 | ❌ P2 |
| **③ 平台侧共享 hub** | 平台（跨 FDE） | 平台运维 | 跨 run + 跨 FDE，凭据与审计集中、配额 | ❌ P3（#609） |

**反例入库**：`touwaka/data/skills/erix-ssh`（frozen draft，`is_resident: 1`）自述等四样东西
（常驻进程契约 / 权限边界 / 凭据处理 / 用户可见审计）——**没有一样属于「包」**。
⇒ skill 包禁止常驻/会话/持久化形状（`skill-authoring.md` §5，发布校验硬拒）。

`resident ∈ {false, container, platform}` 字段占位，**P1 只接受 `false`**，其余 `409 capability_kind_unsupported`。

---

## 3. 数据模型（`deploy/migrations/0040-mcp-channel.sql`）

复用 `capability_items`（`kind='mcp'`）+ `fde_capability_installs`。新增两张表。

```sql
-- MCP 条目的 manifest 形状（jsonb，不新增列）：
-- {
--   "transport": "stdio" | "http",
--   "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"],   // stdio 必填
--   "url": "https://srch.erix.vip/mcp",                                        // http 必填
--   "exposure": "direct" | "deferred" | "hidden",
--   "lifecycle": "run" | "run-keep-alive",
--   "resident": false,
--   "reason": "tool_surface_gt_12",
--   "timeout_ms": 60000,
--   "tools_cache": [{"name":"…","description":"…","inputSchema":{…}?}],   -- runner 回填（§6.6）
--   "tools_cache_at": "2026-11-17T00:00:00Z"
-- }

CREATE TABLE IF NOT EXISTS capability_params (
  item_id     uuid NOT NULL REFERENCES capability_items (id) ON DELETE CASCADE,
  name        text NOT NULL,                    -- 注入名：^[A-Z][A-Z0-9_]{0,63}$
  kind        text NOT NULL CHECK (kind IN ('config','secret')),
  inject      text NOT NULL CHECK (inject IN ('context','env','header')),
  required    boolean NOT NULL DEFAULT true,
  description text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, name),
  -- secret 不许进 context（那是技能进程内面，等于把密钥交给技能代码）
  CHECK (kind <> 'secret' OR inject IN ('env','header'))
);

CREATE TABLE IF NOT EXISTS capability_param_values (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id         uuid NOT NULL REFERENCES capability_items (id) ON DELETE CASCADE,
  name            text NOT NULL,
  scope           text NOT NULL CHECK (scope IN ('global','fde')),
  fde_id          uuid REFERENCES users (id) ON DELETE CASCADE,
  value_encrypted bytea NOT NULL,               -- iv(12) || tag(16) || ciphertext
  updated_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (item_id, name) REFERENCES capability_params (item_id, name) ON DELETE CASCADE,
  CHECK ((scope = 'fde') = (fde_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS capability_param_values_global_uq
  ON capability_param_values (item_id, name) WHERE scope = 'global';
CREATE UNIQUE INDEX IF NOT EXISTS capability_param_values_fde_uq
  ON capability_param_values (item_id, name, fde_id) WHERE scope = 'fde';
```

**没有 `default_value` 列**（v1 的设计漏洞：声明了却无处落地）。`config` 槽的值同样由管理员填，
「本地兜底」写在技能/客户端代码里（`context?.secrets?.X ?? 'http://localhost:8080'`）。

### 3.1 加密口径（`portal/src/secrets.js`）

- `aes-256-gcm`；key = `MCP_SECRET_KEY`（`deploy/.env`，base64 的 32 字节，**无默认值**）。
- 存储 `iv(12) || tag(16) || ciphertext`；**AAD = `${item_id}:${name}:${scope}:${fde_id ?? ''}`**
  （v1 漏了 `fde_id` ⇒ 跨 FDE 搬移密文仍能解开；v2 必须包含）。
- **只写不读**：API 只回 `{name, kind, inject, required, has_value, updated_at, updated_by}`。
- **没有 key 时**：`has_value` 仍可读（那是元数据）；**任何解密/注入一律失败** ⇒ 该 server 视为
  `missing slots`（不注册、不可启用），并记一条 `secret_key_missing` 的运维日志（不含值）。
- 换 key ⇒ 旧密文不可解 ⇒ 槽位显示「未设置」，管理员重填。**不静默失败**。

---

## 4. 配置槽、组合矩阵与准入

### 4.1 声明校验（portal 侧，`validateMcpFields`）

| 字段 | 规则 | 拒绝码 |
|---|---|---|
| `name` | `^[A-Z][A-Z0-9_]{0,63}$`，item 内唯一，不得命中保留名 | `capability_slot_invalid` |
| `kind` | `config` \| `secret` | 同上 |
| `inject` | 见 §4.2 矩阵 | 同上 |
| `required` | 布尔 | 同上 |
| `description` | 非空 | 同上 |

**保留名**（两侧都判：portal 校验 + runner 注入前再判）：`PATH` `HOME` `NODE_OPTIONS` `LD_PRELOAD`
`LD_LIBRARY_PATH` `PYTHONPATH` `PYTHONSTARTUP` `HTTP_PROXY` `HTTPS_PROXY` `NO_PROXY` `ALL_PROXY`
`NODE_EXTRA_CA_CERTS` `SSL_CERT_FILE`，以及 `ERIX_*` / `STATION_*` / `SKILL_*` / `MCP_*`。

### 4.2 组合矩阵（v1 只约束了 `secret+context`，不够）

| 条目 kind | transport | 允许的 inject |
|---|---|---|
| skill | — | `context`（**唯一**） |
| mcp | `stdio` | `env`（**唯一**） |
| mcp | `http` | `header`（**唯一**） |

`secret` 额外规则：不得 `context`。任何组合不在表内 ⇒ `400 capability_slot_invalid`（`details` 带
`{transport, inject}`）。这样「stdio 却要 header」这种配置在发布期就被拒，不会拖到运行期才发现。

### 4.3 两个旋钮的可观察差异（v1 的死配置问题）

| exposure | 物化（`mcp.json`） | 工具面 | 上下文成本 |
|---|---|---|---|
| **`direct`** | 该 server 的每个工具**带完整 `inputSchema`**（单 server schema 总量 ≤ 64 KiB，超出降级为 deferred + warn） | **展开成独立工具** `mcp__<server>__<tool>`，模型可直接调（省一次 search 往返） | 每个工具 ≈200 token/轮，**计入 direct 预算 ≤8 个** |
| **`deferred`**（默认） | 只带 `{name, description}`（**无 inputSchema**） | 只有网关工具；必须先 `search` 拿到 schema 再 `call` | 0（只有网关工具固定成本） |
| **`hidden`** | **不物化**（server 与工具都不出现） | 不可达（`mcp_tool_hidden`） | 0 |

`direct` 的工具名映射：`mcp__<server>__<tool>`（与 pi 内置 MCP 同构，便于日后迁移）；server 名与工具名里的
非 `[a-zA-Z0-9_]` 字符替换为 `_`，冲突时该工具降级为 deferred（warn）。

### 4.4 准入理由（MCP 必填）

`reason ∈ {stateful, tool_surface_gt_12, shared_quota, credential_boundary}`；缺失 ⇒
`400 capability_reason_required`。理由进 DTO 与 UI。`skill` 带 reason ⇒ 忽略。

### 4.5 skill 包红色形状（本单同时补，`validateBundle` 硬拒）

`detached: true` · 模块级 `setInterval(`/`setTimeout(` · `listen(`/`createServer(` · `node-pty`/`pty.spawn` ·
写包外持久目录（`~/.erix/`、`/var/`、`/srv/` 出现在写调用参数里）· 声明常驻（`is_resident` / `resident: true`）
⇒ `400 capability_package_shape`。

---

## 5. 物化（两处，都由 materializer 生成）

### 5.1 `~/.erix/mcp.json`（**平台管理文件里不出现值**）

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
      "slots": [{ "name": "GITHUB_TOKEN", "inject": "env", "required": true }],
      "tools": [{ "name": "create_issue", "description": "创建 issue" }]
    },
    {
      "name": "searxng-hub",
      "transport": "http",
      "url": "https://srch.erix.vip/mcp",
      "exposure": "direct",
      "lifecycle": "run-keep-alive",
      "timeout_ms": 60000,
      "slots": [{ "name": "AUTHORIZATION", "inject": "header", "required": true }],
      "tools": [{ "name": "search", "description": "搜索", "inputSchema": { "type": "object" } }]
    }
  ]
}
```

- **只取 `state='published'` 且该 FDE `install.enabled=true` 的条目**（三处都判：物化、内部通道、执行入口）。
- `exposure='hidden'` **整条不出现**。
- 按 `name` 升序，逐字节确定；无安装 ⇒ `{"version":1,"servers":[]}`；root:root 0644。
- **秘密扫描用例**（`user-space.md` §4.1.2）：`materializer.test.js` 断言文件里不出现值形状。

### 5.2 `~/.erix/capabilities.json` 增加 `mcp` 段

```json
{ "version": 1,
  "skills": [ ... 原样 ... ],
  "mcp": [ { "name": "github", "description": "GitHub 仓库与 PR 操作", "exposure": "deferred", "tool_count": 2 } ] }
```

- **只放 name / description / exposure / tool_count**，**不放工具名**（工具名进上下文就是几百 token；
  工具清单在 `mcp.json` 里，runner 读得到）。
- 与 skills 段**共享 4 KiB 上限**：先渲染 skills（原行为不变），剩余预算给 mcp 段；mcp 段超预算则按 name
  截尾并写「（还有 N 个 server 未列出）」。**skills 段永不被 mcp 挤掉**（P0 行为不回退）。

---

## 6. runner 侧实现

### 6.1 取值通道：**worker 不持 token，由 agentd 代取**

事实（审计核实）：`runner/agentd.js:1089-1102` 的 `buildWorkerEnv` **删除** `ERIX_STATION_TOKEN`；
per-container token 只属于 agentd。⇒ v1 的「worker 直调 `/api/internal/*`」**做不出来**。

v2 方案（新增 IPC，两条消息）：

```js
// worker → agentd
MSG.MCP_CONFIG_REQUEST  { req_id, run_id }
// agentd → worker（agentd 用自己 token 调 GET /api/internal/mcp/servers，只回本次 run 需要的数据）
MSG.MCP_CONFIG_RESPONSE { req_id, ok, servers:[…含明文槽值…], missing:[{name,slots}] }

// worker → agentd（元数据回填；agentd 代发 POST /api/internal/mcp/tools-cache）
MSG.MCP_TOOLS_CACHE     { req_id, slug, tools:[{name,description,inputSchema?}] }
```

- 明文值**只经 IPC 内存传递**，agentd 不写盘、不写日志（脱敏规则见 §10.3）。
- agentd 侧对 `MCP_CONFIG_REQUEST` 的实现要点：用 `ctx.config` 里的 token 发 HTTP；失败 ⇒
  `{ok:false, error}`，worker 侧降级为「本次 run 无 MCP」（`MSG.LOG warn`），**不打死 run**。
- 一次 run **只取一次**（run 启动时），不做热更新（改了市场配置 ⇒ 下一次 run 生效，与技能同口径）。

### 6.2 模块划分与签名

```
runner/lib/mcp-client.js   传输层：stdio / http（握手、超时、会话、取消、close）
runner/lib/mcp-tool.js     工具面：网关工具 + direct 工具展开 + 元数据索引 + hidden 拒绝
runner/lib/mcp-servers.js  组装：读 ~/.erix/mcp.json + 经 IPC 取值 → 交给 pool
runner/agentd.js           代理：MCP_CONFIG_REQUEST / MCP_TOOLS_CACHE + 进程组登记回收
runner/worker.js           接线：装配、执行路由、run 收尾 closeAll、reviewOnly 排除
```

```js
// mcp-client.js
export function createMcpClient({ server, resolved, log, spawnImpl, fetchImpl })
// → { name, exposure, lifecycle, tools,                       // tools 来自 mcp.json 的缓存
//     listTools({signal}) → [{name,description,inputSchema}],
//     callTool(tool, args, {signal}) → { text, isError, truncated, fullPath },
//     status() → {state, error?}, close() → Promise<void> }   // 幂等

export function createMcpPool({ servers, missing, log, spawnImpl, fetchImpl })
// → { get(name), list(), directTools(), closeAll() }

// mcp-tool.js
export function createMcpTool({ pool, log })
// → { schemas: [MCP_GATEWAY_SCHEMA, ...directSchemas], executeTool(name, input, ctx) }
//   ctx: { signal, runId }；direct 工具名形如 mcp__<server>__<tool>
```

### 6.3 网关工具 schema（固定，不随 server 数变化）

```jsonc
{ "name": "mcp",
  "description": "调用平台配置的 MCP 服务器。list 看有哪些 server；search 找工具（用本地元数据缓存，server 没连也能搜）；call 调工具；status 看连接态。",
  "inputSchema": { "type": "object",
    "properties": {
      "action": { "type": "string", "enum": ["list","search","call","status"] },
      "server": { "type": "string", "description": "server 名（call 时必填）" },
      "tool":   { "type": "string", "description": "工具名（call 时必填）" },
      "args":   { "type": "object", "description": "工具参数，原样透传" },
      "query":  { "type": "string", "description": "search 关键词" } },
    "required": ["action"] } }
```

| action | 行为 | 失败语义 |
|---|---|---|
| `list` | 列 server：`name / exposure / status / 工具数`；对 `tools` 为空的 server **触发一次 `tools/list`**（懒启动）并回填 DB（§6.6） | 单 server 失败只影响该条 |
| `search` | 在**本地缓存**（`mcp.json` 的 `tools`）上做不区分大小写子串匹配（server 名 + 工具名 + 描述）；返回 `server + tool + 一行描述`；`hidden` 永不出现 | 无命中 ⇒ 明说「无命中；若该 server 从未连过，先 `list` 触发发现」 |
| `call` | **必须**给 `server` + `tool`；缓存里该 server 存在该工具才允许（防歧义与越权）；懒启动后 `tools/call` | `mcp_tool_unknown` / `mcp_tool_hidden` / `mcp_call_timeout` / `mcp_unreachable` |
| `status` | 每 server `{state, lastError, toolsCached}`，不触发连接 | — |

**同名工具歧义**：不同 server 有同名工具时，`call` 必须带 `server`；只给 `tool` ⇒
`mcp_tool_ambiguous`（`details.candidates`）。

### 6.4 生命周期状态机（每 server）

```
idle ──list/call 需要元数据或调用──▶ starting ──握手成功──▶ ready
  ▲                                      │失败(1 次重试)      │
  └──── idle（run 内复用；close 由 run 收尾统一做） ◀── error ──┘
```

- `lifecycle='run'` 与 `'run-keep-alive'` 在 P1 **行为相同**（run 内都保活、run 结束都关）；
  字段存在是为了 P2 的形态②不返工——**注释必须写明这一点**，别让下一个人以为是死配置
  （与 `exposure` 不同：`exposure` 在 P1 有真实差异，见 §4.3）。
- `error`：下一次需要时**重试连接一次**；同一 run 内连续失败 ≥3 次 ⇒ 熔断到 run 结束
  （后续调用直接 `mcp_unreachable`，不再烧 30 s 超时）。

### 6.5 上下文注入（L3 扩展）

`runner/lib/capability-index.js` 增加与「平台技能」并列的一段：

```
## 平台 MCP 服务（能力市场）
- github — GitHub 仓库与 PR 操作；工具 2 个；用法：mcp({action:"search"}) 找工具后 call
```

- `direct` 的工具**不进这段**（它们已是独立工具，模型直接看得到）；`hidden` 永不出现。
- 四条口径沿用：只来自原文 / 字节确定 / 失败降级 / **与 skills 共享 4 KiB**（§5.2）。

### 6.6 元数据回填（让 `search` 在 server 挂掉时仍可用）

- `mcp.json` 的 `tools` 就是缓存（来自 DB `manifest.tools_cache`）。
- `list` 对 `tools` 为空的 server 触发一次 `tools/list`；成功且与缓存不同 ⇒
  `MSG.MCP_TOOLS_CACHE` → agentd → `POST /api/internal/mcp/tools-cache` → portal 写
  `manifest.tools_cache` + `tools_cache_at` → 下次物化生效。
- 缓存**永不含 `hidden` 的工具**（物化时过滤，DB 保留原始缓存）。
- 为什么不由管理台「测试连接」：**portal 绝不执行/连接第三方代码**（§10.1）。

### 6.7 结果处理

- 拼接 `content[].type==='text'`；`image`/`resource` ⇒ `[image omitted]`。
- **>20 KiB 掐中间**（头 12 KiB + 尾 8 KiB + `…N chars truncated…`），全文落
  `/tmp/erix-mcp/<runId>-<rand>.txt`（容器内，不落用户项目），结果里给路径。
- `tool_result` 额外带 `server` / `tool` 字段（便于 UI 显示来源）。

### 6.8 收尾与进程组（审计必修 7）

- worker 收尾 `finally`：`pool.closeAll()` —— `stdin.end()` → `SIGTERM`（组）→ 200 ms → `SIGKILL`（组）。
- **但 `finally` 覆盖不到 watchdog 的 SIGKILL**（`agentd.js:1027-1030` 已有同款教训）⇒ 必须复用
  #288 的机制：worker 在 spawn 时发 `MSG.MCP_PROCESS {phase:'spawn', pgid, name}`、退出时发
  `{phase:'exit', pgid}`；agentd 维护 `ctx.childPgids`（与 shell 的 `shellPgids` 并列，或合并为
  `childPgids`），在**每一条** worker 终止路径（正常退出 / abort / watchdog / lease_lost）上补杀。
- 判据（真机）：`pgrep -f <mock-mcp>` = 0（正常收尾 + 被 watchdog 杀两种路径都要验）。

---

## 7. portal 侧实现

### 7.1 模块

- `portal/src/secrets.js`（新）：`encryptValue({itemId,name,scope,fdeId,plaintext,key})` /
  `decryptValue(...)` / `resolveSlots({pool, config, item, fdeId})`。
- `portal/src/market.js`（扩展）：
  - `validateMcpFields(fields)`（§4.1/§4.2/§4.4）
  - `validateBundle` 增加 §4.5 红色形状扫描
  - `installCapability`：`kind='mcp'` ⇒ **不落盘**，只写 installs + 排队物化
  - `setCapabilityEnabled`：`kind='mcp'` 且 `enabled=true` ⇒ 先 `resolveSlots`，缺必填 ⇒ 409
  - `resolveMcpServersForFde({pool, config, fde})`：只取 `published && enabled`，`hidden` 跳过
- `portal/src/materializer.js`：`renderMcpJson(servers)`（§5.1）+ `renderCapabilitiesJson` 增 `mcp` 段（§5.2）。

### 7.2 API（`docs/api/portal.md` 新增 §4.18；错误信封沿用 `{error:{code,message,retryable,details}}`）

**管理面**（`/api/admin/market/*`，仅管理台入口）：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/admin/market/items` | `kind='mcp'` 不需要 bundle；字段面 §4 |
| PUT | `/api/admin/market/items/:id` | 改 transport/args/slots ⇒ 必须 bump `version` |
| GET | `/api/admin/market/items/:id/secrets` | `{item:{slots:[{name,kind,inject,required,has_value,updated_at,updated_by}]}}`（**永不含值**） |
| PUT | `/api/admin/market/items/:id/secrets` | `{scope:'global'|'fde', fde_id?, values:{NAME:"…"|null}}`；`null` = 删除该值 |

**用户面**（`/api/market/*`）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/market/items` | 每条带 `kind / reason / exposure / secrets_ready` |
| POST | `/api/market/items/:slug/install` | `kind='mcp'` ⇒ 只写绑定（缺凭据允许安装，不可启用） |
| POST | `/api/market/items/:slug/enabled` | 缺必填槽 ⇒ `409 capability_secret_missing`（`details.missing`） |

**内部通道**（`/api/internal/*`，**仅 agentd 调用**，per-container token）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/internal/mcp/servers` | `{servers:[…resolved…], missing:[{name,slots}]}`；含明文值；审计只记 server/slot 名 |
| POST | `/api/internal/mcp/tools-cache` | `{slug, tools:[…]}` ⇒ 写 `manifest.tools_cache` |

### 7.3 错误码（新增）

| 码 | HTTP | 场景 |
|---|---|---|
| `capability_reason_required` | 400 | MCP 缺准入理由 |
| `capability_slot_invalid` | 400 | 槽位名/kind/inject/组合矩阵不合法 |
| `capability_secret_missing` | 409 | 启用时缺必填槽（`details.missing`） |
| `capability_package_shape` | 400 | skill 包命中 §4.5 |
| `secret_key_missing` | 503 | 写值但 `MCP_SECRET_KEY` 未配置 |
| `mcp_unreachable` / `mcp_call_timeout` | 502 / 504 | 运行期（不进市场 API） |
| `mcp_tool_unknown` / `mcp_tool_ambiguous` / `mcp_tool_hidden` | 运行期工具错误 | 见 §6.3 |

---

## 8. 前端

### 8.1 管理台（`AdminMarketView.vue` 扩展）

- 发布/编辑：`kind` 切换。`kind='mcp'` 时字段组 =
  `transport` · `command`+`args`（stdio）/ `url`（http）· `exposure`（三档，带一行解释）·
  `lifecycle` · `timeout_ms` · **`reason`（必选下拉）** · `slots` 可增删行（name/kind/inject/required/description，
  `inject` 由 `transport` 自动锁定并显示只读说明）。
- 详情新增「凭据」区：每槽 `name / kind / has_value / updated_at` + 「设置」modal（写入后只显示「已设置」）；
  **没有任何读取入口**（源码级断言：不存在 `GET` 值字段的消费）。
- 工具清单区：`manifest.tools_cache` + `tools_cache_at`；为空时写「还没有 FDE 连过这个 server」。

### 8.2 用户面（`MarketView.vue` 扩展）

- 卡片加 `kind` 徽标 + `reason` 的 i18n 文案（不显示英文枚举）。
- MCP 卡片：`exposure` + 工具数；`secrets_ready=false` ⇒ 启用按钮 disabled + 「等待管理员配置凭据」。
- **没有填值输入框**。

### 8.3 i18n

`market.kind.{skill,mcp}` · `market.reason.{stateful,tool_surface_gt_12,shared_quota,credential_boundary}` ·
`market.mcp.{secretsPending,exposure:{direct,deferred,hidden},toolsUnknown}` ·
`admin.market.secrets.{title,set,hasValue,missing,keyMissing}` · `admin.market.form.mcp.*`。

---

## 9. 审批：P1 不做，改为 fail-closed（审计必修 6）

- 事实：`agentd.js:1157-1160` 对 `APPROVAL_REQUEST` **一律回 denied**；审批 API/UI 未交付；
  `approvals` 表要求 `tool_call_id` 关联**已存在**的 `tool_calls` 行。
- ⇒ **P1 不实现运行时审批**。危险工具只能标 `exposure='hidden'`（不物化、不可达）。
- 明确写下：**审批通道（API + UI + IPC 落库顺序）是 P2 的前置**，并在 `#609` 的开工前置里列出。
- 绝不允许「因为没接审批所以先自动执行」——这是 fail-open，红线。

---

## 10. 安全红线（实现逐条自检）

1. **portal 绝不执行/连接第三方代码**：不 `import()` 技能包、不 spawn MCP server、不「测试连接」。
2. **平台管理文件不持久化值**：`mcp.json` / `capabilities.json` / `manifest` / 日志里只有槽位声明。
   （诚实表述：stdio server 与 HTTP 请求**必须**拿到明文才能工作 ⇒ 它是凭据的受信接收方；
   「FDE 磁盘上不出现值」指平台管理的文件，不含 server 自己的行为。）
3. **不记录值**：日志/事件/审计/错误详情不得含值；`redact()` 在写日志前按槽位名替换为 `***`；
   **canary 测试**：设置 `CANARY_<rand>` 值，跑一次 list/call 后 grep 全部日志与 run_events，命中即失败。
4. **`tool call` 永不重试**；只有 `initialize` / `tools/list` 允许一次。
5. **进程组回收**：`detached:true` + `MSG.MCP_PROCESS` 登记，agentd 在全部终止路径补杀。
6. **保留名两侧都判**（portal 校验 + runner 注入前）。
7. **`hidden` 三处都挡**：物化不出现、`search` 不返回、`call` 直接 `mcp_tool_hidden`。
8. **超时上限**：`timeout_ms` ≤ 300 s；stdio 首帧超时同值。
9. **stdio 子进程环境收窄**：不继承 worker 全量 env，只给白名单
   （`PATH` `HOME` `LANG` `TZ` `TMPDIR`）+ 槽位值；`ERIX_*`/`STATION_*` 一律不传。

---

## 11. 测试矩阵（缺一条不算完成；标注「反向」的必须能因实现退化而红）

**portal**
- `market-mcp.test.js`：transport/slots/reason 负例 12 条（保留名、`secret+context`、`stdio+header`、
  `http+env`、非法 exposure/lifecycle、`resident≠false`、url 非 http(s)、command 含空格、slots 重名…）；
  `kind='mcp'` 安装**不落盘**（断言 `skills/` 目录未变）；启用缺槽 409 + `details.missing`（**反向**：补齐后可启用）；
  `GET secrets` 不含值（**反向**：响应 JSON 里 grep 明文 = 0）；`PUT secrets` 后 `has_value=true`；
  无 key 时写值 503 且**解密路径不可用**（server 进 missing）。
- `secrets.test.js`：加解密往返；**AAD 跨 FDE 搬移解不开（反向）**；换 item 解不开；key 长度校验。
- `materializer-mcp.test.js`：`mcp.json` 形状 + name 升序 + 两次渲染逐字节相同 + **秘密扫描（canary 不出现）**；
  `hidden` 整条不出现（**反向**）；空安装 `{"version":1,"servers":[]}`；`capabilities.json` 的 `mcp` 段
  只含 name/description/exposure/tool_count（**断言不含工具名**）+ skills 段在预算紧张时不被挤掉（**反向**）。

**runner**
- `mcp-client.test.js`：握手顺序；`tools/list` 缓存；`call` 成功 / `isError`；单请求超时；
  `initialize` 失败重试一次而 `call` **不重试（反向）**；`close()` 幂等且信号序列
  `stdin.end → SIGTERM → SIGKILL`；HTTP `Mcp-Session-Id` 缓存与 404 重握手；
  **重定向跨 origin 丢弃注入头（反向）**。
- `mcp-tool.test.js`：四动作；**server 全挂时 `search` 仍从缓存命中（反向：删缓存则无命中）**；
  `call` 缺 `server` / 未知工具 / 同名歧义 三种拒绝；`hidden` 工具 `mcp_tool_hidden`（**反向**）；
  `direct` 工具展开成独立 schema 且 `executeTool` 能路由（**反向**：改回 deferred 则不展开）；
  `signal` 取消（断言发出 `notifications/cancelled`）。
- `mcp-servers.test.js`：读 `mcp.json` + IPC 取值的成功/失败两态；缺槽 ⇒ 不注册 + `missing`；
  **保留名在 runner 侧二次拒绝（反向）**。
- `capability-index.test.js` 扩展：`mcp` 段渲染；**与 skills 共享 4 KiB 时 skills 不被截断（反向）**；
  空 `mcp` 段 ⇒ 输出逐字节等于 v1（**反向**，防回归）。
- `agentd-mcp.test.js`：`MCP_CONFIG_REQUEST` 走 token 代理（假 fetch）；失败 ⇒ 降级不打死 run；
  `MCP_PROCESS` 登记后 watchdog kill 会补杀该 pgid（**反向**：不登记则不杀）。

**前端**
- `AdminMarketView.spec.ts`：kind=mcp 字段组；`reason` 缺失不发请求；slots 增删；`inject` 随 transport 锁定；
  凭据面板只显示「已设置/未设置」+ **源码级断言不存在读值请求**。
- `MarketView.spec.ts`：kind 徽标；`secrets_ready=false` ⇒ 启用禁用 + 文案；**无填值输入框（DOM 断言）**。
- `localeParity.spec.ts`：新 key 双语成对。

**真机 e2e（主 agent 亲自）**
1. 起 **mock MCP server**（stdio node 脚本，暴露 `echo` + `delete_all` 两个工具，`ECHO_PREFIX` 从 env 读）；
2. admin 发布 `kind='mcp'`（stdio + 槽 `ECHO_PREFIX`，`exposure=deferred`，reason=stateful）→ 设值 → 发布；
3. `eric` 安装 + 启用 → `~/.erix/mcp.json` 出现该 server 且 **grep 不到槽值**；
4. 会话里 `mcp list` → `search` → `call echo` ⇒ 返回 `PREFIX:hello`（证明注入生效）；
5. `list` 触发元数据回填 ⇒ DB `manifest.tools_cache` 有值 ⇒ 下次物化 `mcp.json` 带 tools；
6. 删槽值再启用 ⇒ 409；补齐后恢复；
7. 把该条目改 `hidden` 重新发布 ⇒ 新 run 里 server 不出现、`call` 报 `mcp_tool_hidden`；
8. 正常结束 + 点「停止」+ 造一次 watchdog kill 三条路径 ⇒ `pgrep -f mock-mcp` 均为 0；
9. `direct` 档另建一个条目 ⇒ 工具面出现 `mcp__<server>__echo` 独立工具且可直接调。

---

## 12. 不做（P2 / P3，附触发条件）

| 项 | 触发条件 |
|---|---|
| **形态②**：FDE 容器内常驻 MCP 服务 | 出现「必须跨 run 保住连接」（每 run 重连 >5 s，或要 PTY/后台任务） |
| **形态③**：平台侧共享 hub（#609） | 多 FDE 共享服务/凭据；ssh 类上架 |
| **运行时审批**（API + UI + IPC 落库） | P2 前置；P1 用 hidden fail-closed |
| resources / prompts / sampling / elicitation / tasks / MCP Apps | 有具体业务场景 |
| codemode 类脚本执行器 | 先有「脚本工具」能力 |
| OAuth | 上游只支持 OAuth 且业务必须用 |
| 技能子进程隔离 | 出现「技能 hang 死 run」真机事故（ADR-008 不变） |

---

## 13. 设计依据：pi 两套实现的对照

| 决策点 | pi 内置 MCP | pi-mcp-adapter v7 | 我们的选择 |
|---|---|---|---|
| 工具面 | `exposure ∈ {codemode(默认), deferred, direct, hidden}` + `toolExposure` 通配 | 一个 `mcp` 代理工具 + `scriptTools` | **一个 `mcp` 网关** + `direct` 展开独立工具（`mcp__s__t`）+ `hidden` 不物化 |
| 进程 | session 启动拉起全部 enabled | 首次调用才启，闲置 10 min 停 | 形态①：run 内懒启、run 收尾全停；`lifecycle` 为 P2 预留（P1 两者行为相同） |
| 上下文告知 | `mcp_servers` 段（每 server 一行） | 同 | `capabilities.json` 的 `mcp` 段（name/desc/exposure/tool_count） |
| 元数据 | 连接后 `tools/list` | metadata cache（停掉也能 search） | 缓存物化进 `mcp.json`（direct 带 schema），runner 回填 DB |
| 凭据 | `mcp.json` env / `!command`；OAuth 落文件 | OAuth 进 keychain | **平台注入**：加密入库，agentd 代取经 IPC 给 worker，平台文件不出现值 |
| 重试 | resources 重试一次；**tool call 不重试** | 同 + backoff | 同（连续失败 3 次熔断） |
| 长结果 | >20 KB 掐中间 + 全文落临时文件 | 同 | 同（`/tmp/erix-mcp/`） |
| 危险工具 | 权限扩展 | 内置 `approveTools` | P1：`hidden` fail-closed；审批通道 P2 |
| 装 server | `pi mcp add` + `/reload` | 对话里 install by URL | 只给管理员（发布流程），用户只能装已发布条目 |

**不照搬**：install by URL（= 给用户任意代码执行 + 任意出网）、OAuth/keychain（容器里没有，且与「凭据只在平台」冲突）、
session 启动全拉起（per-run worker + pi 实测 100 server = 7 GB）。
