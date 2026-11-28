// issue #243 —— 终局「文本化工具调用」识别的三条判据（实现见 `runner/lib/final-text-toolcall.js`）。
//
// 三格各自都要**能红**，每格点名它治的是哪一种错法：
//   ① 命中 ⇒ 判真：夹具是**本机 dev 库现查的两条真实样本**（不是编的），外加两条同族变体。
//   ② 不误伤：自然语言**提到**工具名、正文含 < / HTML / 比较号 ⇒ 判假；把标记写在代码里
//      （引用它）也判假。（这一格最容易做假：把判据放宽成「正文含 <」就恒绿 —— 第 ⑤ 格的
//      变异自证专门把那个假实现逼出来，缺了它第 ② 格可以写成谁都不咬而照样绿。）
//   ③ 特征集可配置且生效：改集合 ⇒ 判定跟着变；删掉某条 ⇒ 对应夹具不再命中（反向自证）。
//      缺省集合**至少三条**（不许只钉 DSML）；非法条目**不许静默**（点名是哪个值）。
//
// ⚠ 写法红线：JS 单引号串**不许跨行**（真换行会把整个文件的解析打断，本文件踩过一次）。
//   多行样本一律用双引号串 + join(NL)；全是纯函数，零墙钟等待（不给 #531 那族假红添燃料）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_TOOLCALL_MARKERS,
  TEXTUALIZED_MARKER_MAX_CHARS,
  TEXTUALIZED_TOOL_CALL_EVENT_TYPE,
  TOOLCALL_MARKERS_ENV,
  detectTextualizedToolCall,
  parseToolCallMarkers,
  textualizedToolCallField,
  textualizedToolCallFieldForRun,
  toolCallMarkersFromEnv,
} from '../lib/final-text-toolcall.js';

// agentd 的中转判据要**真跑一次** `onWorkerFinished`（夹具与 `final-text-fallback.test.js` 的 F3 同族）：
// `agentd.js` 是可 import 的模块（起 daemon 的是 main 分支），但要读到 token 才不抱怨环境。
process.env.ERIX_STATION_TOKEN = 'test-token';
const agentd = await import('../agentd.js');

const U = '\uff5c'; // \uff5c FULLWIDTH VERTICAL LINE —— DSML 标记的分隔符（U+FF5C），写成常量免得靠肉眼数竖线。
const DSML_OPEN = '<' + U + U + 'DSML' + U + U; // <\uff5c\uff5cDSML\uff5c\uff5c
const NL = '\n'; // 唯一的换行字面量：多行样本一律 join(NL)
const FENCE = '\u0060'.repeat(3); // ``` 代码围栏（引用形状用）
const LT = '<'; const GT = '>'; // 尖括号常量：同族变体夹具用它们拼，别在夹具里写死特征字面串
const DSML_FEATURE = DEFAULT_TOOLCALL_MARKERS[0];
const TOOL_CALL_FEATURE = '<tool_call';
const FUNCTION_FEATURE = '<\uff5cFunction';
// XML 那一族的特征（PR #555 复审 MED-1）：**预防性覆盖**，dev 库现查 0 命中 —— 不是第五条真样本。
const INVOKE_FEATURE = LT + 'invoke';
// OpenAI/LiteLLM 的 tool-call id 前缀（同 PR #555 复审 MED-1）：**同样是预防性覆盖**，
// 也是缺省集合里唯一一条**不含 `<`** 的条目（它靠「长度 ≥12 且含 `-`」那条形状闸进得来）。
const CHATCMPL_FEATURE = 'chatcmpl-tool-';

/**
 * 真样本 A：run f4dfea1d-c439-4bba-ac34-4c86d7132bea（2026-10-11，runs.status=finished，32 轮，
 * termination.reason=judge_done，上升 926,290 / 下降 39,158 token）。取数 = 本机 dev 库**只读**查询：
 *   select payload->>'final_text' from run_events where run_id='f4dfea1d…' and type='round_end'
 *   order by seq desc limit 1
 * （seq 37223 = 该 run 最后一条正文）。码点用 encode(convert_to(left(content,120),'UTF8'),'hex')
 * 逐字核过：3c ff5c ff5c 44 53 4d 4c ff5c ff5c。与工单正文里那段引用逐字一致（工单写「9 轮」，
 * 库里现查 32 轮 ⇒ 以库为准）。
 */
const SAMPLE_A_FINAL_TEXT = [
  DSML_OPEN + 'tool_calls>',
  DSML_OPEN + 'invoke name="shell">',
  DSML_OPEN + 'parameter name="command" string="true">cd /home/erix/projects/tetris-arena && echo "=== processes ==="',
  "; pgrep -af 'node backend/server.js' | grep -v pgrep || echo 'NONE'",
  '</' + U + U + 'DSML' + U + U + 'parameter>',
  '</' + U + U + 'DSML' + U + U + 'invoke>',
  '</' + U + U + 'DSML' + U + U + 'tool_calls>',
].join(NL);

/**
 * 真样本 B：run 11fa3c68-353b-4edb-a0f8-02a972e4a0b3（2026-09-24，max_rounds_cap），messages 行
 * 0549e113-dc48-4ab3-9d87-f8b79a7557bf。**同族但形状不同**：现查得 <\uff5c\uff5cDSML\uff5c\uff5c calls> 与
 * <\uff5c\uff5cDSML\uff5c\uff5c invoke name="shell"> —— **标记名前多一个空格**。它就是「特征不许写成
 * <\uff5c\uff5cDSML\uff5c\uff5cinvoke 那种字面串」的实证：那种写法两条真样本都漏。
 */
const SAMPLE_B_FINAL_TEXT = [
  DSML_OPEN + ' calls>',
  DSML_OPEN + ' invoke name="shell">',
  DSML_OPEN + ' parameter name="command" string="true">python3 - <<PY',
  "io.open(p,'w',encoding='utf-8').write(s)",
  'PY',
  'node verify.mjs; echo done',
  '</' + U + U + 'DSML' + U + U + ' parameter>',
  '</' + U + U + 'DSML' + U + U + ' invoke>',
  '</' + U + U + 'DSML' + U + U + ' calls>',
].join(NL);

// 同族的另两种编码（工单原文：不同上游/网关把 tool call 编进 content 的形状不一致，不是偶发）。
// 同族的另两种编码（工单原文：不同上游/网关把 tool call 编进 content 的形状不一致，不是偶发）。
// 尖括号用常量拼，是为了让"缺省特征"与"夹具"两件事在源码里各自独立：改特征常量的那条判据
// 才真的在改判据，而不是被夹具里的同一个字面串带着一起绿。
const SAMPLE_C_TOOL_CALL = [
  LT + 'tool_call' + GT,
  LT + 'function=shell' + GT,
  LT + 'parameter=command>cd app && npm test' + LT + '/parameter' + GT,
  LT + '/function' + GT,
  LT + '/tool_call' + GT,
].join(NL);

