# 05 · 第一版宏目录（决策：只做 E1 + E5；E2/E3/E4 挂账）

> 状态：可研（2026-11-08）。上游：[09](03-macro-model-and-catalog.md) 的词汇表、[06](03-macro-model-and-catalog.md) 的五格、
> [08](06-execution-and-recovery.md) 的会话口径。本文只回答一件事：**第一版配哪几条宏、每条填什么。**

---

## 1. 先回答「推送完了有什么用」

用户的疑问很具体：**只能知道「推没推」，不知道「issue 处理完没有」，那这条事件有什么用？**
这一节是它的答案；也是 E2 为什么值得留在事件清单（但第一版不配宏）的理由。

### 1.1 事件不回答业务问题，事件只回答「会不会做错决定」

「issue 处理完了吗」是**业务判断**：要读 issue 状态、读代码、读评审意见——那是**语义源**，
简化版明确不做（[04](01-decision-and-feasibility.md) §9）。硬塞进来，得到的是一个永远判不准的源。

E2 回答的是一个**可判定的窄问题**：**这个目录里的改动，有没有被 git 兜住。**
它不声称知道「活干完没有」，只声称知道「东西丢不丢」。

### 1.2 「推送完了」与「issue 处理完了」是两根轴

| 轴 | 谁知道 | 可判定吗 |
|---|---|---|
| 活干完了吗 | 人 / 评审 / 判据 | 只有给了判据才可判定 |
| 改动被 git 兜住了吗 | `git status` + ref 比对 | **纯机械，永远可判定** |

两根轴交叉：

| | 已推送 | 未推送 |
|---|---|---|
| **活真干完了** | 正常收工 | **危险**：活干完了，一断电就没了 |
| **活没干完** | 半成品推上去了（至少没丢） | 正常中间状态 |

⇒ E2 的价值不在右上/左下，在**左上那一格**：活真的干完了、人也以为收工了，但东西没兜住。
这一格正是「不知道就会做错决定」的教科书例子——**他会在第二天打开电脑时发现昨天的活没了。**

### 1.3 所以 E2 有三个用途，只有第二个是「判决级」

1. **收工提醒**（人忘了提交）—— 有用，但只是提醒，一条 cron 也能做。
2. **E1 的反证面**（`judge_done` + `uncommitted`）—— **真正的价值**。
   E1 是**执行者的自报**，E2 是**独立观测**；判决必须独立于执行者（[03](02-event-model-and-verdict.md) §14）。
   E2 是站内**最便宜的独立证人**：一条 `git status`，零模型调用。
3. **交接前的确认**（离开一天/一周前跑一次）—— 用途 1 的变体。

⚠ **判据：只用来发提醒的事件仍然可以是事件，但它不能单独支撑一个工作项。**
E2 单独 ⇒ 一条提醒；E2 + E1 ⇒ 一条判决。所以 M2 里的 E2 **从不单独出现**——
而它整个被决策者 2026-11-08 挂账了（§2），代价见 §2.1。

### 1.4 反过来说：真要做「issue 完成」这个事件需要什么

需要外部 issue 源（Gitea / GitHub API）⇒ 加强版的源适配器，带来凭据、限流、状态映射三件麻烦。
简化版不做。**这不是遗漏，是边界**（[04](01-decision-and-feasibility.md) §9 的分裂轴）。

---

## 2. 决策（2026-11-08，决策者）：第一版只做 **E1 + E5**

> 原话：「我只需要 session 运行的消息（尤其是结束消息），时钟，这两个是必须。其他可以先不考虑。」

⇒ E2 / E3 / E4 **全部挂账**（E4 本来就挂），本文 §3 只留两条宏，M2–M6 保留在文档里但标 ⏸。

**这个切法比六条更干净，原因不是「少做」，是形状完整：**

| 留下 | 事件形状 | 宏引擎要处理的那一类谓词 |
|---|---|---|
| **E1 run 终态** | **边沿**：那一刻发生一次，此后不变 | 「发生了」 |
| **E5 时钟** | **状态**：今天还没 tick 且已过点 | 「现在处于」 |

