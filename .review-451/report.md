# 独立评审报告 — erix-station issue #451（AGENTS.md 层级链注入）

评审对象：`5e17d10` / `8b945ab` / `46f9465` / `bb231de` / `805c941`（#449 登录验证码不在范围内，未审）。
仓库 HEAD = `da62928`。**全程只读，仓库内零改动**（结束时 `git status --porcelain` 空输出）。

## 取证边界

**实际打开并读完的文件**（绝对路径）：

- `/home/eric/projects/erix-station/runner/lib/agents-md.js`（362 行全文，分 3 段读完）
- `/home/eric/projects/erix-station/runner/worker.js`（L43 import、L60–112 `SYSTEM_PROMPT`、L396–460 `startRun` 采集段、L725–770 `config.input`）
- `/home/eric/projects/erix-station/runner/test/agents-md.test.js`（373 行全文）
- `/home/eric/projects/erix-station/runner/test/system-prompt.test.js`（L64–247 相关段 + `git show 46f9465` 的完整 diff）
- `/home/eric/projects/erix-station/docs/design/agents-md-layering-2026-11-05.md`（§2 / §4.1 / §4.2 / §4.3–4.6 / §5 / §6 / §7 逐段读）
- `/home/eric/projects/erix-station/AGENTS.md` §8.91（L3366–3455）
- `/home/eric/projects/erix-station/docs/design/user-space.md` L183–184、`docs/design/runner-integration.md` L370
- `/home/eric/projects/erix-station/runner/Dockerfile`（L116–146 COPY 面）、`deploy/docker-compose.yml`（L94–95 / L220 内存上限）

**跑过的命令与退出码**：

| 命令 | 退出码 | 关键输出 |
|---|---|---|
| `node --test runner/test/agents-md.test.js` | 0 | `# tests 20 / pass 20 / fail 0` |
| `node --test runner/test/system-prompt.test.js` | 0 | `# tests 14 / pass 14 / fail 0` |
| `node --check runner/lib/agents-md.js` | 0 | — |
| `node --check runner/worker.js` | 0 | — |
| `git show 5e17d10/8b945ab/46f9465/bb231de/805c941`（含 `--stat` 与 diff） | 0 | — |
| `git log --oneline -- docs/design/agents-md-layering-2026-11-05.md` | 0 | 最后一次改动是 `805c941`（S4 真机结果从未回填） |
| `git status --porcelain` | 0 | 空（我没改仓库） |
| `/tmp/e451/a.mjs`（实验 A–G） | 1 → 修脚本后 0 | 见下 |
| `/tmp/e451/mem.mjs`（内存/耗时扫描） | 0 | — |
| `/tmp/e451/b.mjs`（实验 H–I） | 0 | — |
| `/tmp/lock` 变异实验（副本，仓库未动） | 0 | `node --check worker.js` = 0 |

**BLOCKED**：无。以上路径全部打开成功；未发现打不开的目标，因此没有降级去读 GitHub 公开代码。
夹具全部在 `/tmp`（`/tmp/e451-*`、`/tmp/e451b-*`、`/tmp/e451m-*`、`/tmp/lock`），实验结束自删。
说明：变异实验把 `worker.js` + 两个测试复制到 `/tmp/lock`（`lib` 用软链指向真实 `runner/lib`），该副本自身的基线有 2 条失败（`test 6` / `test 10` 按相对路径读 `portal/**` 读不到）——**我在每次变异前先跑同一副本做对照**，两次失败完全一致，故变异结论不受该噪声影响。

## 结论

**有 1 个 blocker + 3 个 major（另有 6 个 minor）**：核心逻辑与八条硬口径基本对得上、测试全绿，但「绝不抛」在超大文件这条路上是真的破的，且一旦破就把**整个注入（含平台节）**一起丢掉；另外「解码失败 ⇒ 跳过 + note」是一根死光纤，而本单最强调的「采集必须在 `startRun` 内」其实没有锁。修掉 blocker + major 3（改测试）即可接受。

## 发现

