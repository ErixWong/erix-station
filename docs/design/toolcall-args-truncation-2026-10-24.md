# qwen3.8-flash-next：tool_calls 参数流被提前截断（args > ~4KB 时）
> **归档说明（2026-10-28）**：本文件与 `-repro.py` 原本躺在**仓库外**的 `fde_station/` 顶层，10-24 之后两周无人
> 问津。现按 AGENTS §8.76 的规矩入仓。追踪单：**erix-station#426**（上游网关侧，本站改不了，本单是观察 +
> 承接）。原始位置：`fde_station/toolcall-truncation-report.md` · `fde_station/toolcall-truncation-repro.py`。
> 复测：`python3 docs/design/toolcall-args-truncation-2026-10-24-repro.py --shape nested --bytes 6000 --reps 3`。

**报告时间**：2026-10-24 15:00 UTC（本地 23:00）
**网关**：`https://api.ai.erix.vip/v1`（nginx/1.29.7 + one-api/new-api，响应头 `X-Oneapi-Request-Id`）
**模型**：`qwen3.8-flash-next`
**上游引擎（据 `system_fingerprint`）**：`vllm-0.30.1rc1.dev558+g0cbac6cd1-pp3-a23a86f6`
**报告方环境**：客户端 pi 1.20（OpenAI `/v1/chat/completions` 流式），复现脚本见本目录 `toolcall-args-truncation-2026-10-24-repro.py`（纯 stdlib，无依赖）

---

## 1. 一句话结论

**同一条 SSE 流里，reasoning 分片正常吐完，`tool_calls` 参数刚开始流（只吐出前 10–31 个字符）就断了：没有 `finish_reason`、没有 `[DONE]`、没有 usage 分片。**HTTP 状态仍是 200。客户端只能判定为流被截断（Node/undici 报 `terminated`）。触发条件是 **工具入参 schema 为「数组套对象」的嵌套形状、且参数字符串较长（≳4KB）**；同样长度的内容换成扁平 schema 则完全正常。

---

## 2. 业务影响

我们一个长会话（连续写代码）里，**只要模型要调用 `edit` 工具（`{path, edits:[{oldText,newText}]}`，newText 是新代码块）就 100% 死在这一处**，客户端重试 3 次也全死在同一处，表现为"这个会话完全无法改文件"。

同一会话内 `bash`（扁平 `{command,timeout}`）、`read`、`grep` 全部正常 → 会话上下文、token 数、客户端都没问题。

统计（我们本地 1.2 万+ 次工具调用，按工具分类的失败率）：

| 工具 | 参数形状 | 成功 | 失败(流截断/连接错误) |
|---|---|---|---|
| `bash` | 扁平 `{command}` | 3672 | 2 |
| `read` | 扁平 `{path}` | 267 | 0 |
| **`edit`** | **嵌套 `{edits:[{oldText,newText}]}`** | **391** | **41** |
| `write` | 扁平 `{path, content}` | 115 | 2 |

失败在时间上从 10-24 12:00 UTC 之后急剧增多（同一小时其他会话还出现 4 次 `Connection error.` 与 `500 {"code":"http_request_failed","message":"请求上游地址失败"}`）。同一天 06:00–08:00 UTC 期间，**同一个 edit 工具、参数量 37 KB 都能正常完成** → 说明这是近期回归/退化，不是我们客户端 schema 一直不兼容。

---

## 3. 最小复现（直接可跑）

```bash
export RELAY_KEY=sk-xxxx
python3 toolcall-truncation-repro.py --shape nested --bytes 6000 --reps 3   # FAIL
python3 toolcall-truncation-repro.py --shape flat   --bytes 20000 --reps 3  # PASS
```

请求体（关键部分，`tool_choice` 用 `required` 以保证必定走工具调用路径）：