两种形状各一条 ⇒ **引擎侧一行代码都不少写**（规则表 / 谓词 / 血统 / 可见面四格照旧）。
砍掉的是源，不是骨架。

### 2.1 ⚠ 砍掉 E2 的代价：第一版**没有任何独立于执行者的证人**

E1 是**执行者自报**（引擎说 `judge_done`），E2 是**独立观测**（git 说东西在不在）。
只剩 E1 时，「这次活干完了」这句话只能信执行者。

- 对**通知**这件事完全够用 —— 要的就是「跑完了告诉我一声」，不需要验真。
- 但 **判决层（[03](02-event-model-and-verdict.md)）在第一版完全没有被验证过**：判决枚举、证据坐标、
  `no-op-claim` 全部空转。

⇒ **「宏引擎跑通了」≠「判决层验过了」。** 这两件事不是一回事，将来别混。
想验判决层，最小的一步是把 E2 加回来（M2 是它的最短路径）。

---

## 3. 第一版宏目录（**3 条**）

| # | 宏名 | 锚（作用域） | 事件 + 状态 | 动作 |
|---|---|---|---|---|
| **M1** | `run-terminal-notify` | **会话** | E1 终态（边沿） | A5 站内通知（可选 A4 邮件） |
| **M8** | `run-silence-alert` | **会话** | E1 `run.silent`（**状态**）+ 参数 `threshold` | A5 通知 + 停止链接 |
| **M7** | `scheduled-task` | **用户** | E5 `tick(HH:MM)`（**状态**） | A3 起一个 run（宏会话复用） |

⚠ **作用域口径（与 [07](07-surfaces-and-panel.md) §2.2 一致，一处定稿）**：

| scope | 宏 | 谁 assign | 为什么 |
|---|---|---|---|
| `session` | M1 / M8 | **用户在会话头下拉** | 它盯的是「这个会话里的 run」，会话就是天然边界 |
| `user` | M7 | **管理员在管理台指定给用户** | 定时任务不属于任何会话，它起自己的宏会话 |

**M1 + M8 合起来才是「run 的消息」的完整面**：M1 管「它结束了」（边沿），M8 管「它不说话了」（状态）。
缺 M8 时，最长的那类故障恰好是唯一不会被通知的。理由见 §4.3。

**M7 就是最初那个问题**：「每天定时自动跑一个任务」——可行，前提是
[08](06-execution-and-recovery.md) 那三件（`origin` 标记 / 确定性标题 / jitter 防 `capacity=1` 堆积）
加上 §4.9 的宏会话复用。

### 3.1 挂账（⏸ 保留在文档里，第一版不配）

| # | 宏名 | 挂账理由 |
|---|---|---|
| M2 | `done-but-not-committed` | 依赖 E2（决策者 2026-11-08 砍掉） |
| M3 | `eod-git-sweep` | 依赖 E2 + E5 |
| M4 | `port-drift-notify` | 依赖 E3 |
| M5 | `port-pool-audit` | 依赖 E3 + E5 |
| M6 | `daily-report` | 功能上被 M7 覆盖（M7 是它的通用形态）；差异见 §4.8 末 |

⚠ **M6 被 M7 吸收，不是被丢掉。** 日报 = 「定时任务 + 判据 + 平台落盘」的一个特例；
第一版先做通用形态，日报作为**第一个任务模板**（不是一条独立宏）。

---

## 4. 逐条五格

### 4.1 M1 `run-terminal-notify`（第一版，最便宜的一条）

```
宏：run-terminal-notify
  audience      all
  anchor_type   会话（作用域 = 这个会话里的 run）
  on_state      E1: run.{终态}              ← 平台定的封闭枚举

  参数（写在宏模板里，第一版不给用户改 —— 见 [11](06-execution-and-recovery.md) §9）
    states    enum[]  默认 [failed, capped, aborted, persistence_failed, guard_unverified]
                      可选加 completed（必须显式勾选）
    channel   enum    默认 site，可选 site+email

  action        A5 站内通知
    user        当前用户
    title       "[{{anchor}}] 运行结束 · {{state}}"
    body        "{{evidence}}\n\n{{url}}"
  criteria      （空 —— 通知型不需要判据）
  budget        max_per_day 20 / quiet_hours 22:00-08:00（窗口内合并成一条）
  notify_on_failure true
```

