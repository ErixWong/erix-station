// issue #421 / #438（切片 B）判据（跨端面）：erix-agent 承诺给宿主的事件全集 vs 本站三处白名单。
//
// 为什么放在 `portal/test`（而不是前端 spec）：这条要同时读**后端源码**与**前端源码**。前端
// vitest 的全局 environment 是 jsdom，读源码只能走 vite `?raw`，而 vite 的 fs 边界不许越出
// `portal/frontend`（issue #349 已为此换过一次写法）。跨边界的结构对账本来就该住在后端侧
// （同 `portal/test/termination-contract.test.js`：那边锁「常量 ↔ 文档枚举表 ↔ 引擎源码」）。
//
// 三处集合各自独立存亡（#288 教训、#371-A 又犯一次）：
//   ① 前端 `useEventStream.ts` 的 `EVENT_TYPES`（EventSource `addEventListener` 的唯一来源）
//      —— 漏 = **实时一条都收不到**（不报错、不警告）；
//   ② 前端 `HISTORY_REPLAY_TYPES` —— 漏 = **刷新后消失**；
//   ③ 后端 `http.js` 的 `HISTORY_EVENT_TYPES` —— 漏 = **刷新后后端根本不下发**。
// 写入侧不过白名单（`internal.js` 直接 `INSERT INTO run_events`），所以「库里没这条」永远不是借口：
// 漏接的事件只是躺在表里没人读。
//
// ⚠ #438 切片 B 改的是**这份清单的来源**：`ENGINE_PROMISED_EVENTS` 不再手抄（手抄清单就是本片
// 要治的病灶 —— 0.29.0 把联合类型从 16 类长到 19 类，手抄那份**不会自己红**），而是从**已安装引擎
// 源码**里解析 `LoopEvent` 的 `@property` 联合类型。解析不到 ⇒ `t.skip` 并写明原因（不许退化成
// 硬抄清单：那就是把「库里存着、没人读」换成「测里抄着、没人管」）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const PORTAL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FE_EVENTS = path.join(PORTAL_DIR, 'frontend', 'src', 'composables', 'useEventStream.ts');
const HTTP = path.join(PORTAL_DIR, 'src', 'http.js');

// ---------------------------------------------------------------------------
// 引擎承诺面：**从已安装引擎源码解析**，不手抄
// ---------------------------------------------------------------------------

/** 定位**装在本 worktree 里的**引擎根目录（与 `runner/test/fold-notes.test.js` C18 同一手法）。 */
function engineRoot() {
  // 不用 `resolve('erix-agent/package.json')`：引擎 `exports` 没列 `./package.json`
  // ⇒ `ERR_PACKAGE_PATH_NOT_EXPORTED`（实测）。解析主入口再向上找包根。
  let dir = path.dirname(createRequire(import.meta.url).resolve('erix-agent'));
  while (dir !== path.dirname(dir)) {
    const pj = path.join(dir, 'package.json');
    if (fs.existsSync(pj) && JSON.parse(fs.readFileSync(pj, 'utf8')).name === 'erix-agent') return dir;
    dir = path.dirname(dir);
  }
  throw new Error('找不到已安装 erix-agent 的包根');
}

/**
 * 解析 `LoopEvent` typedef 上的 `@property {"a"|"b"|…} type` 联合类型。
 *
 * 返回 `{ version, types, source }`；任何一步不成立都**抛错**（调用方据此 skip 并写明原因），
 * 绝不悄悄退回一份手抄清单。
 */