// 变体 D 用**单竖线**的 ｜Function 形态（工单点名的是 `<｜Function` 那一族；双竖线的 DSML 已由
// 样本 A/B 覆盖）。两种竖线数各钉一条，免得哪天只剩一种形状能命中而没人发现。
const SAMPLE_D_FUNCTION = [
  LT + U + 'Function_calls' + U + GT,
  LT + U + 'Function=shell' + U + GT,
  LT + U + 'arg=ls' + U + GT,
].join(NL);

// 正常交付摘要（不误伤的夹具）：提到工具名 / 正文里有 < / HTML / 比较号，但**没有**工具调用标记。
const NORMALS = [
  '交付完成：我调用了 shell 工具跑 npm test，10/10 通过；前端已起在 22010。',
  'I ran the edit tool twice, then used shell to run the suite.',
  '<div class="app"><button>保存</button></div> 上面这段是本次改的前端骨架。',
  '当 rounds < 8 且 confidence > 0.9 时 judge 会判完成；本轮 12 轮，已达成。',
  'npm run build 通过（exit 0），产物在 dist/。若 a[i] < b[i] 就跳过。',
];

// ---------------------------------------------------------------------------
// ① 命中 ⇒ 判真
// ---------------------------------------------------------------------------

test('#243 ① 命中判真：两条 dev 库真样本 + 两条同族变体，且带回命中的是哪一条特征', () => {
  const cases = [
    ['样本 A（DSML 无空格：tool_calls / invoke / parameter）', SAMPLE_A_FINAL_TEXT, DSML_FEATURE],
    ['样本 B（DSML 标记名带空格： calls / invoke）', SAMPLE_B_FINAL_TEXT, DSML_FEATURE],
    ['变体 C（tool_call 一族）', SAMPLE_C_TOOL_CALL, TOOL_CALL_FEATURE],
    ['变体 D（Function 一族）', SAMPLE_D_FUNCTION, FUNCTION_FEATURE],
  ];
  for (const [name, text, expectMarker] of cases) {
    const got = detectTextualizedToolCall(text);
    assert.equal(got.hit, true, name + ' 必须判真（这就是 #243 静默丢报告的那个形状）');
    assert.equal(got.marker, expectMarker,
      name + ' 命中的特征应为 ' + JSON.stringify(expectMarker) + '，实得 ' + JSON.stringify(got.marker));
    assert.ok(got.chars > 0, name + ' 的 chars 要带回正文字符数（下游文案要用，不许恒 0）');
  }
});

test('#243 ① 反向：没有正文就不是降级交付（空串 / 空白 / 非字符串 ⇒ 判假、chars 为 0）', () => {
  // 「终稿是引擎兜底文案」由 #442 的 finalTextFallback 管；这里钉的是「没有正文可判」
  // 不得混进「正文是文本化工具调用」，两件事各自的信号不能互相顶替。
  for (const text of ['', '   \n ', null, undefined, 42, { text: SAMPLE_A_FINAL_TEXT }]) {
    const got = detectTextualizedToolCall(text);
    assert.equal(got.hit, false, JSON.stringify(text) + ' 不得判真');
    assert.equal(got.marker, null);
    assert.equal(got.chars, 0);
  }
});

// ---------------------------------------------------------------------------
// ② 不误伤
// ---------------------------------------------------------------------------

test('#243 ② 正常交付摘要不误伤：提到工具名 / 正文含 < / HTML / 比较号 一律判假', () => {
  for (const text of NORMALS) {
    assert.equal(detectTextualizedToolCall(text).hit, false, '误伤了正常交付摘要：' + text.slice(0, 40));
  }
});

test('#243 ② 正文里**引用**这些标记（写在代码里）不算泄漏', () => {
  // 真夹具里没有反引号（两条真样本现查），所以剥代码不会把真泄漏剥掉；而「讲清这个坑」的
  // 正常交付摘要恰恰会把标记写进行内代码 / 围栏里 —— 那段是「谈这个标记」不是「泄漏了它」。
  const quoting = '本轮的坑：模型把工具调用吐成正文，形如 ' + FENCE + DSML_OPEN + 'invoke name="shell"' + FENCE
    + '，已登记 #243。复现形状：' + NL + FENCE + NL + SAMPLE_A_FINAL_TEXT + NL + FENCE + NL;
  assert.equal(detectTextualizedToolCall(quoting).hit, false, '引用在代码里的标记不该判真');
});

// ---------------------------------------------------------------------------
// ③ 特征集可配置且生效
// ---------------------------------------------------------------------------

test('#243 ③ 缺省特征集至少三条，且不许只钉 DSML 一条', () => {
  assert.ok(Array.isArray(DEFAULT_TOOLCALL_MARKERS) && DEFAULT_TOOLCALL_MARKERS.length >= 3,
    '缺省特征集必须 >= 3 条，实得 ' + JSON.stringify(DEFAULT_TOOLCALL_MARKERS));
  assert.equal(new Set(DEFAULT_TOOLCALL_MARKERS).size, DEFAULT_TOOLCALL_MARKERS.length, '缺省集合里有重复项');
  // 缺省集合的**形状不变量**（= 解析器两条闸的同一条口径，别把它松成"是字符串就行"）：
  //   含 `<` 的条目 ⇒ 长度 ≥3；**不含 `<`** 的条目 ⇒ 长度 ≥12 且含 `-`（「像 id 前缀」）。
  //   这条断言就是防误伤的承重墙：松掉它，`off` 这种短词就能溜进缺省去咬 "offset"。
  for (const marker of DEFAULT_TOOLCALL_MARKERS) {
    const isTag = typeof marker === 'string' && marker.indexOf('<') >= 0 && marker.length >= 3;
    const isIdPrefix = typeof marker === 'string' && marker.indexOf('<') < 0
      && marker.length >= 12 && marker.indexOf('-') >= 0;
    assert.ok(isTag || isIdPrefix, '缺省条目形状不对，实得 ' + JSON.stringify(marker));
  }
  const bareEntries = DEFAULT_TOOLCALL_MARKERS.filter((m) => m.indexOf('<') < 0);
  assert.deepEqual(bareEntries, [CHATCMPL_FEATURE],
    '不含 `<` 的条目必须只有 id 前缀那一条，且必须是 chatcmpl-tool-（多一条就得先补真样本，不是先补形状）');
  assert.deepEqual([...DEFAULT_TOOLCALL_MARKERS],
    [DSML_OPEN, TOOL_CALL_FEATURE, FUNCTION_FEATURE, INVOKE_FEATURE, CHATCMPL_FEATURE],
    '缺省 = DSML 前缀 / tool_call 一族 / Function 一族 / XML 的 invoke 一族 / OpenAI 的 id 前缀一族。'
    + 'DSML 取到竖线为止：真样本 B 写作带空格的 invoke、真样本 A 首行是 tool_calls，'
    + '拿\"到 invoke 为止\"那种字面串当特征会两条都漏。'
    + '\u26a0 **前三条是 dev 库实证；后两条（<invoke、chatcmpl-tool-）是预防性覆盖**——261116 返工现查'
    + '库里各 0 命中（取数语句与读数见交付 /tmp/tickets/deliver-555-rework.md 的「取证边界」），'
    + '别把它们读成第三、第四条真样本。');
});