⚠ **`completed` 默认不在 `states` 里。** 每个 run 都通知 = 通知疲劳，用户三天就关掉整个功能。
「成了」是默认预期，「没成」才需要有人知道。要开完成面是**用户显式勾选**，不是默认值。

⚠ **勾选只能在封闭枚举里选**（`states` 的取值集由平台定），用户不能新增终态。
理由同 §4.3：新值 = 没人评审过的 state。

### 4.2 M7 `scheduled-task`（第一版，时钟的唯一消费者）

```
宏：scheduled-task
  audience      all
  anchor_type   用户
  on_state      E5: clock.tick          ← 状态型：今天还没 tick 且已过点

  参数（写在宏模板里；`cwd`/`task`/`at` 属于“这个宏干什么”，不是用户偏好）
    at          time      必填（HH:MM，UTC+8）
    cwd         path      必填，必须落在 userspace 白名单内
    task        text      必填（模板，只许白名单变量）
    maxRounds   int       默认 16，范围 1–100
    jitter      duration  默认 10m，范围 0–30m

  action        A3 起一个 run（宏会话，复用）
  criteria      机械判据（见下）
  budget        max_per_day 1
  notify_on_failure true
```

三条口径：

1. **`on_state` 是状态不是边沿**：判据是「今天没有 `clock:<date>` 的 tick 且现在已过点」，
   不是「现在正好 09:00」。否则机器一忙、进程一重启，那一跳就永远消失了（[09](03-macro-model-and-catalog.md) §14.5）。
2. **`jitter` 不是可选项**：`capacity=1`，几个用户的定时任务撞在同一分钟就是排队。
   默认 ±10m，且**同一用户的多条定时任务必须错开**（按宏 id 散列，不是随机）。
3. **`notify_on_failure` 必须 true**：任务型失败如果只落在一条没人看的会话里，
   就是 [08](06-execution-and-recovery.md) §6 说的第四种静默死法。

⚠ **第一版的 `criteria` 只能是机械的**：产出非空 / 落盘文件存在 / 退出码 0。
语义判据（「这份日报写得对不对」）需要语义源或人工确认，那是加强版。
⇒ 第一版**不许**把「run 是 `judge_done`」当判据 —— 那就是 `no-op-claim`（[03](02-event-model-and-verdict.md) §13）。

**为什么 M6 挂账而 M7 上**：M6 是「日报」这一个具体任务的完整形态（含 A6 平台落盘 + 邮件摘要），
M7 是它的通用骨架。第一版先证骨架；日报降级成 M7 的一个**任务模板**，
等骨架跑通再补 A6 的落盘路径。

### 4.3 M8 `run-silence-alert`（第一版，「超时」这一格）

```
宏：run-silence-alert
  audience      all
  anchor_type   会话（作用域 = 这个会话里的 run）
  on_state      E1: run.silent              ← 平台定的 state，封闭
  predicate     silent_ms >= threshold      ← 宏模板参数（不是 state 的一部分）

  参数（写在宏模板里，第一版不给用户改）
    threshold   duration  默认 15m  范围 1m–2h
    phases      enum[]    默认 [tool_running]  可选 awaiting_llm

  action        A5 站内通知（带「停止这个 run」链接）
    title       "[{{anchor}}] 已 {{evidence}} 没有反馈"
    body        "最后一条事件是 {{state}}；已静默 {{evidence}}\n\n{{url}}"
  criteria      （空）
  budget        每个 (订阅, run, state) 只发一次
  notify_on_failure true
```

#### 为什么阈值是**参数**而不是 state 的一部分

`silent_10m` / `silent_30m` 这种写法（本文上一版就是这么写的）**是错的**：

