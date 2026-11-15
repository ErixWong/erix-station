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
import {
  DEFAULT_TOOLCALL_MARKERS,
  TOOLCALL_MARKERS_ENV,
  detectTextualizedToolCall,
  parseToolCallMarkers,
  toolCallMarkersFromEnv,
} from '../lib/final-text-toolcall.js';

const U = '\uff5c'; // \uff5c FULLWIDTH VERTICAL LINE —— DSML 标记的分隔符（U+FF5C），写成常量免得靠肉眼数竖线。
const DSML_OPEN = '<' + U + U + 'DSML' + U + U; // <\uff5c\uff5cDSML\uff5c\uff5c
const NL = '\n'; // 唯一的换行字面量：多行样本一律 join(NL)
const FENCE = '\u0060'.repeat(3); // ``` 代码围栏（引用形状用）
const LT = '<'; const GT = '>'; // 尖括号常量：同族变体夹具用它们拼，别在夹具里写死特征字面串
const DSML_FEATURE = DEFAULT_TOOLCALL_MARKERS[0];
const TOOL_CALL_FEATURE = '<tool_call';
const FUNCTION_FEATURE = '<\uff5cFunction';

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
  for (const marker of DEFAULT_TOOLCALL_MARKERS) {
    assert.ok(typeof marker === 'string' && marker.indexOf('<') >= 0,
      '每条特征都必须是含尖括号的标记串，实得 ' + JSON.stringify(marker));
  }
  assert.deepEqual([...DEFAULT_TOOLCALL_MARKERS], [DSML_OPEN, TOOL_CALL_FEATURE, FUNCTION_FEATURE],
    '缺省三条 = DSML 前缀 / tool_call 一族 / Function 一族。DSML 取到竖线为止：真样本 B 写作带空格的'
    + ' invoke、真样本 A 首行是 tool_calls，拿"到 invoke 为止"那种字面串当特征会两条都漏。');
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

test('#243 ④ 配置：未设 ⇒ 缺省三条；off ⇒ 显式关闭但必须响一声', () => {
  for (const raw of [undefined, null, '', '   ']) {
    const got = parseToolCallMarkers(raw);
    assert.deepEqual(got.markers, [...DEFAULT_TOOLCALL_MARKERS], JSON.stringify(raw) + ' 应回退缺省三条');
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
    '全部条目都非法 ⇒ 回退缺省三条，**不是**关掉检测（配错不该把可见面一起吞掉）');
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
    'env 里没有那个键 ⇒ 缺省三条');
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
      '同一批夹具在缺省三条下必须判假 —— 两向一起看，才说明"不误伤"是靠特征形状做到的，不是靠运气');
  }
});