### 1. [blocker] 单文件 16 KiB 上限是在**整个文件读进内存并转成 JS 字符串之后**才生效——超大 `AGENTS.md` 会打破内存边界，并在 ≥ ~512 MiB 时真的抛

证据（`runner/lib/agents-md.js`）：

```
198:      stat = fsImpl.statSync(entry.path);       // ← stat 在手，.size 从头到尾没用过
...
223:      raw = fsImpl.readFileSync(realFile);      // ← 整文件读进 Buffer（无长度上限）
...
229:    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
230:    const text = buf.toString('utf8');           // ← 全量解码，且这一行在 :222–228 的 try 之外
...
241:    if (buf.length > maxFileBytes) {             // ← 上限在这里才开始起作用
```

实测（`/tmp/e451/mem.mjs`，稀疏文件 + 首行内容，同一进程内连续测）：

```
size=16MiB  blocks=1 injected=16477B  rss 48→82MB  (delta 34MB)   80ms
size=64MiB  blocks=1 injected=16477B  rss 83→184MB (delta 101MB)  323ms
size=256MiB blocks=1 injected=16478B  rss 184→587MB(delta 403MB)  1240ms
cjk 200MiB  ok rss 470→819MB 2114ms truncated=true
```

实测抛（`/tmp/e451/a.mjs` 实验 A，600 MiB）：

```
A: file=629145600B 耗时=573 rss 48→677MB result=ERR_STRING_TOO_LONG @ at Object.slice (node:buffer:640:37)
```
（第一次跑未包 try 时整个脚本以 **exit 1** 崩在这里：`Error: Cannot create a string longer than 0x1fffffe8 characters … at collectAgentsMd (…/agents-md.js:230:22)`。）

**故障半径**（实验 A2，超限的是**项目节**、平台节正常）：

```
A2(项目节超限): ERR_STRING_TOO_LONG → 平台节是否还在=false
```

即：采集器整体抛出 ⇒ `runner/worker.js:424-434` 的兜底把**整段**置空（`agentsMdSection = ''`）⇒ 这一 run 连 9 KB 平台节都不注入，只留一条 warn。

影响：
1. 违反硬口径 6「任何读取失败降级为跳过 + note，**绝不抛**」——`:230` 就在 read 的 try 之外；`agents-md.js:17` 的模块抬头与 `worker.js:415` 都写着「失败一律降级」。
2. 16 KiB / 48 KiB 的口径**不约束成本**：一个 256 MiB 的文件让 worker 在 `runToolLoop` 之前多花 1.2 s 与 +403 MB RSS，而注入的只有 16 KB。FDE 容器默认 `mem_limit` = 4 g（`deploy/docker-compose.yml:220` `FDE_MEMORY_LIMIT: ${FDE_MEMORY_LIMIT:-4g}`），容器内 400 MB 量级的瞬时分配叠加在跑着 dev server 的容器上——**OOM kill 是不可 catch 的**，那正好是 §4.5/§8.91 反复要避免的「worker 死 → requeue → attempts exhausted」。
3. 抛出去的那一支即使被 worker 兜住，也把「一份坏文件」放大成「整个功能对该 run 静默消失」，与规则 5「平台节必须完整」的方向正好相反。

建议修法：`stat.size` 已在 `:198` 拿到，先在 `:209` 附近判 `stat.size > maxFileBytes`，超限就走 `openSync` + `readSync(fd, buf, 0, maxFileBytes + 4, 0)` 只读前缀（或 `createReadStream` 取前 16 KiB），别整文件进内存；顺带把 `:229-230` 挪进 `:222` 的 try 里，让「解码」也在降级范围内。加一条用例：`AGENTS_MD_MAX_FILE_BYTES × 40`（≈ 640 KiB）的文件 ⇒ `truncated === true` 且**不整文件读**（可用注入 fs 门面断言 `readFileSync` 没被调用／或断言只分配定长 Buffer）。

### 2. [major] 「解码失败 ⇒ 跳过 + note」是死光纤：非 UTF-8 / 二进制文件被当正文注入，且一条 note 都不记