- `state` 必须封闭（[02](02-event-model-and-verdict.md) §2）：用户每填一个新 N 就造出一个**没人评审过**的新 state，
  且幂等键不可枚举、测试无法穷举
- 不同人对「多久算卡住」的容忍度差十倍 ⇒ 它是**偏好**，不是世界事实

⇒ 正确形态：`state = silent`（平台定，一个值）+ `threshold`（宏模板参数）。
判据：**改它会改变「世界是什么状态」⇒ 平台定；只改变「什么时候叫我」⇒ 宏参数。**
⚠ 两者都不进用户订阅（[11](06-execution-and-recovery.md) §9）：用户只能开/关。

⚠ **幂等键必须含订阅**：`(订阅, anchor, state)`。若只写 `(macro, anchor, state)`，
同一 run 上两个不同阈值的订阅会互相吞（先到的那个占住键，后到的永远不发）。
这也是它与其他宏不同的一点：**状态型 + 参数化阈值的宏，幂等粒度是订阅，不是宏**。

#### 先把「超时」拆成两类（这是本节最重要的区分）

| 类 | 例子 | 谁负责 | 最终形态 | 有通知吗 |
|---|---|---|---|---|
| **A. 失败型超时** | LLM 不回话 / worker 卡死 / 容器死 | 引擎四相超时、agentd watchdog、reaper | **终态** `failed`（或 requeue 后成功） | ✅ **M1 已覆盖**，只是延迟 2–20 分钟 |
| **B. 静默型卡住** | 工具在跑且没有 `timeout_ms` | **没有人** | **永远不会产生终态** | ❌ 今天只变黄 |

⇒ 用户问的「超时」横跨两类：**A 类已经有（只是慢），B 类完全没有。**
M8 补的是 B 类；A 类只需要 M1 的 `failed` 话术里带上「超时」这个 `errorCode`。

⚠ 但 A 类有**一个真空白**：watchdog 重试最多 3 次，最坏 **15–20 分钟**才给第一个终态。
在这段窗口里用户什么都没收到——所以 M8 也值得在 A 类上做**提前量**（见下面的相位阈值）。

#### 站内现在有四套互不覆盖的静默判据，**没有一套会通知用户**

| 判据 | 数据源 | 阈值 | 覆盖 | 覆盖不到 |
|---|---|---|---|---|
| 引擎四相超时 | LLM 请求 | 首字节 240s / 空闲 180s | LLM 不回话 | 工具执行期 |
| agentd watchdog | IPC `lastIpcAt` | `ERIX_AGENTD_WATCHDOG_MS=300000` | worker 死循环/卡死 | **长工具（有心跳保活）** |
| reaper 租约 | claim_token 心跳 | 90s + 15s | 容器/agentd 整体死 | 上面两者 |
| 前端 stall | `run_events` 到达 | 60s | —— | **只是变黄，不发通知** |

⇒ 第四行就是用户要的那个东西，而它今天**只存在于视觉**：没盯着屏幕就什么都不知道。
而「没盯着屏幕」恰好是宏存在的全部理由。

#### 判据必须是「事件序号没前进」，不是「IPC 没动静」

`shell` 工具执行期每 30s 发一条 `shell_liveness` 心跳（`worker.js:593-603` 明写
**「宿主内部信号，绝不得走 emitEvent」**）⇒ 长命令期间 **IPC 一直有、`run_events` 一条没有**。
两种静默量完全不同：

- 按 IPC 判 ⇒ 长工具永远不报（watchdog 也不报，它被心跳保活）
- 按 `run_events` 判 ⇒ 长工具会报，而这正是用户感知到的「没反馈」

⇒ 判据取 **`max(run_events.ts)`**（表上有 `(run_id, seq)` 索引，按 run 一条聚合查询）。

#### ⚠ 参数要带上界：阈值太大时这条宏会**静默失效**

`ERIX_AGENTD_WATCHDOG_MS` 默认 **5 分钟**。worker 真死时 watchdog 杀掉并 requeue，
**新 attempt 的事件序号重新前进 ⇒ 静默计时归零**。所以：