test('#243 ③ 删掉某条特征 ⇒ 对应夹具不再命中（反向自证：判定真的跟着集合走）', () => {
  // 先钉前置：默认集合下这些夹具都判真 —— 否则下面「删掉后判假」是恒真断言。
  assert.equal(detectTextualizedToolCall(SAMPLE_A_FINAL_TEXT).hit, true, '前置：样本 A 默认判真');
  assert.equal(detectTextualizedToolCall(SAMPLE_C_TOOL_CALL).hit, true, '前置：变体 C 默认判真');

  const withoutDsml = DEFAULT_TOOLCALL_MARKERS.filter((m) => m !== DSML_FEATURE);
  assert.equal(detectTextualizedToolCall(SAMPLE_A_FINAL_TEXT, withoutDsml).hit, false,
    '删掉 DSML 这条后，样本 A 必须不再命中');
  assert.equal(detectTextualizedToolCall(SAMPLE_C_TOOL_CALL, withoutDsml).hit, true,
    '同一份删过的集合仍要命中 tool_call 那条（只该掉被删的那一条，不是一起失效）');

  const withoutToolCall = DEFAULT_TOOLCALL_MARKERS.filter((m) => m !== TOOL_CALL_FEATURE);
  assert.equal(detectTextualizedToolCall(SAMPLE_C_TOOL_CALL, withoutToolCall).hit, false,
    '删掉 tool_call 这条后，变体 C 必须不再命中');

  const withoutFunction = DEFAULT_TOOLCALL_MARKERS.filter((m) => m !== FUNCTION_FEATURE);
  assert.equal(detectTextualizedToolCall(SAMPLE_D_FUNCTION, withoutFunction).hit, false,
    '删掉 Function 这条后，变体 D 必须不再命中');
});

test('#243 ③ 换一套集合 ⇒ 判定跟着变（自定义特征与缺省集合互不覆盖）', () => {
  const custom = [LT + 'my_call' + GT];
  assert.equal(detectTextualizedToolCall(SAMPLE_A_FINAL_TEXT, custom).hit, false,
    '自定义集合里没有 DSML 这条 ⇒ 真样本必须判假（判定跟着集合走，不是写死的）');
  assert.equal(detectTextualizedToolCall('任务做完了。' + LT + 'my_call' + GT + 'name=shell', custom).hit, true,
    '自定义特征必须能把自己那一种形状判真');
});

// ---------------------------------------------------------------------------
// ④ 配置解析：缺省 / 显式关闭 / 非法值不许静默
// ---------------------------------------------------------------------------

test('#243 ④ 配置：未设 ⇒ 缺省特征集；off ⇒ 显式关闭但必须响一声', () => {
  for (const raw of [undefined, null, '', '   ']) {
    const got = parseToolCallMarkers(raw);
    assert.deepEqual(got.markers, [...DEFAULT_TOOLCALL_MARKERS], JSON.stringify(raw) + ' 应回退缺省特征集');
    assert.equal(got.disabled, false, '未设配置不是关闭');
    assert.deepEqual(got.warnings, [], '未设配置不该响');
  }
  const off = parseToolCallMarkers('off');
  assert.equal(off.disabled, true, 'off 是显式关闭');
  assert.deepEqual(off.markers, []);
  assert.equal(off.warnings.length, 1, '显式关闭必须留一条点名告警，实得 ' + JSON.stringify(off.warnings));
  assert.ok(off.warnings[0].indexOf('off') >= 0, '告警必须点名原值，实得 ' + off.warnings[0]);
  assert.ok(off.warnings[0].indexOf(TOOLCALL_MARKERS_ENV) >= 0, '告警必须点名是哪个环境变量');
});

test('#243 ④ 配置：非法条目不许静默 —— 逐条点名丢弃；全部非法则回退缺省而不是关掉', () => {
  const partial = parseToolCallMarkers(DSML_OPEN + ',off,lt', { key: 'X_MARKER' });
  assert.deepEqual(partial.markers, [DSML_OPEN], '只该留下合法那条，实得 ' + JSON.stringify(partial.markers));
  assert.equal(partial.invalid.length, 2, '两条非法条目都要记账，实得 ' + JSON.stringify(partial.invalid));
  // 点名要点到「是哪个值 + 为什么」（本仓 parseInt("1e4")===1 那一族的教训：配错要看得见）。
  assert.deepEqual(partial.invalid.map((e) => e.value), ['off', 'lt'],
    '非法条目按出现顺序逐条记账（顺序钉死，免得用 sort 蒙掉"少记了一条"）');
  for (const entry of partial.invalid) {
    assert.ok(entry.reason.length > 4, '条目 ' + entry.value + ' 必须写理由，实得 ' + JSON.stringify(entry));
  }
  assert.equal(partial.warnings.length, 2, '每条非法条目都要响一次，不许合并成一句含糊的"配置有问题"');
  for (const warning of partial.warnings) {
    assert.ok(warning.indexOf('X_MARKER') >= 0, '告警要用调用方给的变量名点名，实得 ' + warning);
  }

  const allBad = parseToolCallMarkers('off,tool,lt');
  assert.deepEqual(allBad.markers, [...DEFAULT_TOOLCALL_MARKERS],
    '全部条目都非法 ⇒ 回退缺省特征集，**不是**关掉检测（配错不该把可见面一起吞掉）');
  assert.equal(allBad.disabled, false, '全部非法不得被当成显式关闭');
  assert.equal(allBad.warnings.length, 4, '三条非法 + 一条回退汇总都要响，实得 ' + JSON.stringify(allBad.warnings));
  assert.ok(allBad.warnings[allBad.warnings.length - 1].indexOf('回退缺省') >= 0, '回退这件事本身要响');

  const dup = parseToolCallMarkers(TOOL_CALL_FEATURE + ',,' + TOOL_CALL_FEATURE + ',' + FUNCTION_FEATURE);
  assert.deepEqual(dup.markers, [TOOL_CALL_FEATURE, FUNCTION_FEATURE], '重复条目静默去重、空段不算非法');
  assert.deepEqual(dup.invalid, [], '重复与空段都不该被当成非法');
});