承诺（`docs/design/agents-md-layering-2026-11-05.md:193`，规则 6）：

```
6. **失败隔离**：任何 `EACCES` / `EISDIR` / 解码失败 ⇒ 该份跳过 + note，**绝不让 run 失败**。
```

实现（`runner/lib/agents-md.js:229-231`）：`buf.toString('utf8')` 是 lossy 解码，**永远不会失败**，所以「解码失败」这一支在代码里不存在；全文也没有 `TextDecoder`/`fatal` 之类的判据（`grep -n "TextDecoder\|fatal" runner/lib/agents-md.js` 无输出）。

实测（实验 B：`home/AGENTS.md` 正常 + 项目节是 `[0x23 0x20 0xE6 0xA0 0x87 0xE9 0xA2 0x98 0x0A FF FE 00 41 80 81 0A]`）：

```
B: blocks=2 scopes=platform,project notes=[]
B: 注入末块字节=24 含 U+FFFD=true JSON="# 标题\n��\u0000A��\n"
```

影响：一份二进制/GBK/被误命名的 `AGENTS.md` 会把最多 16 KiB 的 U+FFFD（还夹着 `\u0000`）**永久**塞进 system 前缀，每轮都计费；而 note 是空的 ⇒ `agents-md injected: … notes=0` 看起来完全正常，运维与模型都不知道那段是乱码。单测里也没有任何非 UTF-8 夹具（`grep -n "0xff\|Buffer.from(\[" runner/test/agents-md.test.js` 无相关命中）。

建议修法：`new TextDecoder('utf-8', { fatal: true }).decode(buf)` 包 try ⇒ 失败即「跳过 + note（含 `buf` 前 16 字节的 hex）」；或至少 `if (buf.includes(0))` + `U+FFFD` 计数超过阈值 ⇒ 跳过 + note。补一条用例：`Buffer.from([0xff,0xfe])` ⇒ `blocks.length === 0` 且 `notes` 命中「解码」。

### 3. [major] `blocks` 为空时 `subdirHints` 与 `notes` 一起被丢：子目录索引在「最该出现它的形态」里永远不出现，且文档没记这条后果

实现（`runner/lib/agents-md.js:332`）：`if (!Array.isArray(blocks) || blocks.length === 0) return '';` —— 提前返回不看 `subdirHints`/`notes`（`docs/design/user-space.md:184` 与硬口径 8 只承诺「无约定文件时注入段为空串」，没提索引）。

承诺的动机（`docs/design/agents-md-layering-2026-11-05.md:201-203`）：

```
7. **子目录索引**（C 的部分）：… 动机：真实形态是"目录即项目，仓库在其下一层"…
   而仓库自带的 `AGENTS.md` **不在 cwd 的祖先链上**。
```

实测（实验 D1 / H，`/tmp/e451/b.mjs`）：

```
D1: blocks=0 hints(5)=["~/projects/proj/alpha/AGENTS.md","…/beta/…","…/delta/…","…/gamma/…","…/mid/…"]
H: blocks=[] + 2条索引 + 1条note → 渲染长度=0（0 = 索引与 note 全部消失）
```

也就是：项目根**没有** `AGENTS.md`、下面 5 个子仓库各有一份（正是 §4.1 规则 7 的动机形态）⇒ `blocks=[]` ⇒ 渲染 0 字节 ⇒ 索引一条都不出现。反过来，只要根上有一份（哪怕只有一个字节），索引就出现。这条功能在最需要它的目录形态下是关着的。

同时 `runner/worker.js:437-445` 的记账只有 `notes=${agentsMd.notes.length}`（数量，无内容），note 正文在 `blocks=[]` 时又被 `:332` 丢掉 ⇒ 那次 run「什么都没注入」的真实原因（cwd 不可用 / EACCES / 越界 / 全链挤光）在 system 和日志里都查不到，只剩一个数字。