- `awaiting_llm` 相位阈值 ≥ 5 分钟 ⇒ 「worker 真死」那一类**永远走不到**静默告警（被 watchdog 抢先）
- `tool_running` 相位没有这个约束：watchdog 被 `shell_liveness` 心跳保活，**本来就不会动手**

⇒ 两个相位的**建议上界不同**（不是硬拦，而是订阅卡片上明说）：

| 相位 | 建议区间 | 默认 | 超界的后果 |
|---|---|---|---|
| `awaiting_llm`（等模型） | 1m–4m | **默认关**（启用时用 3m） | 引擎 240s 首字节超时已会报错；≥ 5m 时告警可能永远不响 |
| `tool_running`（工具在跑） | 1m–2h | **15m** | 无（这档没人管，多大都安全） |

⚠ **默认只开 `tool_running`**：`awaiting_llm` 那档已经有引擎超时 + M1 兜底，
开了只会多一条与 M1 重复的消息（除非你想在引擎超时机制本身坏掉时也能知道）。

#### 通知里必须能一键停

知道卡住了但没辙 = 没通知。`A7 停 run` 已存在（`POST /api/sessions/:id/stop`），通知里直接给链接。
**但不自动停**：长构建是合法的，自动停会把正常活干掉。

#### 它不是新源

事实对象跟 E1 **是同一个** `run:<id>`，只是 state 从终态换成非终态。
⇒ 一个源可以同时有**边沿 state**（终态）和**状态 state**（静默），区别在求值方式，不在源的身份。
见 [09](03-macro-model-and-catalog.md) §14.7。

### 4.4 M2 `done-but-not-committed`（⏸ 挂账，依赖 E2）

```
宏：done-but-not-committed
  audience      all
  anchor_type   目录（作用域 = 我订阅的项目目录）
  on_state      E1: run.completed（judge_done / end_turn）
                ∧ E2: dir.{uncommitted|unpushed|never_fetched}
  action        A5 站内通知 + A1 回投到触发它的那个会话
    text        "这次跑完了，但 {{anchor}} 还有未兜住的改动（{{state}}）。{{evidence}}"
  criteria      （空）
  budget        max_per_day 10 / 同一 (dir, run) 只发一次
  notify_on_failure true
```

**`∧` 是同一时刻的两个观测，不是两条宏串联。** E2 不自带时机（[09](03-macro-model-and-catalog.md) §14.2），
所以实现上是 **E1 到达时顺手取一次 E2 的快照**，不是等 E2 自己触发。这条区别决定了它便宜：
零新事件、零轮询、零新表。

⚠ **M2 只通知，绝不自动提交。** 自动 commit 会把半成品、`.env`、垃圾文件一起提交，
而且 D9 定过「写一律走 run，且要人点」。**把它做成自动提交 = 用一个更大的问题换掉一个小问题。**

### 4.5 M3 `eod-git-sweep`（⏸ 挂账，依赖 E2 + E5）

```
宏：eod-git-sweep
  audience      all
  anchor_type   用户（作用域 = 我的所有项目目录）
  on_state      E5: clock.tick(18:00) + E2: 任一目录非 synced
  action        A4 邮件 + A5 站内通知（一条汇总）
    to          当前用户（枚举）
    subject     "收工检查 · {{date}}：{{evidence}}"
    text        逐目录一行：{{anchor}} — {{state}} — {{evidence}}
  criteria      （空）
  budget        max_per_day 1 / quiet_hours 命中则顺延到 08:00 首条
  notify_on_failure true
```

⚠ **汇总是硬要求，不是优化。** 10 个目录 = 10 封邮件 = 用户当天关掉这个功能。
一条宏 = 一条消息，多目录在正文里分行。

### 4.6 M4 `port-drift-notify`（⏸ 挂账，依赖 E3）

```
宏：port-drift-notify
  audience      all
  anchor_type   用户
  on_state      E3: port.{assigned_not_listening|listening_not_assigned|duplicate_in_dir}
  action        A5 站内通知（同一 fde 的多条合并成一条）
    body        "{{anchor}}：{{state}} —— {{evidence}}"
  criteria      （空）
  budget        max_per_day 5 / 同一 (port, pid) 只发一次
```

