# 工单 · P2 门户读侧：子 run 名册 + 账本两个只读端点

> 派单：主 agent。日期 2026-11-08。分支 `feat-261108-02-delegate-p2`（从 P1 合并后的 main 切）。
> **设计文档（必读）**：`docs/design/delegation-2026-11-08.md` §3（落盘布局）+ §5（本节契约）。
> 本单只做 **portal 后端**。**不碰** `runner/`、**不碰** `portal/frontend/`、零 DDL、零新事件类型。

## 0. 前置

```bash
npm ci --prefer-offline
cd portal/frontend && NODE_ENV=development npm ci --prefer-offline   # 只有跑前端测试才需要；本单不跑
```

测试：`timeout 600 npm test`（根）。判绿 = 退出码 0。

## 1. 落盘布局（P1 已实现，本单只读）

```
<userSpaceRoot>/<fde>/home/delegation/
├── roster/<parentRunId>/<childRunId>.json
├── leases/slot-<i>.lock            ← 本单不读
└── transcripts/<childRunId>.jsonl
```

- `<userSpaceRoot>` = `config.userSpaceRoot`（`portal/src/config.js:298`，容器内 `/srv/erix/users`）。
- `<fde>` = 会话属主的 `users.fde_name`（`portal/src/sessions.js:217-223` 的既有取法）。
- **注意**：这与 `portal/src/dirs.js` 的 jail 根（`projects/<name>`）**不是同一棵树** ⇒ **不要**复用
  `resolveJailedFile`（它的 jail 根不对）。本单新建一个窄解析器（见 §2.1）。

## 2. 新文件 `portal/src/delegation.js`

### 2.1 路径解析（安全红线，必须先写测试）

```js
export function delegationRoot({ userSpaceRoot, fdeName })      // <userSpaceRoot>/<fde>/home/delegation
export function rosterDir({ userSpaceRoot, fdeName, parentRunId })
export function transcriptPath({ userSpaceRoot, fdeName, childRunId })
```

- `parentRunId` 必须匹配 `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`（uuid）。
- `childRunId` 必须匹配 `^sub-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`。
- 不匹配 ⇒ 抛 `DelegationError('validation_failed', …, { details: { field } })`（400）。
- 拼完 `path.resolve` 后**断言前缀仍在 `delegationRoot` 之下**（防 `..`；两个 id 已被正则锁死，这是第二道）。
- **绝不接受**调用方传路径片段（只接受两个 id）。

### 2.2 `listDelegates({ pool, sessionId, userId, parentRunId, userSpaceRoot })`

1. **归属**：`fetchSession` 同口径 —— `sessionId` 必须属于 `userId`，否则 `404 not_found`
   （**与不存在同一个错误**，不泄露存在性）。复用 `portal/src/sessions.js` 已有的查询或照抄它的 SQL。
2. **parentRunId 归属**：`SELECT 1 FROM runs WHERE id = $1 AND session_id = $2`，无行 ⇒ `404 not_found`。
3. **读名册**：`fs.promises.readdir(rosterDir)` → 只取 `*.json` → 逐个 `JSON.parse`，
   **坏文件跳过**（收集到 `skipped`，不 500）。目录不存在 ⇒ `{ items: [] }`（**不是 404**）。
4. **DTO**（逐字段白名单，**不许把整条 roster record 原样下发**）：

```js
{
  childRunId,          // record.runId
  state,               // queued|running|completed|failed|aborted|timeout|interrupted
  cwd,                 // record.cwd ?? null
  model,               // record.model ?? null
  createdAt, endedAt, updatedAt,   // number（ms）
  termination,         // record.termination（**字符串**：引擎 reason，P1 已把 no_tool/continuation_exhausted 归一成 end_turn）
  errorMessage,        // record.errorMessage ?? null
  resultTruncated,     // record.resultTruncated === true
  hasTranscript,       // fs.existsSync(transcriptPath)
}
```

返回 `{ items: [...] }`，按 `createdAt` 升序。

### 2.3 `getDelegateTranscript({ ..., parentRunId, childRunId, tail = 100 })`

1. 归属与 §2.2 第 1/2 步相同。
2. **childRunId 必须出现在该 parent 的名册里**（`roster/<parentRunId>/<childRunId>.json` 存在），
   否则 `404 not_found`（**不许**只凭 id 形状就读盘）。
3. 读 `transcripts/<childRunId>.jsonl`：
   - 不存在 ⇒ `404 not_found`（`details.reason = 'no_transcript'`）。
   - 大小 > `8 * 1024 * 1024` ⇒ `413 payload_too_large`（`details.size`）。
   - 逐行 `JSON.parse`，坏行跳过；空行跳过。
4. 投影（**必须用本站既有的两份，不要自己拼**）：
   ```js
   import { foldLedgerRecords } from './transcript-fold.js';   // 本站超集镜像（含 partOf 解链）
   import { projectTranscriptForDisplay } from 'erix-agent';     // 包根导出（已验）
   const turns = projectTranscriptForDisplay(foldLedgerRecords(records));
   ```
   ⚠ **`foldLedgerMessages` / `foldMessageRows` 不在 `erix-agent` 的导出面**（实测 `undefined`，
   `src/store/message-rows.js` 是内部模块，深引被 `exports` 挡）⇒ 用本站 `portal/src/transcript-fold.js`
   的 `foldLedgerRecords(records, { keyOf })`。它就是 `runner/lib/store.js#load` 用的同一份口径
   （两份 `SHARED-FOLD-CORE` 逐字节对拍，见 AGENTS §8.52），并且是上游读侧的**超集**（解 `partOf` 链）。
   这也是本站读侧折叠的**唯一**落点：`session-view.js` 走 `foldTranscriptRows`（DB 行），本单走
   `foldLedgerRecords`（文件记录）——**两条入口共用同一份 `planFold`**，不是两套规则。