```json
{
  "model": "qwen3.8-flash-next",
  "max_tokens": 32000,
  "stream": true,
  "stream_options": {"include_usage": true},
  "tool_choice": "required",
  "tools": [{
    "type": "function",
    "function": {
      "name": "edit",
      "description": "Edit a file with exact text replacement",
      "parameters": {
        "type": "object",
        "properties": {
          "path":  {"type": "string"},
          "edits": {"type": "array", "items": {"type": "object",
                    "properties": {"oldText": {"type": "string"},
                                   "newText": {"type": "string"}},
                    "required": ["oldText", "newText"]}}
        },
        "required": ["path", "edits"]
      }
    }
  }],
  "messages": [{"role": "user", "content": "Call the edit tool with path /tmp/x.js and ONE edit whose newText is exactly the text below verbatim:\n```\n<约 6 KB 的文本>\n```"}]
}
```

### 失败时流的最後几帧（原文，注意 `arguments` 刚开头就没了）

```
data: {"id":"chatcmpl-b04e68c9f765d754",...,"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"/x"}}]},"logprobs":null,"finish_reason":null,"token_ids":null}]}

data: {"id":"chatcmpl-b04e68c9f765d754",...,"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":".js"}}]},"logprobs":null,"finish_reason":null,"token_ids":null}]}

data: {"id":"chatcmpl-b04e68c9f765d754",...,"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":", \"edits\": "}}]},"logprobs":null,"finish_reason":null,"token_ids":null}]}

<此处连接被关闭：没有 finish_reason=tool_calls、没有 data: [DONE]、没有 usage 帧>
```

**注意断点位置**：正好停在 `{"path": "/tmp/x.js", "edits": ` 之后，也就是**即将开始吐嵌套数组第一个元素**的位置。

### 用于定位的失败请求 ID（都是同一 payload，`X-Oneapi-Request-Id`）

| 时间 (UTC) | X-Oneapi-Request-Id | 结果 |
|---|---|---|
| 10-24 14:42:20 | `20261024224219915077284uCIIKgMe` | 流在 args 第 31 字符处断 |
| 10-24 14:57:25 | `20261024225725974201641lF1mAISo` | 同上（args=31，29–41s） |

---

## 4. 控制变量实验（各 3 次）

模型 / prompt / max_tokens / tools 数量全部相同，只改**一个**变量。

### 4.1 参数长度（嵌套 schema，其余不变）

| newText 大小 | 通过 | 观察 |
|---|---|---|
| 0.9 KB | 3/3 | 正常 |
| 1.9 KB | 3/3 | 正常 |
| 2.8 KB | 2/3 | 开始偶发 |
| 3.8 KB | 1/3 | |
| 4.5 KB | **0/5** | 全部 args 停在 10–31 字符 |
| 5.8 KB | **0/3** | |
| 9.9 KB | **0/3** | |

### 4.2 schema 形状（同一段 5.8 KB 文本，只改 schema）

| schema | 结果 |
|---|---|
| 嵌套 `edits:[{oldText,newText}]` | **1/3 通过** |
| 扁平 `{path, content}`（同长度内容） | **3/3 通过** |
| 扁平 `{path, content}`，**20 KB** | **3/3 通过**（77/115/62 s，完整 `finish_reason=tool_calls` + usage） |
| 扁平 `{command}`，**40 KB** | **3/3 通过**（111 s） |

→ **不是总输出长度、不是 SSE 分片大小、不是超时**：40 KB 的扁平参数（生成 111 秒）都能过；6 KB 的嵌套参数 15 秒就断。

### 4.3 拆成多个数组元素也没用

同样 5.8 KB，切成 `edits[0..3]` 4 个元素（每段 1.4 KB）：**0/3 通过** → 决定因素是**嵌套 args 的总长度**，不是单个字段长度。

### 4.4 其它变量（嵌套 + 5.8 KB，均**失败**，即与这些因素无关）

- `reasoning_effort: "none"`（完全关掉思考）→ 仍失败
- 把内容压成单行、去掉所有 `\n` → 仍失败
- 5800 个字符纯 `x`（无结构无换行）→ 仍失败
- 提示词从 1.3k token 加大到 25k token → 只让阈值略微变差（小参数仍 2/3 通过），**不是**主因

### 4.5 非流式

同一请求 `"stream": false` → 12–13 s 后 **`RemoteDisconnected`（连接被关，没有任何响应体）**；网关侧偶发直接返回
`500 {"code":"http_request_failed","message":"请求上游地址失败","type":"system_error"}`。