⚠ **`stale` 故意不发。** 观测新鲜度窗只有 45s（#352），进程一退就 `stale`；
把它当事件发 = 每天几十条「某个端口没人听了」。它只在**汇总正文**里作为附注出现。

### 4.7 M5 `port-pool-audit`（⏸ 挂账，依赖 E3 + E5）

```
宏：port-pool-audit
  audience      admin
  anchor_type   管理员
  on_state      E5: clock.tick(每日一次) + E3: 差集非空
  action        A3 起一个 run（宏会话，见 §4.7）
    task        模板：列出全部差集条目，逐条判定「该改应用」还是「该改分配」
    maxRounds   16
  criteria      ① 报告文件存在且非空
                ② 差集每一条都有结论（改应用 / 改分配 / 误报）
                ③ 报告里每个端口号都能回溯到 port_observations 的 pid
  budget        max_per_day 1
  notify_on_failure true
```

**这是唯一「用户点名认可」的任务型宏**（原话：「号池占用这个可以，可以触发审计」）。
它**零破坏性**：只读两张表 + 写报告，不改分配、不改应用。

### 4.8 M6 `daily-report`（⏸ 被 M7 吸收）

```
宏：daily-report
  audience      all
  anchor_type   用户（不是目录 —— 一个人的日报跨多个项目，见 [08](06-execution-and-recovery.md) §5）
  on_state      E5: clock.tick(09:00)
  action        A3 起一个 run（宏会话，复用）
                + A6 平台落盘 ~/reports/daily/{{date}}.md
                + A4 邮件（正文摘要 + 链接，不做附件）
  criteria      ① 报告文件存在且非空
                ② 至少覆盖 1 个目录
                ③ 每条结论都带 evidence 坐标（run id / sha / file:line）
  budget        max_per_day 1 / 单 run 输入上限见 §7
  notify_on_failure true
```

⚠ **输出由平台落盘，不是模型写文件**（[08](06-execution-and-recovery.md) §1）：
模型被 jail 在项目 cwd，它写的文件会把用户的收工灯弄红；平台写 `~/reports/` 不在任何仓库里。

### 4.9 「宏会话」：M7 绕不开的一个概念

run 必须挂在 session 上（`runs.session_id NOT NULL`），所以「文件 + 通知」仍然需要一条会话。
第一版建议：**每个 (用户, 宏) 复用一条宏会话**，`origin = macro:<name>`，标题 `<宏名> · 长期`。

三条理由，第二条是关键的：

1. 每次 tick 开新会话 ⇒ 侧栏被机器人塞满，且**记忆归零**。
2. **复用会话让跨 tick 记忆自动成立**：notes 是 `sessionId` 作用域
   （`<home>/sessions/<sessionId>/notes`），同一会话 ⇒ 昨天写的注今天还在。
   这正好解掉 [08](06-execution-and-recovery.md) §7 那条「跨会话记忆不存在」的硬阻塞。
3. 会话变长的风险可控：宏会话 1 run/天、几轮/run，30 天约 150 轮，
   远低于砖化区间；且读侧折叠已修（#351/#352）。

⚠ **代价如实记**：这是「用一个长会话换记忆」，与 [08](06-execution-and-recovery.md) §3 里
「长会话有砖化风险」的判断**不冲突但也不免费**。真出问题时的退路是「按周切会话」，
不是「每次 tick 开新的」。

---

## 5. 故意不做的组合（比做了什么更重要）

| 组合 | 为什么不做 |
|---|---|
| E1 + A3（run 完再起一个 run） | **回环入口**。要做必须带深度上限 + 血统，第一版不开这个口子 |
| E3 + A7（差集 ⇒ 停 run） | 平台自愈，不是宏（[09](03-macro-model-and-catalog.md) §14.6） |
| E5 + A1（定时往用户会话投一句话） | 污染用户会话；定时要么起 run，要么只通知 |
| **E2 + A3（灯红 ⇒ 自动让 AI 提交）** | **破坏性**：会把半成品/密钥/垃圾一起提交。D9 明确「写走 run 且要人点」 |
| E1 + A8（失败 ⇒ 重建容器） | 平台自愈 |
| E4 + 任何 | 挂账（[09](03-macro-model-and-catalog.md) §14.4） |