影响：口径 7 与口径 8 是**真冲突**，实现按 8 裁了，但 `AGENTS.md` §8.91 与 `user-space.md` 都写成「7 条口径全部落地」，没有任何地方记这个取舍；`§6.3 已知的"这次测不到"` 也只记了「子仓库正文不注入」。
建议修法（二选一，别什么都不做）：① 放开 `:332`——`blocks` 空但 `subdirHints` 非空时仍渲染「子目录索引」小节（代价：那类 run 的 system 变一次，且要同步改 `agents-md.test.js` 的「空 blocks ⇒ 空串」用例的语义边界）；② 维持现状，但在 §7/§8.91/`user-space.md:184` 各补一行「子目录索引只在至少注入了一份文件时才出现」，并把 worker 的 info 日志改成带前 2 条 note 摘要（仍是 `MSG.LOG`，不新增事件类型）。

### 4. [major] 接线锁①/锁③ 钉的是「文本位置」，钉不住「采集必须在 `startRun` 内」——本单最强调的不变量其实无锁

承诺（`runner/worker.js:411-412`，同样写在设计稿 §2.2 L126-128）：

```
⚠ **必须在 startRun 里采集**：同一个 worker 进程会被 agentd 复用给下一个 run…⇒ 提到模块顶层 = 第二个 run 沿用第一个 run 的内容
```

实现的两条锁都是"位置比较"，不判词法包含：

```
runner/test/system-prompt.test.js:240-242
  const startRunAt = src.indexOf('async function startRun(');
  assert.ok(src.indexOf('collectAgentsMd(') > startRunAt, …);
runner/test/agents-md.test.js:356-362
  const body = src.slice(startRunAt);
  const collectAt = body.indexOf('collectAgentsMd(');
  const tryAt = body.lastIndexOf('try {', collectAt);
```

变异实验 C（`/tmp/lock`，把整段采集原样移到文件末尾的**模块顶层**，`startRun` 里只留 `if (agentsMdOk) { sendIpc … }`；`node --check` = 0）：

```
=== 变异 C 下两套测试 ===
# tests 14  # pass 12  # fail 2      ← 与「未变异副本」的对照输出逐字相同（同样 2 条：test 6 / test 10，副本读 portal 相对路径所致，与变异无关）
# tests 20  # pass 20  # fail 0      ← agents-md.test.js 全绿
```

对照（同一副本、未变异）：`not ok 6` / `not ok 10` 一致 ⇒ 差分为零。

影响：把采集提到模块顶层（= 设计稿点名的老账形状，`§8.64 steerArmed` 同型）**34 条测试一条都不红**。锁①的名字「且在 `async function startRun(` 之后」说的就是它实际检查的东西，但用例正文与 `worker.js:411` 的注释写的是「必须在 startRun **内部**」——注释比锁强，正是本项目反复出的「承诺 X、代码不保证 X」。
建议修法：把「内部」判死——先取 `async function startRun(` 到与之配对的 `\n}` 的函数体（`worker.js` 里 `startRun` 是 2 空格缩进、以 `\n}` 收尾，可用 `\n\}` 定界），再断言 `collectAgentsMd(` 与 `renderAgentsMdSection(` 的 index 都落在该体内；再加一条语义锁：采集调用必须出现在 `const { task, cwd } = msg;`（`worker.js:406`）**之后**——用了 `msg.cwd` 才可能是 per-run 的。

### 5. [minor] 「采集与渲染各包一层 try/catch」没被钉：把渲染移出 try，全测仍绿

`runner/worker.js:416-417` 与设计稿 L200 都写「采集与渲染在 worker 侧还各包一层 `try/catch`」；实测变异 B（`agentsMdSection = renderAgentsMdSection(agentsMd);` 移到 try/catch **之后**）：

```
=== 变异 B 下 ===
# tests 14 / pass 12 / fail 2   ← 与对照一致
# tests 20 / pass 20 / fail 0   ← 接线锁③ 全绿（它只检查 collectAgentsMd 之前的 try 与之后的 catch）
```