test('#243 ④ 从 env 读：只读那一个键，且把告警原样交回调用方（调用方负责落 LOG 面）', () => {
  const env = {};
  env[TOOLCALL_MARKERS_ENV] = 'off';
  const got = toolCallMarkersFromEnv(env);
  assert.equal(got.disabled, true, 'env 里写 off 就是关闭');
  assert.equal(got.warnings.length, 1, '从 env 读也要把告警交回去（本模块不打日志：纯函数）');
  assert.equal(toolCallMarkersFromEnv({}).markers.length, DEFAULT_TOOLCALL_MARKERS.length,
    'env 里没有那个键 ⇒ 缺省特征集');
});
// ---------------------------------------------------------------------------
// ⑤ 「不误伤」那一格的反向自证：把判据放宽成「正文含 <」必须被这格逼红
// ---------------------------------------------------------------------------

test('#243 ⑤ 反向自证：判据若退化成"正文含 <"就算，正常交付摘要会全部误伤', () => {
  // 这一格不测实现细节，只把"最容易偷懒的那版实现"钉死：把特征集放宽到一个尖括号，
  // NORMALS 里每一条都会被判真 —— 于是第 ② 格（不误伤）必然红。缺了这格，第 ② 格
  // 可以写成谁都不咬的恒绿断言（工单点名的"最容易做假的一格"）。
  const tooLoose = [LT];
  const hasAngle = NORMALS.filter((text) => text.indexOf(LT) >= 0);
  assert.ok(hasAngle.length >= 3, '夹具里必须有足够多条**带尖括号**的正常摘要，否则这格是空的');
  const falsePositives = NORMALS.filter((text) => detectTextualizedToolCall(text, tooLoose).hit);
  assert.deepEqual(falsePositives, hasAngle,
    '把特征放宽成"含尖括号就算"时，每一条带尖括号的正常交付摘要都必须被判真（判真集合 = 含尖括号'
    + '的集合）。这格红 = 第 ② 格根本没在看这些夹具，那条判据可以写成恒绿断言');
  for (const text of NORMALS) {
    assert.equal(detectTextualizedToolCall(text).hit, false,
      '同一批夹具在缺省特征集下必须判假 —— 两向一起看，才说明"不误伤"是靠特征形状做到的，不是靠运气');
  }
});

// ---------------------------------------------------------------------------
// ⑥ 事件面接线（工单第 2 步）：识别结果只多带 additive 字段，**不改终态**
// ---------------------------------------------------------------------------

const RUNNER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readRunner = (rel) => fs.readFileSync(path.join(RUNNER_DIR, rel), 'utf8');

test('#243 ⑥ additive 字段：命中才给两个键，没命中/空正文/显式关闭 ⇒ 一个字节都不多', () => {
  assert.deepEqual(textualizedToolCallField(SAMPLE_A_FINAL_TEXT),
    { textualized_tool_call: true, textualized_tool_call_marker: DSML_FEATURE },
    '命中 ⇒ 两个键：布尔 + 命中的那条特征（照 #442 的 final_text_fallback 同族口径）');
  assert.deepEqual(textualizedToolCallField(NORMALS[0]), {}, '正常交付摘要不得多带任何键');
  assert.deepEqual(textualizedToolCallField(''), {}, '空正文不得多带任何键（#442 才管那种情形）');
  assert.deepEqual(textualizedToolCallField(SAMPLE_A_FINAL_TEXT, []), {},
    '特征集为空（配置 off）⇒ 判定关闭，一个字节都不多');
  // **绝不写 false**：那会让「旧 runner 不认识这个键」与「明确没命中」在 U2 载荷上分不开。
  assert.equal('textualized_tool_call' in textualizedToolCallField(NORMALS[0]), false,
    '未命中时这个键必须**缺席**，不是值为 false');
});

// ---- #895：引擎原生 finalTextShape 优先的三格（erix-agent 0.34.0 上游 #862）----
// 三格各钉一条口径；「读 result.finalTextShape」那一步被删 ⇒ ① 红，「缺席写 false」被误写 ⇒ ③ 红（变异自证）。

test('#895 ①：引擎 finalTextShape.textualizedToolCall===true ⇒ 判散文，即使 env marker 完全不匹配（引擎优先）', () => {
  // 正文是一段 env 特征集根本嗅不到的文本；引擎却给出 {textualizedToolCall:true, marker}。
  // ⇒ 只要判成散文，唯一来源就是引擎那条事实（env 启发式此时返回空对象）。
  const finalText = '模型把调用写进了正文，没有任何尖括号标记';
  const engineShape = { textualizedToolCall: true, marker: '<｜tool_call｜>' };
  // env 配一条与正文/引擎都不搭的合法 marker ⇒ env 启发式不命中；引擎说了算。
  assert.deepEqual(
    textualizedToolCallFieldForRun({ finalText, finalTextShape: engineShape }, ['<totally-unrelated>']), {
      textualized_tool_call: true,
      textualized_tool_call_marker: '<｜tool_call｜>',
    });
  // env 完全没配（markers:[] = 老部署显式关闭）⇒ 同样判成散文：证明引擎优先**不受 env marker 影响**。
  assert.deepEqual(
    textualizedToolCallFieldForRun({ finalText, finalTextShape: engineShape }, []), {
      textualized_tool_call: true,
      textualized_tool_call_marker: '<｜tool_call｜>',
    });
  // 引擎 marker 长过上界 ⇒ 照 MED-2 只丢显示片段、布尔照传（仍判散文）。
  const longMarker = 'x'.repeat(TEXTUALIZED_MARKER_MAX_CHARS + 1);
  assert.deepEqual(
    textualizedToolCallFieldForRun({ finalText, finalTextShape: { textualizedToolCall: true, marker: longMarker } }, []),
    { textualized_tool_call: true });
  // 对照：去掉引擎这条事实（只剩 env 不匹配的正文）⇒ 退回 env 启发式 ⇒ 不判（证明上面确由引擎生效）。
  assert.deepEqual(textualizedToolCallFieldForRun({ finalText }, ['<totally-unrelated>']), {});
});