---

## 6. 第一版真正要新写的（**四小格**）

| # | 要新写什么 | 量级 |
|---|---|---|
| 1 | **评估循环**：每 N 秒求值一次所有 `level` 谓词（静默 + 定时） | 小 |
| 2 | **宏表 + 执行器 + 幂等**：键 = `(macro, anchor, state, bucket)` | 中 |
| 3 | **通知落地**：A5 需要一个 UI 落点；A4 需要一条「通知用」邮件模板路径 | 中 |
| 4 | **可见面**：「今天为什么没触发」 | 小但**最容易被砍、最不能砍** |

**E1 零新建**：`runs.status` + `termination.reason` 已经在库里，只差一个读它的谓词。
（原第 2 格「E3 差集计算」随 E3 一起挂账。）

**E5 也几乎零新建**：所谓「时钟源」就是评估循环上的一个谓词——
「今天没有 `clock:<date>` 的触发记录 且 现在 ≥ HH:MM」。它不需要 cron 表、不需要定时器，
只需要第 2 格那张幂等表。**静默告警用的是同一个循环。**
⇒ 第一版的真实形状是「**一条边沿源 + 一个评估循环**」，而不是「两个源」。

第 4 格的理由：站内历史上「配置了但没有消费者」的静默失败反复发生（#331 死光纤、#371 事件承接面）。
一个**不触发**的宏和一个**坏了**的宏，在界面上长得一模一样 ⇒ 没有这一格，前面三格都不可信。

---

## 7. 成本口径（必须能在管理台看见）

| 类型 | 每条宏的月成本 |
|---|---|
| 通知型（M1 / M8） | **0 token** |
| 任务型（M7） | 一次 run；实测单 run 输入 **148k–390k token**（[08](06-execution-and-recovery.md) §4） |

- 1 用户 × 1 条定时任务 = 1 run/天 ≈ 30 run/月 ≈ **4.5M–12M token/月**
- 20 用户 ⇒ **90M–235M token/月**

⇒ 宏定义里必须能算出这个数，管理台必须显示它。**否则没人知道自己开了什么。**

---

## 8. 验收：宏引擎自己怎么算「成了」

| 动作类型 | 「成了」的判据 |
|---|---|
| 通知型（A1/A4/A5/A6） | 投递成功（`mailer.send` ok / 站内通知落库）。**空 `criteria` 是正常的** |
| 任务型（A3） | 走 [03](02-event-model-and-verdict.md) 的判决枚举，**不看 run 的 `termination`** |

⚠ **`run finished` ≠ 「宏成功」。** M5/M6 的 `criteria` 不过 ⇒ 判决是 `red` 或 `no-op-claim`，
**即使 run 是 `judge_done`**。这正是 [03](02-event-model-and-verdict.md) 存在的理由：执行者的自报不是判决。

---

## 9. 待定（要决策者拍，别自己定）

1. M1 的 `completed` 面默认关 —— 确认这个默认。
2. M8 的默认值与上下界：默认 `threshold=15m`、只开 `tool_running` 相位 —— 确认；
   `awaiting_llm` 那档默认关（与 M1 重复）也是否同意。
3. A5 站内通知的 UI 落点：工作台顶部？侧栏？还是复用现有的会话列表角标？
4. M7 的时间点与 `jitter`：固定值还是用户自选；`jitter` 默认 ±10m 够不够。
5. 宏会话在侧栏怎么呈现：默认折叠、单独分组、还是干脆不显示（只在通知里给链接）。
6. 第一版是否就这三条（M1 / M8 / M7）—— 注意它们是「一条边沿 + 两个状态」，
   三种事件形状各一，覆盖已经完整。