function parseEngineLoopEventTypes() {
  const root = engineRoot();
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const loopPath = path.join(root, 'src', 'loop', 'orchestrator.js');
  if (!fs.existsSync(loopPath)) throw new Error(`引擎源码里没有 ${loopPath}（随包裁剪或改版）`);
  const src = fs.readFileSync(loopPath, 'utf8');
  // 锚点 = typedef 头 + 紧跟的那条 `@property {...} type`。两处都钉，任一处被搬走就抛。
  const typedefAt = src.indexOf('@typedef {object} LoopEvent');
  if (typedefAt < 0) throw new Error('orchestrator.js 里找不到 `@typedef {object} LoopEvent`');
  const tail = src.slice(typedefAt, typedefAt + 4000);
  const union = tail.match(/@property \{([^}]*)\} type/);
  if (!union) throw new Error('LoopEvent typedef 里找不到 `@property {...} type` 联合类型行');
  const types = [...union[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  if (types.length < 8) throw new Error(`解析到的联合类型只有 ${types.length} 项，抽取姿势可疑：${types.join(', ')}`);
  // 发射点扫描面 = 引擎 `src/` 下的全部 `.js`（`attempt`/`recovering`/`recovered` 住在
  // `loop/provider-runner.js`、`run_outcome` 的记录体住在 `loop/judge-record.js` ⇒ 只看
  // orchestrator.js 会把它们误判成「没人发」）。
  const srcFiles = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) srcFiles.push(full);
    }
  };
  walk(path.join(root, 'src'));
  const emissions = srcFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  return { version, types, source: src, emissions, fileCount: srcFiles.length };
}

const engine = parseEngineLoopEventTypes();

/**
 * 引擎承诺给宿主的事件全集。来源（**不凭记忆、不手抄**）：`erix-agent` `src/loop/orchestrator.js` 里
 * `LoopEvent` 的 `@property` 联合类型。上游改这个联合类型 ⇒ 本测红 ⇒ 逼本站重看承接面
 * （#421 那 5 类漏接就是这么找出来的；0.29.0 又从 16 类长到 19 类）。
 */
const ENGINE_PROMISED_EVENTS = engine.types;

/**
 * 引擎**经 `onEvent` 真发、却没进上面那个联合类型**的事件。
 *
 * **0.30.0 起为空集**：0.29 时代这三条（`continuity_injection_skipped` / `continuity_written` /
 * `continuity_write_failed`）经 `onEvent` 真发但漏登记，0.30.0 把三条全补进了 `LoopEvent` 联合类型
 * ⇒ 「联合外真发」这个逃生口今天**没有任何成员**。它作为机制保留（S6 逐条验）：将来上游再漏登记一条，
 * 把名字加进来即可，不必重写判据。
 */
const ENGINE_UNPROMISED_EVENTS = [];

/**
 * **显式豁免表**：订得到、但故意不进时间线也不进回放的类型，必须写理由（#438 口径：
 * 逐类决定「进时间线 / 只订不回放下发 / 显式豁免」，豁免必须写理由）。
 *
 * 三条各自的裁定（每条都能被下面的 S2/S3/S5 反向检查）：
 * · `run_outcome`：每 run 一条的 run 级汇总，与 `run_end`（rounds / 终局）语义重叠，今天没有读者；
 *   放进回放只会让刷新时多一堆没人看的行。0.29.0 复核：载荷多了 `verification` / `termination`
 *   两个键，**重叠关系没变**（`run_end` 仍是终局的唯一展示面），理由仍成立。
 * · `config_override_conflict`：启动期一次性的配置冲突（`config.*` 与同名扁平键值不同）。本站只写
 *   `config.<组>.<叶>`（切片 A 迁移后的唯一拼写）⇒ **结构上不可能出现**；真响了就是宿主代码 bug，
 *   账在 runner 的 warn LOG（`runner/lib/engine-notices.js`），时间线上没有用户可行动的信息。
 * · `continuity_injection_skipped`：本站 `config.continuity` 与 `capabilities.hooks.continuityProvider`
 *   都不传（`handoff` 默认 `off`）⇒ 引擎连注入分支都进不去。
 *   ⚠ **0.30.0 复核**：它已进 `LoopEvent` 联合类型（0.29 时「不在 typedef 里」那半句理由**已失效**），
 *   剩下的一半仍然成立（本站结构上不产生）。
 * · `continuity_written` / `continuity_write_failed`（0.30.0 新增进联合类型）：续接块的**写者**那一半。
 *   本站 `config.continuity.handoff=off` ⇒ 引擎不写、不发；`write_failed` 即使真响也有 runner 的 warn LOG。
 * · `final_guard_extend`（0.30.0 新增）：**guard 专属**。两个发射点（`orchestrator.js:4744` / `:4849`）
 *   都在 guard 裁决后的扩轮路径上（revise 补跑 / 交付物补齐），本站**不传 `finalGuard`** ⇒ 结构上不产生。
 * · `context_unknown_option`（0.30.0 新增）：唯一发射点在 `createAssemblyPort`（`assembly.js:999`，
 *   走 `port.emit`），而**本站从不走装配口**（真链路直连 `runToolLoop`，口径见 `runner/lib/compact-knobs.js`）
 *   ⇒ 结构上不可能出现。真响了就说明本站开始用装配口且写错了 `context` 子键——那正是 runner warn LOG 的活。
 * · `tool_output_aggregate`（0.30.0 新增）：单轮工具输出超聚合预算时逐条发（`run-snapshot-executor.js:218`，
 *   载荷带 `action` / `reason` / `budgetTokens` / `inlineTokens` / `projectedTokens`）。**不刷行**的理由：
 *   被归档/stub 化的结果**正文本身就在工具卡片里可见**（模型看到的就是那段 stub 文字），时间线再加一行
 *   是同一件事说两遍；而它每轮可以多条 ⇒ 重型 run 会刷屏。账在 runner 的 info LOG。
 */