锁③（`agents-md.test.js:359-368`）只在 `collectAgentsMd(` 前后找 `try`/`catch`，渲染挪出去它看不见。影响小（`renderAgentsMdSection` 没有实际抛点），但承诺与判据不重合。修法：在锁③里加一句 `assert.ok(startBody.indexOf('renderAgentsMdSection(') < startBody.indexOf('} catch'), …)`，或让渲染也在同一 try 内并被同一正则覆盖。
（顺带：`agents-md.test.js` 的锁③对「等价重构」是宽容的——把 `agentsMd = collectAgentsMd(…)` 改成 `const collected = …; agentsMd = collected;` 也是 20/20 绿，这点是好的，不算 brittle。）

### 6. [minor] `realpath` 校验与实际读取之间有 TOCTOU 窗口；用例措辞比实现保证的更强

```
runner/lib/agents-md.js:211      realFile = fsImpl.realpathSync(entry.path);   // 判定
216:      if (!isInside(realFile, boundary)) { … continue; }
223:      raw = fsImpl.readFileSync(realFile);                                   // 读：中间无 O_NOFOLLOW、无二次校验
```

实测（实验 E，用 fs 门面模拟「检查完成后 target 被换成 home 之外」）：

```
E: 换前含OUTSIDE=false 换后含OUTSIDE=true 换后notes=[]
```

即检查之后换掉 symlink 指向 ⇒ home 之外的内容照样进 system，且没有任何 note。而用例的断言文案是「symlink 逃出 home 的内容**一个字节都不许注入**」（`agents-md.test.js:156`），比实现保证的（检查时刻的形状）强。真实影响有限（同容器、用户自己的文件、注入进他自己的 prompt），但值得在注释里把口径写准。修法（择一）：`openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW)` + `fstatSync` 比 inode；或 read 之后再 `realpathSync` 复核一次；或把用例文案与 `:217` 的注释改成「以检查时刻的形态为准」。
（同一实验里两个更硬的形状是对的：双层符号链接 `cwd/AGENTS.md → chain-b.md → /etc/passwd` 被越界跳过并记 note；自环符号链接 ⇒ `跳过 …：ELOOP`，未抛。）

### 7. [minor] 16 KiB 是「正文上限」不含截断 marker，与 48 KiB 全链上限的算法不一致

实测（实验 G）：

```
G: 恰好16384B → bytes=16384 truncated=false | 16385B → bytes=16474（注入超出单文件上限 90B，marker 不记账）
G3: 3×16384B totalBytes=49152 超48KiB=false blocks=3 notes=0
```

单文件那一支（`agents-md.js:241-249`）先按 `buf.length` 判、再把 marker 追加进 `body`；全链那一支（`:262-267`）却是按含 marker 的 `b.bytes` 累加的。不影响正确性，只是同一份文档里的「上限」两种口径。修法：在 `AGENTS_MD_MAX_FILE_BYTES` 的注释里写明「正文 16 KiB，marker 另计」，或判定时用 `maxFileBytes - markerReserve`。

### 8. [minor] 去重的 sha 是**原始字节**的 sha ⇒ BOM/CRLF 差异让去重失效，同一段规则注入两遍且无 note

```
runner/lib/agents-md.js:232      const sha = crypto.createHash('sha256').update(buf).digest('hex');   // 对原始字节
```

实测（实验 C：`home/AGENTS.md` = BOM + `# platform\n- 收工即提交\n`；`home/projects/AGENTS.md` = 同一内容但 CRLF）：

```
C: blocks=2 notes=[]
C: 首块前 6 码点=feff,23,20,70 次块含 \r=true
```

（原文直通是对的、也符合「不解析、不改写」；问题只在**去重键**用了未规范化的字节。用户用带 BOM 的编辑器把平台那份抄到 `~/projects/AGENTS.md`，就会得到双份规则，`notes=0` 完全看不出。）
修法：展示仍用原文，但 sha 改对「`buf` 去掉前导 BOM + `\r\n`→`\n` + 首尾空白裁剪」后的字节计算；`truncated` 的判据仍用原始 `buf.length`。