5. **切尾必须在投影之后**：`turns.slice(-tail)`（先截断原始行会破坏折叠，见设计 §5.1）。
   ⚠ 更准确地说：**必须先 `foldLedgerRecords` 再 `projectTranscriptForDisplay` 再切尾** ——
   在原始行上切会把一轮切成半轮（`:msg:` 分片与载体行分散），折叠会拿到缺片的一轮。
6. DTO：每个 turn 加宿主字段（**不覆盖**上游字段）：

```js
{ id: `${childRunId}:${index}`, seq: index, run_id: childRunId,
  created_at: turn.ts ? new Date(turn.ts).toISOString() : null, ...turn }
```

返回 `{ childRunId, state, messages, truncated: turns.length > tail, totalTurns: turns.length }`。

`tail` 校验：整数 1..500，越界 `validation_failed`（`details.field='tail'`）。

### 2.4 成本红线（写成测试）

- 名册目录不存在 ⇒ **零 transcript 读**。
- `hasTranscript` 用 `existsSync`，**不许**为了填这个字段去读文件内容。
- transcript 读取用**流式**（`createReadStream` + 行切分）或先 `stat` 再读；**不许**无上限 `readFileSync`。

## 3. `portal/src/http.js`（两个路由 + 鉴权）

```
GET /api/sessions/:sessionId/delegates?runId=<parentRunId>
GET /api/sessions/:sessionId/delegates/:childRunId?runId=<parentRunId>&tail=100
```

- 挂在既有 `/api/sessions/:id/...` 分派里（照 `events/history` 的写法），**必须**走既有会话鉴权。
- `runId` 缺失/形状非法 ⇒ `400 validation_failed`（`details.field='runId'`）。
- 错误码**只用既有的**：`not_found` / `validation_failed` / `payload_too_large`。**零新错误码**。
- 审计：**不写**（只读端点，与 `/api/sessions/:id` 同口径）。

## 4. 文档

`docs/api/portal.md` 加一节（照 §4.x 格式）：两个端点的请求/响应、DTO 字段表、
`state` 七值枚举、错误码、`tail` 边界、以及**一句红线**：
「`state` 是名册词汇（7 值），`termination` 是引擎 reason（P1 已把 `no_tool` / `continuation_exhausted`
归一成 `end_turn` ⇒ 名册 `completed`）。UI 分级以 `termination` 为准、过 `lib/terminationReasons.ts`，
**不要**只看 `state`」。

## 5. 判据（每条都要能红）

1. **跨用户不可见**：B 用户拿 A 的 sessionId ⇒ `404`，且响应体与「session 不存在」逐字相同。
2. **跨会话不可见**：同用户的另一个 sessionId + 本 session 的 parentRunId ⇒ `404`。
3. **childRunId 必须在名册里**：伪造一个形状合法但名册没有的 id ⇒ `404`，**且没有读 transcript 文件**
   （用 spy 或注入 fs 断言）。
4. **坏名册文件不 500**：写一个 `{"oops"` 进去 ⇒ 200，`skipped >= 1`，其余项正常。
5. **投影与主对话同形**：给一个真引擎形状的账本（含 `:msg:` 分片行 + 一轮多工具），
   断言投影出 1 条 user + 1 条 assistant，`toolCalls` 带结果，`run_id === childRunId`。
   **并且**加一条**折叠口径**用例：造一个 0.23 链式 `partOf`（`msg:1:3 → msg:1:2 → msg:1:1`）
   ⇒ `foldLedgerRecords` 必须折回 1 条聚合 `tool_result`（撤掉 `portal/src/transcript-fold.js` 的
   解链闸就该红——这是 AGENTS §8.52 那条既有保证在本入口的复验）。
6. **切尾在投影之后**：`tail=1` 时仍得到最后一条**完整**逻辑消息（不是半条）。
7. **超大文件 413**：伪造 9 MiB 文件 ⇒ `413 payload_too_large`。
8. **路径穿越**：`runId=../../etc` ⇒ `400 validation_failed`，**零 fs 调用**。
9. **名册目录不存在**：`{ items: [] }`，200。
10. **`hasTranscript` 不读内容**：注入 fs spy，断言只调了 `existsSync`/`stat`。

## 6. 不许做

- 不碰 `runner/`、`portal/frontend/`、`docs/data/schema.sql`、`deploy/migrations/`。
- 不加新事件类型、不加新错误码、不写审计、不加依赖。
- 不把 roster record 原样下发（白名单）。
- 不做缓存层（P3 再说）。

## 7. 交付纪律

- 里程碑提交：① 路径解析 + 测试；② `listDelegates`；③ `getDelegateTranscript`；④ 路由 + 文档。
- 收尾写 `P2-REPORT.md`（第一格 `## 取证边界`），给基线数字 + 10 条变异结果 + `git diff --numstat`。
- 不 push、不开 PR。