test('#895 ②：引擎不给 textualizedToolCall 键 ⇒ env-marker 启发式照旧生效（行为一字不变）', () => {
  const finalText = '好正文 <｜tool▁end▁> 坏正文';
  // (a) 整个 finalTextShape 缺席 ⇒ env 命中照旧（两键）。
  assert.deepEqual(
    textualizedToolCallFieldForRun({ finalText }, ['<｜tool▁end▁>']), {
      textualized_tool_call: true,
      textualized_tool_call_marker: '<｜tool▁end▁>',
    });
  // (b) finalTextShape 对象在、但没 textualizedToolCall 键 ⇒ 仍算「引擎没说」⇒ env 命中照旧。
  assert.deepEqual(
    textualizedToolCallFieldForRun({ finalText, finalTextShape: { unrelated: 'x' } }, ['<｜tool▁end▁>']), {
      textualized_tool_call: true,
      textualized_tool_call_marker: '<｜tool▁end▁>',
    });
});

test('#895 ③：引擎给了 finalTextShape 但没 textualizedToolCall 键、且 env 不命中 ⇒ 不判且**不写 false**', () => {
  const finalText = 'plain prose, nothing to see here';
  for (const [label, result] of [
    ['有 marker 无 textualizedToolCall', { finalText, finalTextShape: { marker: '<other>' } }],
    ['空 finalTextShape 对象', { finalText, finalTextShape: {} }],
    ['finalTextShape 整个缺席', { finalText }],
  ]) {
    const field = textualizedToolCallFieldForRun(result, ['<｜tool▁end▁>']);
    assert.equal('textualized_tool_call' in field, false, `${label}：绝不写 textualized_tool_call 键（尤其绝不写 false）`);
    assert.deepEqual(field, {}, `${label}：env 也不命中 ⇒ 空对象，一个字节都不多带`);
  }
});

test('#243 ⑥ 事件名自解释且三处集合同名（跨端 import 不到，只能字符串对账）', () => {
  assert.equal(TEXTUALIZED_TOOL_CALL_EVENT_TYPE, 'textualized_tool_call');
  const root = path.join(RUNNER_DIR, '..');
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  // ① 后端历史下发白名单（漏 = 刷新后后端根本不下发）
  const http = read('portal/src/http.js');
  const wlStart = http.indexOf('const HISTORY_EVENT_TYPES = new Set([');
  assert.ok(wlStart >= 0, 'http.js 的 HISTORY_EVENT_TYPES 锚点还在');
  const wl = http.slice(wlStart, http.indexOf('const HISTORY_EVENT_DEFAULT_LIMIT', wlStart));
  assert.match(wl, /'textualized_tool_call'/, '后端白名单必须含它，否则刷新后消失（erix-agent #182 教训）');
  // ②③ 前端两处集合（漏 EVENT_TYPES = 实时收不到；漏 HISTORY_REPLAY_TYPES = 刷新后消失）
  const fe = read('portal/frontend/src/composables/useEventStream.ts');
  for (const [label, marker] of [['EVENT_TYPES', 'export const EVENT_TYPES = ['], ['HISTORY_REPLAY_TYPES', 'const HISTORY_REPLAY_TYPES = new Set([']]) {
    const at = fe.indexOf(marker);
    assert.ok(at >= 0, `前端 ${label} 锚点还在`);
    const end = fe.indexOf('] as const', at) > 0 && fe.indexOf('] as const', at) < 4000
      ? fe.indexOf('] as const', at)
      : fe.indexOf(']);', at);
    assert.match(fe.slice(at, end), /'textualized_tool_call'/, `前端 ${label} 必须含它`);
  }
});

test('#243 ⑥ worker / agentd 接线：成功信封带字段、失败信封不带、agentd 逐字透传', () => {
  const worker = readRunner('worker.js');
  const agentd = readRunner('agentd.js');
  // 成功信封里确实展开了这个函数（不是只在文件里 import 了没用）
  assert.match(worker, /\.\.\.textualizedToolCallFieldForRun\(result, finalTextShapeConfig\.markers\)/,
    'worker 的 RUN_FINISHED 成功信封必须展开 textualizedToolCallFieldForRun（#895：引擎原生优先；漏了就是"检测在跑但没人上报"）');
  // 每 run 重新解析配置 + 告警必须落到 LOG 面（非法值不许静默）
  assert.match(worker, /finalTextShapeConfig = toolCallMarkersFromEnv\(process\.env\)/,
    '特征集必须每 run 解析一次（worker 进程会被复用给下一个 run）');
  assert.match(worker, /for \(const warning of finalTextShapeConfig\.warnings\)[\s\S]{0,200}level: 'warn'/,
    '配置告警必须逐条落 warn LOG —— 静默回退等于没人知道自己配错了');
  // 失败信封（final_text 恒空）**不该**带这个键：那一侧的正文由 #300 的重建路径负责
  const failEnvelope = worker.slice(worker.indexOf("type: MSG.RUN_FINISHED,\n      run_id: runId,\n      ok: false"));
  assert.ok(failEnvelope.length > 0, '失败信封锚点还在');
  assert.equal(failEnvelope.slice(0, 900).indexOf('textualizedToolCallField'), -1,
    '失败路径不该带这个键（那条路径 final_text 恒为空，谈不上降级交付）');
  // agentd 逐字透传、绝不补 false
  assert.match(agentd, /\.\.\.\(msg\.textualized_tool_call === true/,
    'agentd 必须只在 true 时透传这两个键（补 false 就把"旧 worker 不认识"与"没命中"混成一件事）');
});

// ---------------------------------------------------------------------------
// ⑦ agentd 中转：真跑一次 `onWorkerFinished` 抓 U2 的 body（夹具同 #442 的 F3）
// ---------------------------------------------------------------------------

function stubFetch() {
  const bodies = [];
  return {
    bodies,
    impl: async (url, opts = {}) => {
      const method = opts.method ?? 'GET';
      if (method === 'PUT' && String(url).endsWith('/state')) {
        bodies.push(typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body);
        return { ok: true, status: 200, text: async () => JSON.stringify({ state: 'finished', run_end_seq: 1 }) };
      }
      if (method === 'PUT' && String(url).endsWith('/artifact')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ artifact_id: 'a1', size: 1 }) };
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    },
  };
}