### 4.6 同网关、同 schema，换模型

| 模型 | 嵌套 schema + 5.8 KB args |
|---|---|
| `qwen3.8-flash-next` | **0/3** |
| `kimi-for-coding` | **3/3 通过**（28–35 s，完整 args + usage） |
| `deepseek-flash` | 请求报错（该 key 无权/不可用，未纳入结论） |

---

## 5. 归因：是网关还是 vLLM？

**目前证据只能推到"网关之后的那条 `qwen3.8-flash-next` serving 通道"，但三条独立证据都指向 vLLM 侧的 tool-call 解析/流式路径，网关大概率只是受害者：**

1. **断点是结构化的，不是字节/时间相关的。** 每次断都停在 `"edits": ` 之后、嵌套数组第一个元素开始之前。反向代理按缓冲/超时截断不会恰好对齐 JSON 结构边界；vLLM 的 tool-call parser（`tool_call_parser`，hermes/qwen 之类）**开始解析数组元素**的位置正是这个点。
2. **同样长度/同样时长的扁平参数 40 KB、111 s 都能完整通过同一条网关连接** → 排除 nginx/one-api 的缓冲、`proxy_read_timeout`、SSE 分片大小这类通用限制。
3. **同网关换模型（kimi-for-coding）同 schema 同长度 3/3 通过** → 排除网关到客户端的链路、排除 schema 本身不被支持。
4. 非流式下是 **`RemoteDisconnected` / 上游 500 `http_request_failed`「请求上游地址失败」**——这是网关连不上/被上游掐断的表现，方向是 **网关 → vLLM**，与"vLLM 处理该请求时 worker/请求级异常退出"一致。
5. 间歇性"偶发能过"（4 KB 档 1/3、2/3）与**多实例/多 worker 路由**一致：某些实例（或某版本实例）有此问题。

**残留不确定性**（我们看不到服务端，无法排除）：网关对这条通道单独配了缓冲或超时；或网关↔该上游之间的中间层（LB/侧车）问题。

### 请上游帮忙做的三个判定实验（任一即可定死）

1. **直连 vLLM 绕过网关**跑 `toolcall-truncation-repro.py --shape nested --bytes 6000`：
   `RELAY_BASE=http://<vllm-host>:<port>/v1`。若同样断 → **vLLM 侧确认**；若完整返回 → 回头查该通道的网关/LB 配置。
2. **查 vLLM 侧日志**（第 3 节两个请求 ID 对应时刻，UTC 14:42:20 与 14:57:25）：请重点看 tool-call / structured-output 解析是否抛异常、请求是否被 retracted、worker 是否重启/OOM。
3. **临时关掉 tool-call 解析**（去掉 `--tool-call-parser`，或换 `--enable-auto-tool-choice` 之外的解析器）再跑同一请求：若不再截断，即为解析器问题，可直接定位到版本 `0.30.1rc1.dev558+g0cbac6cd1`（并请与上一个可用 build 对比——我们 10-24 06:00–08:00 UTC 之前用同一 payload 37 KB 都能跑通，说明是这之间的回归）。

---

## 6. 我们这边的临时规避（不需要上游改动）

1. 让模型把大改动拆成多次小 `edit`：**单次调用 args ≤ ~2 KB**（实测 3/3 稳定）。
2. 整文件重写改用 `write`（扁平 `{path, content}`）：20–40 KB 实测可用。
3. 应急可临时切到 `kimi-for-coding`（该场景 3/3 通过，延迟约 2 倍）。

（注：客户端重试对这个故障**无用**——同一 payload 是确定性的，重试只是重复烧 token。）

---

## 附：本目录文件

- `toolcall-args-truncation-2026-10-24-repro.py` — 复现脚本（Python 3.8+，仅标准库）。`--shape nested|flat|both`、`--bytes`、`--reps`、`--no-stream`、`--raw`（把失败 SSE 原文写到 `failed.sse`）。
  判据：`PASS = 收到 finish_reason=tool_calls 且 args 长度 ≥ 期望的 90%`。