### 9. [minor] 文档三处与代码/事实不一致

1. **真机验收状态互相打脸**：`AGENTS.md:3433` 写「已如实记在设计稿 §7 的 S4 行」，但设计稿 `docs/design/agents-md-layering-2026-11-05.md:353` 的 S4 行是「`⬜ 未做（需要重建 FDE 镜像 + 真 run，本单不 push 也不起容器）`」——而 §8.91 L3417-3431 明确记录了 D1–D4 已在 dev 真机做完（run `b3c9f528…` / `49ad0966…` / 对照 `b14e70a7…`），只有 D5 未做。`git log --oneline -- docs/design/agents-md-layering-2026-11-05.md` = `805c941 / bb231de / 5e17d10` ⇒ S4 的结果从没回填。修法：把 §7 S4 行改成「D1–D4 ✅（数据见 AGENTS.md §8.91）/ D5 ⬜」。
2. **测试格数过期**：`docs/design/user-space.md:184` 写「`runner/test/agents-md.test.js`（**16 格**）」，实际是 20 格（本次 `node --test` 输出 `# tests 20`；`AGENTS.md:3401` 写的是 20 格）。差的是 F1（`805c941`）加的 4 格。
3. **渲染签名与拼接公式过期**：设计稿 §4.2 L208 写 `config.input.system = SYSTEM_PROMPT + '\n\n' + renderAgentsMdSection(blocks)`，实现是 `system: SYSTEM_PROMPT + agentsMdSection`（`worker.js:752`），前导 `\n\n` 由渲染自带（`agents-md.js:329` 注释、`:361` 返回）——照 §4.2 字面写会多一份空行；§4.2 的伪签名 `(blocks)` 也与真实签名 `({ blocks, notes, subdirHints })` 不符（§4.1 L171 已回填、§4.2 漏改）。`docs/design/runner-integration.md:370` 写的是对的。

### 10. [minor] 降级原因没有落点（可观测性）

设计稿 §4.1 规则 1 L181 明说 note「随注入段的「采集记账」小节上浮，不额外发日志」。但发现 3 说明了 `blocks=[]` 时该小节根本不渲染，于是「为什么这次没注入」唯一的痕迹是 `worker.js:444` 的 `notes=${…length}`。修法见发现 3（把前 2 条 note 摘要拼进同一条 info 日志，零新事件类型）。

## 已核对且没问题的点（逐条，八条硬口径 + 其它要求）