function makeCtx(projectDir) {
  return {
    // 用真样本那条 runId：出错时读日志一眼就知道是哪次 run（fixture 也要长得像现场）。
    runId: 'f4dfea1d-c439-4bba-ac34-4c86d7132bea', claimToken: 'ct-test', attempt: 1, resume: false,
    worker: null, workerPid: null, exited: null, events: [], eventBytes: 0,
    flushTimer: null, inflight: false, finishing: false, dropped: false, dropReason: null,
    lastIpcAt: Date.now(), projectDir,
  };
}

async function finishedBody(msg) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-toolcall-'));
  const { bodies, impl } = stubFetch();
  const saved = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    await agentd.onWorkerFinished(makeCtx(root), {
      ok: true, termination: { reason: 'end_turn' },
      usage: { input_tokens: 1, output_tokens: 2 }, rounds: 32, final_text: SAMPLE_A_FINAL_TEXT, ...msg,
    });
  } finally {
    globalThis.fetch = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(bodies.length, 1, 'U2 终态应当上报恰好一次');
  return bodies[0];
}

test('#243 ⑦ agentd 逐字透传：worker 带了这两个键 ⇒ U2 body 里有；不带 ⇒ 一个字节都不多', async () => {
  const hit = await finishedBody({ textualized_tool_call: true, textualized_tool_call_marker: DSML_FEATURE });
  assert.equal(hit.textualized_tool_call, true, 'agentd 把标记吞了 ⇒ 界面永远不知道终局是一段工具调用');
  assert.equal(hit.textualized_tool_call_marker, DSML_FEATURE, '命中的特征名必须原样到 portal（界面要用它）');
  // **终态语义一个字没动**：additive 之外 body 的既有字段照旧。
  assert.equal(hit.termination.reason, 'end_turn');
  assert.equal(hit.rounds, 32);
  assert.equal(hit.final_text, SAMPLE_A_FINAL_TEXT);

  const miss = await finishedBody({});
  assert.equal(Object.hasOwn(miss, 'textualized_tool_call'), false,
    '没命中时 U2 body 里不许多出这个键（缺席才是「没命中」）');
  assert.equal(Object.hasOwn(miss, 'textualized_tool_call_marker'), false);

  for (const dirty of [1, 'true', {}, [], 0]) {
    const body = await finishedBody({ textualized_tool_call: dirty, textualized_tool_call_marker: DSML_FEATURE });
    assert.equal(Object.hasOwn(body, 'textualized_tool_call'), false,
      `textualized_tool_call=${JSON.stringify(dirty)} 不该被当成 true 透传`);
    assert.equal(Object.hasOwn(body, 'textualized_tool_call_marker'), false,
      '脏布尔时连 marker 也不该单独漏过去（两个键说的是同一件事）');
  }
  // marker 脏（空串 / 非串）⇒ 只丢 marker，布尔照传：事件仍要写，界面少一句片段而已。
  for (const dirty of ['', 42, null]) {
    const body = await finishedBody({ textualized_tool_call: true, textualized_tool_call_marker: dirty });
    assert.equal(body.textualized_tool_call, true);
    assert.equal(Object.hasOwn(body, 'textualized_tool_call_marker'), false,
      `marker=${JSON.stringify(dirty)} 不该被透传（portal 会因它 400，整条终态都报不上去）`);
  }
});

// ---------------------------------------------------------------------------
// ⑧ PR #555 复审 MED-1：两族今天认不出、而且**配不进去**（XML 的 `<invoke` / OpenAI 的 id 前缀）
//
// ⚠ 这两族在 dev 库里**取不到真样本**（`run_events.payload` / `messages.content` /
// `transcript_rounds(record|messages)` 三处各 0 命中，同一批查询里 DSML 的阴性对照是 6 / 1 / 8 行）
// ⇒ 它们是**预防性覆盖**。下面的夹具是「形状夹具」，不是第五条、第六条真样本，别这么读。
// ---------------------------------------------------------------------------

// XML 那一族（Anthropic/LiteLLM 把 tool call 编进 content 的形状）。多行一律 join(NL)：
// 单引号串跨行会把整个文件的解析打断（本文件踩过一次）。
const SAMPLE_E_INVOKE = [
  '任务已完成，下面是我打算执行的命令：',
  LT + 'invoke name="exec"' + GT,
  LT + 'parameter name="command"' + GT + 'npm test' + LT + '/parameter' + GT,
  LT + '/invoke' + GT,
].join(NL);

// OpenAI/LiteLLM 的 tool-call **id 前缀**形态：正文里只剩一串 id，没有任何结构化 tool_calls。
const SAMPLE_F_ID_PREFIX = ['交付说明见上。', 'chatcmpl-tool-abc123def456'].join(NL);

test('#243 ⑧ `<invoke` 一族默认判真并带回是哪条特征；从缺省里删掉它 ⇒ 该夹具必须转假', () => {
  const got = detectTextualizedToolCall(SAMPLE_E_INVOKE);
  assert.equal(got.hit, true, 'XML 形态必须判真（复审复现过 hit:false）');
  assert.equal(got.marker, INVOKE_FEATURE, '要能带回命中的是哪一条特征，实得 ' + JSON.stringify(got.marker));

  // 反向自证：这条判定真的来自缺省集合里那条特征，不是别的条目顺手捞到的。
  const withoutInvoke = DEFAULT_TOOLCALL_MARKERS.filter((m) => m !== INVOKE_FEATURE);
  assert.equal(detectTextualizedToolCall(SAMPLE_A_FINAL_TEXT, withoutInvoke).hit, true,
    '前置：删掉 <invoke 之后 DSML 真样本仍判真（否则下面那条判假是恒真断言）');
  assert.equal(detectTextualizedToolCall(SAMPLE_E_INVOKE, withoutInvoke).hit, false,
    '删掉 <invoke 这条后，XML 夹具必须转假');

  // 剥代码的口径对新条目同样成立：文档/交付里**引用** `<invoke name="exec">` 不是泄漏。
  const quoted = '本仓判据里出现过 ' + FENCE + NL + SAMPLE_E_INVOKE + NL + FENCE + '，那是夹具不是泄漏。';
  assert.equal(detectTextualizedToolCall(quoted).hit, false, '代码块里引用的 XML 形态不许判真');
});