const EXEMPT_FROM_TIMELINE = {
  run_outcome: '与 run_end 语义重叠且今天无读者；0.29/0.30 下重叠关系未变（见上）',
  config_override_conflict: '启动期一次性配置冲突，本站只写 config.* 故结构上不可能；账在 runner warn LOG',
  continuity_injection_skipped: '本站不传 continuity（handoff=off 且无 provider）⇒ 注入分支进不去（0.30 起它已在联合类型里）',
  continuity_written: 'handoff=off ⇒ 引擎不会写续接块，也不会发这条；开了 continuity 才需要重看',
  continuity_write_failed: '同上：只有 handoff 打开后才会走到落盘失败这条；真响也有 runner warn LOG',
  final_guard_extend: 'guard 专属（两个发射点都在 guard 裁决后的扩轮路径）；本站不传 finalGuard ⇒ 结构上不产生',
  context_unknown_option: '唯一发射点在 createAssemblyPort，本站从不走装配口 ⇒ 结构上不产生；账在 runner warn LOG',
  tool_output_aggregate: 'stub 正文已在工具卡片里可见（重复），且每轮可多条 ⇒ 不刷行；账在 runner info LOG',
};

/** 引擎真发、本站**故意不订**的事件（不进 `EVENT_TYPES`）。0.30.0 起**为空**。 */
const NOT_SUBSCRIBED = {};