1. **口径 1（链由外到内）**：`agents-md.js:124-141` 用 `realpath(cwd)` 逐级 `dirname` 上溯到 `realpath(home)`（含 home）后 `dirs.reverse()`；设计稿 §2.1 L116 明确允许「cwd 之下若还有祖先目录，同规则继续向内」⇒ 实现是设计允许的形状，不是超范围。实测 F：`scopes=platform,project`，顺序由外到内；单测 ①/② 同时钉了 `blocks` 顺序与**渲染**顺序（`agents-md.test.js:66-68`）。
2. **口径 2（scope 三档）**：`scopeOf` `:97-102`：`dir === realHome` ⇒ platform、`=== path.join(realHome,'projects')` ⇒ workspace、其余 project；`realHome` 不可用 ⇒ 全按 project（与 §4.1 规则 2 一致）。实测 F/F2 与单测 ② 一致。
3. **口径 3（不存在 / 空白 / 非普通文件 / sha 重复 ⇒ 跳过）**：`:201` ENOENT 静默、`:204-208` `isFile()` 假 ⇒ note、`:231` `text.trim()===''` ⇒ 静默跳过、`:233-237` 去重**保留靠外那份**并 note。实测 E2/E3（双层链、ELOOP）与单测 ③④⑧⑨ 一致；单测 ③ 还钉了「不存在的层不得留下任何痕迹」（`:100` `doesNotMatch(/projects\/AGENTS\.md/)`），是真判据不是空操作。
4. **口径 4（realpath 越界跳过）**：`:216-220`，越界基准 `boundary = chain[0].dir`（`:185`），`cwd` 不在 home 下时退化为 `cwd` 并记 note（`:188-190`），与 §4.1 规则 4 L186-187 的口径一字不差；`isInside`（`:47-51`）用 `sep` 拼前缀，挡掉 `/a/bc` 冒充 `/a/b`。唯一保留意见见发现 6（TOCTOU）。
5. **口径 5（16/48 KiB，从内层整份挤掉）**：`:262-267` `blocks.pop()` 从尾部（最内层）整份丢并逐份记账；`:268-277` 只在「单份就超全链上限」时截断（默认常量下不可达，注释也这么写）。实测 G3（3×16384 ⇒ 恰好不超限、3 份都在）与单测 ⑤（`limits={200,150}` ⇒ 只剩 platform 且 `truncated=false`、2 条「全链上限」note）一致。截断按 UTF-8 字符边界回退（`utf8Prefix` `:91-95`），实测 G2 截断结果**不含** U+FFFD，marker 里「原 16983 字节，仅注入前 16383 字节；看全文：cat ~/AGENTS.md」是可直接照抄的命令。
6. **口径 6（绝不抛）——常见形状确实做到了**：`statSync`/`realpathSync`/`readFileSync`/`readdirSync`/子目录 `statSync` 全在 try 内（`:197-203`、`:210-215`、`:222-228`、`:283-287`、`:300-304`），`realpathOr` 对非字符串/空串返回 `null`（`:63`）；实测 F2（`cwd='   '` ⇒ `blocks=0` + 一条 note）、E3（ELOOP）、单测 ⑮-⑲（`null`/`{}`/只给一半/非字符串）都不抛。**破口只有发现 1 那一处**（`:230` 全量解码）。
7. **口径 7（子目录索引：排序后取前 5、只列路径不注入正文）**：`:296` 显式 `names.sort()`（注释写明「readdir 顺序不保证 ⇒ 确定性」）、`:298` 到 `maxSubdirHints` 就 break、`:299-305` 只 `statSync` 不 `readFileSync`。实测 D1：7 个候选目录 ⇒ 5 条、字典序升序；D3 补证「符号链接目录不进索引」（`aa-symlinked-repo` 不在结果里，因为 `Dirent.isDirectory()` 对 symlink 为 false）。常量确实锁在 `= 5`（`:44`）。
8. **口径 8（禁时间戳 / run id / generation；无 blocks ⇒ 空串）**：`grep -n "process.env\|Date\.\|new Date\|randomUUID" runner/lib/agents-md.js` **无输出**；`renderAgentsMdSection`（`:331-361`）只拼常量抬头 + `display` 路径 + 原文 + note。实测 I：同进程内交错 100 次两个不同 home 的采集，结果互不污染；`grep -n "^let \|^var "` 在 `agents-md.js` 里**无输出** ⇒ 模块顶层无可变状态，多个 run 并发/复用都不串。
9. **采集在 `startRun` 内**（实现层面确实做到了，虽然锁不牢 = 发现 4）：`worker.js:406 const { task, cwd } = msg;` → `:425 collectAgentsMd({ cwd, home: process.env.HOME || '/home/erix' })`，用的是本 run 的 `msg.cwd`；全文件 `collectAgentsMd(` 恰好 1 处、`renderAgentsMdSection(` 恰好 1 处（grep + `system-prompt.test.js:247-252` 的锁②）。
10. **平台节不可覆盖**：`agents-md.js:313 SCOPE_LABEL.platform = '（平台生成，不可覆盖）'` + 抬头 `:336-337` 明确「冲突按平台节执行，并在回复里告知用户这处冲突」——四句语义（外到内 / 平台不可覆盖+告知 / 不要重复 cat / 本 run 改动下次生效）逐句在 `:336-340`，单测 ⑫ 按语义断言而非字面。
11. **记账走现成 `MSG.LOG`、不新增事件类型**：`worker.js:427-434`（失败 ⇒ `level:'warn'` + 置空）与 `:437-446`（`level:'info'`，`files/bytes/truncated/subdir_hints/notes`，且 `files=0` 也发）。`git show 805c941 --stat` 确认没有新事件类型/新错误码。
12. **不加 env 旋钮**：`agents-md.js:34-36` 只 import `fs`/`path`/`crypto`；`limits` 只从 `options` 取（`:162-167`，`positiveIntOr` 挡 0/负数/非整数）；单测 ⑭ 钉「生产路径不得传 limits」。
13. **既有断言未放宽**：`git show 46f9465 -- runner/test/system-prompt.test.js` 的 hunk 不触及 8 规则词用例（现值 `system-prompt.test.js:256/262`）与 `0.0.0.0` 断言（现值 `:290`）；被替换的只有「先读」→「已注入」那一条，且**新加**了 `不会立刻生效` 与 `开工前先读` 的反向断言（`doesNotMatch`）⇒ 净强度不降。`const SYSTEM_PROMPT = \`…\`;` 声明行（`worker.js:76`/结束于 `:108`）未被改动，抠取器假设仍成立（§4.3 L250 的要求）。
14. **指针段口径**：`worker.js:89` 已改成「**平台约定已随本次 run 注入到本提示词末尾**…不必再 `cat` 它们；本 run 里改动这些文件**不会立刻生效**」，`:91` 保留 `0.0.0.0`，`:93` 保留 `cat ~/.erix/ports.json`（动态清单）并把 `cat ~/AGENTS.md` 降为复核手段——与 §4.3 表格的改法逐条对得上。
15. **部署面**：`runner/Dockerfile:145-146` 是 `COPY agentd.js worker.js ./` + `COPY lib ./lib` ⇒ 新增的 `lib/agents-md.js` 会进镜像（不需要额外改 Dockerfile）；§8.91 的「热 patch 两个文件」与镜像形状一致。
16. **测试全绿且非空操作**：`agents-md.test.js` 20/20（exit 0）、`system-prompt.test.js` 14/14（exit 0）、两个 `node --check` 均 exit 0。用例判据多数钉语义（顺序、去重保留靠外、marker 含原字节数、平台节完整、渲染顺序一致），不是实现细节。