test('#243 ⑧ `chatcmpl-tool-` 形态默认判真；只写 `chatcmpl` 或含 offset/offer 的正常正文不许被咬', () => {
  const got = detectTextualizedToolCall(SAMPLE_F_ID_PREFIX);
  assert.equal(got.hit, true, 'id 前缀形态必须判真');
  assert.equal(got.marker, CHATCMPL_FEATURE, '实得 ' + JSON.stringify(got.marker));

  // 误伤判据一：**没有那条 `-`** 的短词不算（"chatcmpl" 会出现在普通内容里：dev 库里那一行
  // 就是某个 run 用 writeFile 写下去的测试脚本正文）。
  for (const text of [
    '已生成响应 id chatcmpl-9fQ2xT，一切正常。',
    '这次交付不涉及 chatcmpl 这个前缀，结论见上。',
  ]) {
    assert.equal(detectTextualizedToolCall(text).hit, false, '不该判真：' + JSON.stringify(text));
  }
  // 承重墙存在的**理由**也用行为钉一次（不是注释里空口说）：绕开解析器、硬把短词 `off` 当特征，
  // "offset" 就会被咬 ⇒ 这就是「不含 `<` 的条目要求长度 ≥12 且含 `-`」防的东西。
  assert.equal(detectTextualizedToolCall('我把滚动偏移 offset 修成了 0。', ['off']).hit, true,
    '前置：短词当特征确实会咬 "offset"（否则上面那条形状闸就没有依据）');
  // 误伤判据二：`off` / `offer` / `offset` 这一族短词永远不许进特征（"offset" 里含 "off"）。
  for (const text of [
    '我把滚动偏移 offset 修成了 0，另把 offer 文案改了。',
    '关掉开关（off）之后不再刷提示。',
  ]) {
    assert.equal(detectTextualizedToolCall(text).hit, false, '不该判真：' + JSON.stringify(text));
  }
});

test('#243 ⑧ 承重墙：不含 `<` 的条目要求「长度 ≥12 且含 `-`」——收得下 id 前缀，挡得住短词', () => {
  // 收得下：现场遇到那一族时不必改代码（这正是 MED-1 要的能力）。
  const ok = parseToolCallMarkers(CHATCMPL_FEATURE, { key: 'X_MARKER' });
  assert.deepEqual(ok.markers, [CHATCMPL_FEATURE], 'chatcmpl-tool- 必须收得下，实得 ' + JSON.stringify(ok.markers));
  assert.deepEqual(ok.invalid, [], '它不是非法条目');
  assert.deepEqual(ok.warnings, [], '合法的 id 前缀不该有告警');

  // 挡得住：逐条点名丢弃，理由要点明"为什么这种值会咬自然语言"。
  const bad = parseToolCallMarkers('chatcmpl,off,offer,offset,abcdefghij-', { key: 'X_MARKER' });
  // 这批**全部**非法 ⇒ 走「回退缺省」那一条路（不是空集合、更不是关掉检测）；
  // 「一条合法就留那条」的逐条口径在下面的 mixed 与 ⑪ 里各钉一次。
  assert.deepEqual(bad.markers, [...DEFAULT_TOOLCALL_MARKERS],
    '五条全非法 ⇒ 回退缺省（配错不该把可见面一起吞掉），实得 ' + JSON.stringify(bad.markers));
  assert.equal(bad.disabled, false, '全部非法不得被当成显式关闭');
  assert.deepEqual(bad.invalid.map((e) => e.value), ['chatcmpl', 'off', 'offer', 'offset', 'abcdefghij-'],
    '按出现顺序逐条记账（abcdefghij- = 11 字符，差一个字符也不收）');
  assert.equal(bad.warnings.length, 6, '5 条点名 + 1 条回退汇总都要响，实得 ' + JSON.stringify(bad.warnings));

  // 混合：一条非法只丢那一条，别把整份判定带崩（口径以代码为准：**逐条**丢弃，全部非法才回退）。
  const mixed = parseToolCallMarkers(TOOL_CALL_FEATURE + ',chatcmpl', { key: 'X_MARKER' });
  assert.deepEqual(mixed.markers, [TOOL_CALL_FEATURE], '只丢那条短的');
  assert.equal(mixed.invalid.length, 1);
  assert.equal(mixed.warnings.length, 1, '一条非法只响一次');

  // 形状闸的边界：12 字符 + 含 `-` 是最短可收形态；12 字符不含 `-` 仍拒。
  assert.deepEqual(parseToolCallMarkers('abcdefghijkl-').markers, ['abcdefghijkl-'], '12 字符 + 横杠 = 收');
  assert.deepEqual(parseToolCallMarkers('abcdefghijkl').markers, [...DEFAULT_TOOLCALL_MARKERS],
    '12 字符但不含横杠 ⇒ 拒（并回退缺省：这是"全部条目都非法"那一条路，不是关掉检测）');
});

// ---------------------------------------------------------------------------
// ⑨ PR #555 复审 MED-2：一个**超长 marker** 不许拿到拒绝整条终态的能力
//
// 事实链（返工单里的复现）：`internal.js` 的 marker 校验在**开事务之前** ⇒ 400 ⇒ 终态不写、不重试。
// 所以丢弃必须发生在**源头**（runner 生成时 + agentd 透传时），portal 那道 400 只是契约闸。
// ---------------------------------------------------------------------------

test('#243 ⑨ 超长 marker ⇒ 只丢这个显示片段，布尔照传（120 边界两侧各钉一次）', () => {
  const cap = TEXTUALIZED_MARKER_MAX_CHARS;
  assert.equal(cap, 120, '上界是 120（与 portal 同名常量同源；跨面对账在下面那格）');

  const atCap = LT + 'x'.repeat(cap - 1);            // 恰好 120 字符
  const overCap = LT + 'x'.repeat(cap);              // 121 字符
  assert.equal(atCap.length, cap); assert.equal(overCap.length, cap + 1);

  // 用真正文驱动：正文里就是那条超长特征 ⇒ 命中成立，但片段不许上界面。
  assert.deepEqual(textualizedToolCallField('结论如上。' + NL + atCap, [atCap]),
    { textualized_tool_call: true, textualized_tool_call_marker: atCap },
    '恰好等于上界 ⇒ 片段照带（别把边界误伤掉）');
  assert.deepEqual(textualizedToolCallField('结论如上。' + NL + overCap, [overCap]),
    { textualized_tool_call: true },
    '超一个字符 ⇒ **只丢 marker**：布尔必须在，否则「命中」这件事整个消失');

  // 上界只管显示，**不许反过来取消命中**（判定与事件都不受影响）。
  assert.equal(detectTextualizedToolCall('结论如上。' + NL + overCap, [overCap]).hit, true,
    'detect 不设长度闸：超长照样判真');

  // 配置面：条目长过上限**不算非法**（照样参与判定），但必须提示一句会少一段片段——不许静默。
  const cfg = parseToolCallMarkers(overCap, { key: 'X_MARKER' });
  assert.deepEqual(cfg.invalid, [], '超长条目不是非法项：这么长的字面串照样能判定');
  assert.deepEqual(cfg.markers, [overCap]);
  assert.equal(cfg.warnings.length, 1, '但必须给一条告警，实得 ' + JSON.stringify(cfg.warnings));
  assert.ok(cfg.warnings[0].indexOf('marker') >= 0, '告警要说清"命中时不再带 marker 片段"，实得 ' + cfg.warnings[0]);
});