function literalsIn(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `源码里找不到锚点「${marker}」：集合被搬走/改名，本测会失去对象（宁可先红在这里）`);
  const after = source.slice(start);
  const end = after.indexOf('] as const') >= 0 && after.indexOf('] as const') < 4000
    ? after.indexOf('] as const')
    : after.indexOf(']);');
  assert.ok(end > 0, `锚点「${marker}」之后找不到集合结尾`);
  return new Set([...after.slice(0, end).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
}

function feSource() { return fs.readFileSync(FE_EVENTS, 'utf8'); }
function liveSet() { return literalsIn(feSource(), 'export const EVENT_TYPES = ['); }
function replaySet() { return literalsIn(feSource(), 'const HISTORY_REPLAY_TYPES = new Set(['); }
function backendSet() { return literalsIn(fs.readFileSync(HTTP, 'utf8'), 'const HISTORY_EVENT_TYPES = new Set(['); }

/** 引擎源码里是否存在 `type: "<name>"` 的发射点（= 引擎真会发它）。 */
function engineEmits(name) {
  return new RegExp(`type: "${name}"`).test(engine.emissions);
}

/**
 * **只订不回放下发**的运行态语义事件（#89 红线：历史回放绝不驱动运行态状态机）。
 * 它们不需要「豁免理由」——它们**有读者**（展示 / 水位线），只是那个读者不在回放路径上。
 */
const LIVE_ONLY = {
  usage: '单次 provider 调用的用量：只用于实时展示与水位线，不进历史回放（#89 / #425 口径）',
};

test('S0 承诺清单是从**已安装引擎源码**解析出来的（不是手抄），并报出版本', () => {
  // 解析失败时本文件在模块顶层就抛了；能走到这里说明拿到了一份非空联合类型。
  // 这条同时钉住「不许退化成硬抄」：联合类型被搬走/改名 ⇒ parseEngineLoopEventTypes 抛 ⇒ 本文件红，
  // 而不是像手抄清单那样**静默过期**。
  assert.ok(ENGINE_PROMISED_EVENTS.length >= 8,
    `解析到的联合类型只有 ${ENGINE_PROMISED_EVENTS.length} 项：${ENGINE_PROMISED_EVENTS.join(', ')}`);
  assert.equal(new Set(ENGINE_PROMISED_EVENTS).size, ENGINE_PROMISED_EVENTS.length, '联合类型里有重复项');
  assert.match(engine.version, /^\d+\.\d+\.\d+$/, `引擎版本读不出来：${engine.version}`);
});

test('S1 引擎承诺的每一类都订得到（“订得到”不可豁免）', () => {
  const live = liveSet();
  assert.ok(live.size >= 20, `抽到的 EVENT_TYPES 只有 ${live.size} 项，抽取姿势可疑`);
  const missing = ENGINE_PROMISED_EVENTS.filter((type) => !live.has(type));
  assert.deepEqual(missing, [],
    `实时监听里没有 ${missing.join(', ')} ⇒ 浏览器一条都收不到（#421 的原病灶）`);
  // 豁免表里的每一条都必须要么在承诺清单里、要么在「联合外真发」清单里
  //（上游不发了 ⇒ 该删豁免，而不是让豁免表烂着）
  for (const type of Object.keys(EXEMPT_FROM_TIMELINE)) {
    if (NOT_SUBSCRIBED[type] !== undefined) continue;
    assert.ok(ENGINE_PROMISED_EVENTS.includes(type) || ENGINE_UNPROMISED_EVENTS.includes(type),
      `豁免表里的 ${type} 既不在承诺清单也不在「联合外真发」清单里：上游不发了，该删豁免`);
  }
});

test('S2 承诺清单里**逐类**都有决定：进时间线 / 只订不回放 / 写明理由的豁免', () => {
  const replay = replaySet();
  const back = backendSet();
  const undecided = [];
  for (const type of ENGINE_PROMISED_EVENTS) {
    const inTimeline = replay.has(type) && back.has(type);
    const decided = Object.hasOwn(EXEMPT_FROM_TIMELINE, type) || Object.hasOwn(LIVE_ONLY, type);
    if (!inTimeline && !decided) undecided.push(type);
    if (inTimeline && decided) undecided.push(`${type}(既进时间线又在豁免/只订表)`);
    // 「只订不回放」不许半进：只进回放不进后端（或反之）会让 S4 红，这里只钉两表不重叠
  }
  assert.deepEqual(undecided, [],
    `这些类型既没进时间线也没写决定：${undecided.join(', ')}（#438：逐类决定，写了才算决定）`);
  for (const table of [EXEMPT_FROM_TIMELINE, LIVE_ONLY]) {
    for (const [type, reason] of Object.entries(table)) {
      assert.ok(reason.length > 6, `${type} 的决定必须写理由——写了才算决定，没写就是漏`);
    }
  }
});

test('S3 豁免的类型：订得到，但不进前端回放、也不进后端下发白名单', () => {
  const live = liveSet();
  const replay = replaySet();
  const back = backendSet();
  for (const type of Object.keys(EXEMPT_FROM_TIMELINE)) {
    if (NOT_SUBSCRIBED[type] !== undefined) continue;
    assert.ok(live.has(type), `${type} 订都订不到就不叫豁免，叫漏`);
    assert.equal(replay.has(type), false, `${type} 已进前端回放 ⇒ 要么真接了，要么在刷没人看的行，请重读豁免理由`);
    assert.equal(back.has(type), false, `${type} 已进后端历史白名单 ⇒ 同上`);
  }
});

test('S4 前端回放集合与后端下发白名单**逐项相等**（不是子集：多一边少一边都是 bug）', () => {
  const replay = replaySet();
  const back = backendSet();
  const onlyFe = [...replay].filter((t) => !back.has(t)).sort();
  const onlyBe = [...back].filter((t) => !replay.has(t)).sort();
  assert.deepEqual(onlyFe, [], `前端能回放、后端却不下发（这些类型刷新后永远空白）：${onlyFe.join(', ')}`);
  assert.deepEqual(onlyBe, [], `后端下发、前端却不处理（白送的数据没人读）：${onlyBe.join(', ')}`);
});

test('S5 反向防推测键：承诺清单里的每一类引擎都真发（读已安装引擎源码）', () => {
  assert.ok(engine.fileCount >= 20, `只扫到 ${engine.fileCount} 个引擎源码文件，扫描面可疑`);
  const dead = ENGINE_PROMISED_EVENTS.filter((type) => !engineEmits(type));
  assert.deepEqual(dead, [],
    `引擎源码里找不到这些类型的发射点 ⇒ 本站的监听/展示是永不触发的死支（推测键），该删：${dead.join(', ')}`);
});

test('S6 联合类型之外还有引擎真发的事件：逐条有决定（0.30.0 起该清单为空，三条 continuity 已进联合）', () => {
  // 0.29.0 实测：`continuity_injection_skipped` 经 `onEvent` 真发、**不在** `LoopEvent` 联合类型里。
  // **0.30.0 复核（#442）**：上游把三条 continuity 事件全补进了联合类型 ⇒ 「联合外真发」清单**空集**。
  // 这条判据把「事实」和「决定」分开钉：事实（引擎真发 / 在不在联合里）读源码得出，决定（豁免理由）在表里。
  for (const type of ENGINE_UNPROMISED_EVENTS) {
    assert.equal(engineEmits(type), true,
      `引擎源码里找不到 type: "${type}" ⇒ 本清单过期了（引擎不发它了，本站的订/豁免都该删）`);
    assert.equal(ENGINE_PROMISED_EVENTS.includes(type), false,
      `${type} 已经进了 LoopEvent 联合类型 ⇒ 请把它从 ENGINE_UNPROMISED_EVENTS 移到承诺清单（并重看它的决定）`);
  }
  // 0.30.0 的事实：三条 continuity 事件**都在**联合类型里（0.29 时它们在外面）。
  // 这条钉住「逃生口是空的」这个前提：将来若真有人往 `ENGINE_UNPROMISED_EVENTS` 里加东西，下面会提醒他重看。
  for (const type of ['continuity_injection_skipped', 'continuity_written', 'continuity_write_failed']) {
    assert.ok(ENGINE_PROMISED_EVENTS.includes(type),
      `${type} 在 0.30.0 的 LoopEvent 联合类型里（实测）⇒ 它不能走「联合外真发」那条豁免路`);
    assert.equal(engineEmits(type), true, `引擎源码里找不到 type: "${type}" 的发射点 ⇒ 它成了推测键`);
  }
  // 每一条都要么订了（并写豁免理由），要么在 NOT_SUBSCRIBED 里写明为什么不订
  const live = liveSet();
  for (const type of ENGINE_UNPROMISED_EVENTS) {
    if (NOT_SUBSCRIBED[type] !== undefined) {
      assert.equal(live.has(type), false, `${type} 已在 NOT_SUBSCRIBED 里说明不订，却又出现在 EVENT_TYPES`);
      assert.ok(NOT_SUBSCRIBED[type].length > 6, `${type} 的「不订」也必须写理由`);
      continue;
    }
    assert.ok(live.has(type), `${type} 既没订也没写「不订」的理由 ⇒ 这就是漏`);
    assert.ok(Object.hasOwn(EXEMPT_FROM_TIMELINE, type), `${type} 订了就必须有决定（进时间线或豁免+理由）`);
  }
});