## 未验证 / 证据不足

- **真机 D1–D5**：我没有容器与 `station-db`，只能引用 `AGENTS.md §8.91` 的文字与 run id；没有独立复算「tool_use 含 `AGENTS.md` 的调用数 = 0」「cacheRead 82.3%」这些数。
- **引擎侧 `markStablePrefix` 是否真给 system 打 `cacheBoundary`**：`runner/node_modules/erix-agent/src/loop/provider-runner.js` 未打开（评审范围之外），所以「注入文本逐字节稳定 ⇒ 缓存命中」的前提我只在文档里看到，没有代码级复核。
- **平台节 root:root 不可写**：`portal/src/materializer.js`（`renderHomeAgentsMd()`）未读，「不可覆盖是事实不是约定」只信 §8.91/设计稿 §4.1 规则 2 的陈述。
- **OOM 那一支**：`+403 MB RSS / 600 MiB 抛错` 是实测，「容器 4 g 下会被 OOM kill」是按 `docker-compose.yml:220` 的默认值 + 实测增量的外推，我没有真把容器压到 OOM。
- **并发**：只验了「同进程内交错采集互不污染 + 模块无可变状态」（实测 I + grep），没有跑真·多 worker 进程并发采集的负载。
- **`worker.js` 里 `cwd` 的来源与 jail 是否同源**：只看到 `const { task, cwd } = msg;`（`:406`）与采集用同一个 `cwd`；`createJail({ root: cwd })` 那一处的 `cwd` 是否恒等于 `msg.cwd` 未逐行追（#259 属另单）。
- **变异实验的副本基线**：`/tmp/lock` 副本自带 2 条与 #451 无关的失败（test 6 / test 10 按相对路径读 `portal/**`）。我用「变异前后同一副本输出一致」来抵消该噪声，但这 2 条在真实仓库里是绿的（`node --test runner/test/system-prompt.test.js` = 14/14）。