test('#243 ⑨ 跨面对账：runner 的上界 == portal 的上界，且两侧都不许是裸数字', () => {
  const root = path.join(RUNNER_DIR, '..');
  const readSide = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const grab = (src, name) => {
    const m = src.match(new RegExp('const ' + name + '\\s*=\\s*(\\d+)\\s*;'));
    assert.ok(m, name + ' 这个命名常量没找到（改成裸数字就等于两边各写一个数，那是下一次漂移的源头）');
    return Number(m[1]);
  };
  const runnerCap = grab(readSide('runner/lib/final-text-toolcall.js'), 'TEXTUALIZED_MARKER_MAX_CHARS');
  const portalCap = grab(readSide('portal/src/internal.js'), 'TEXTUALIZED_MARKER_MAX_CHARS');
  assert.equal(runnerCap, portalCap,
    '两侧上界必须相等（runner ' + runnerCap + ' vs portal ' + portalCap + '）');
  assert.equal(runnerCap, TEXTUALIZED_MARKER_MAX_CHARS, 'runner 侧的常量必须真的被代码用到（不是另一份副本）');
  // portal 侧不许再留裸 `> 120` 的比较（改成常量之后这条应当恒绿；漂回裸数字就红）
  assert.doesNotMatch(readSide('portal/src/internal.js'), /rawToolCallMarker\.length\s*>\s*120\b/,
    'portal 的校验必须走命名常量');
  // agentd 也必须用同一个常量（它是 worker → U2 的最后一道宿主关口）
  const agentdSrc = readSide('runner/agentd.js');
  assert.match(agentdSrc, /import \{ TEXTUALIZED_MARKER_MAX_CHARS \} from '\.\/lib\/final-text-toolcall\.js'/,
    'agentd 必须 import 同一个常量，而不是再抄一个数');
  assert.match(agentdSrc, /msg\.textualized_tool_call_marker\.length <= TEXTUALIZED_MARKER_MAX_CHARS/,
    'agentd 的透传必须带上长度闸');
});

test('#243 ⑨ agentd 兜底：worker 发来超长 marker（版本偏移）⇒ U2 只带布尔，终态不受影响', async () => {
  const long = LT + 'y'.repeat(TEXTUALIZED_MARKER_MAX_CHARS);   // 121 字符
  const body = await finishedBody({
    textualized_tool_call: true, textualized_tool_call_marker: long,
  });
  assert.equal(body.textualized_tool_call, true, '布尔必须照传（丢的只是显示片段）');
  assert.equal(Object.hasOwn(body, 'textualized_tool_call_marker'), false,
    '超长 marker 不许送到 portal——那边 400 打回的是整条终态');
  assert.equal(body.termination.reason, 'end_turn', '既有终态字段一个字没动');
  assert.equal(body.rounds, 32);
});

// ---------------------------------------------------------------------------
// ⑩ PR #555 复审 LOW-4：**代码块外**裸写标记 ⇒ 误报一条中性提示。这是**已知残余**，不是待修的 bug。
//
// 为什么接受：判据是「逐字子串」，一旦为了这种情况去加"位置/结构推断"，就会把真样本 B 那种
// 带空格的变体一起放掉（那才是实证过的形状）。代价是**多一条中性提示**，不是把一个正常 run
// 判成失败 ⇒ 净收益仍是正的。下一个人要改它，必须先拿出"改完不会漏真样本"的证据，别顺手改。
// ---------------------------------------------------------------------------

test('#243 ⑩ 钉现状：代码块**外**裸写标记会被判真（已知残余，代价是一条中性提示）', () => {
  const mentionsBare = '说明：标记 ' + DSML_OPEN + ' 只是名称，并非调用。';
  assert.equal(detectTextualizedToolCall(mentionsBare).hit, true,
    '现状：裸写（不在代码块里）会判真 —— 把它当 bug 顺手改掉之前，先证明不会漏掉真样本 B 那种带空格变体');
  // 同一段话只要把标记放进代码里就判假：这条残余的边界就是"有没有在代码里引用"。
  const quotedSame = '说明：标记 `' + DSML_OPEN + '` 只是名称，并非调用。';
  assert.equal(detectTextualizedToolCall(quotedSame).hit, false, '同一段话写进行内代码就判假');
});

// ---------------------------------------------------------------------------
// ⑪ PR #555 复审 LOW-3：非法条目的真实行为是**逐条**丢弃，**全部**非法才回退
//（"少于 3 条整份作废"那句是工单/PR 正文写错，supervisor 已用 REST 更正 PR 正文并回读；
//   返工段也记了同一句更正。代码从来是逐条丢弃 ⇒ 这一格只负责把口径钉在代码上。）
// ---------------------------------------------------------------------------

test('#243 ⑪ 口径以代码为准：一条合法就留那条，全部非法才回退缺省（不是整份作废、更不是关掉）', () => {
  const oneGood = parseToolCallMarkers('<tool_call', { key: 'X_MARKER' });
  assert.deepEqual(oneGood.markers, [TOOL_CALL_FEATURE], '单条合法就是单条：不因为"少于三条"整份作废');
  assert.deepEqual(oneGood.warnings, [], '合法条目不该有任何告警');
  assert.equal(oneGood.disabled, false);

  const twoGood = parseToolCallMarkers(TOOL_CALL_FEATURE + ',' + DSML_OPEN, { key: 'X_MARKER' });
  assert.equal(twoGood.markers.length, 2, '两条合法就留两条（条数门槛根本不存在）');
  assert.deepEqual(twoGood.invalid, []);

  const allBad = parseToolCallMarkers('off,chatcmpl', { key: 'X_MARKER' });
  assert.deepEqual(allBad.markers, [...DEFAULT_TOOLCALL_MARKERS], '全部非法 ⇒ 回退缺省');
  assert.equal(allBad.disabled, false, '回退不是关闭：配错不许把可见面一起吞掉');
  assert.ok(allBad.warnings.some((w) => w.indexOf('回退') >= 0), '回退这件事要响');
});
