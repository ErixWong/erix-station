// issue #212 防漂移测试：termination reason / 可重试码的**单一常量 ↔ 文档枚举表**逐项一致。
//
// 背景：erix-agent 0.18.0 的失败/中止走 fail() 抛异常，上抛错误挂着完整 termination
// （reason 可能是 persistence_failed，并带 operation/phase/sideEffect）。station 曾把它拍平成
// failed，且文档/前端的 reason 集合漏值。本文件钉住四件事：
//   ① 代码单一常量（portal/frontend/src/lib/terminationReasons.ts）自洽且可被 node 直读；
//   ② 文档里那份枚举表（docs/data/model.md §1.7、docs/api/portal.md §4.1/§5.3）与常量逐项一致；
//   ③ runner 侧运行时镜像常量（runner/lib/termination.js）与前端码集逐项一致；
//   ④ 直接读 erix-agent 包源码交叉核对（typedef 的 9 值 + persistence_failed 字面量 + 上游
//      RETRYABLE_CODES），升级引擎时这里是 tripwire。
//
// 文档侧锚点格式（唯一被本测试承认的机器可读形状）：
//   <!-- DRIFT:<name>:begin --> ... `xxx ∈ {a, b, c}` ... <!-- DRIFT:<name>:end -->
//   取块内**第一对花括号**里的逗号分隔项作为枚举项。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ENGINE_VERSION_FOR_TERMINATION_REASONS,
  LEGACY_TERMINATION_REASONS,
  PERSISTENCE_TERMINATION_REASON,
  RUN_END_LABEL_REASONS,
  RUN_FAIL_REASON_LIST,
  RUN_FAIL_REASONS,
  RUN_RETRYABLE_ERROR_CODES,
  RUN_TERMINATION_SYSERR_REASONS,
  TERMINATION_REASONS,
  USER_STOP_TERMINATION_REASON,
} from '../frontend/src/lib/terminationReasons.ts'; // node 22 类型剥离：直读前端 .ts（无运行时依赖）
import { RETRYABLE_ERROR_CODES as RUNNER_RETRYABLE_CODES } from '../../runner/lib/termination.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '../..');

const DOCS = {
  'docs/data/model.md': 'model.md',
  'docs/api/portal.md': 'portal.md',
};

/** 抽取 `<!-- DRIFT:<name>:begin --> … <!-- DRIFT:<name>:end -->` 块内第一对花括号的枚举项。 */
function driftBlocks(file, name) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const re = new RegExp(`<!--\\s*DRIFT:${name}:begin\\s*-->([\\s\\S]*?)<!--\\s*DRIFT:${name}:end\\s*-->`, 'g');
  const found = [...text.matchAll(re)];
  return found.map((m, i) => {
    const braces = /\{([^{}]*)\}/.exec(m[1]);
    assert.ok(braces, `${file}#${i}：${name} 锚点块内缺少 \`xxx ∈ {a, b}\` 形式的枚举`);
    return braces[1].split(',').map((t) => t.trim()).filter((t) => t.length > 0);
  });
}

function assertSameItems(actual, expected, where) {
  assert.ok(Array.isArray(actual) && actual.length > 0, `${where}：空枚举`);
  for (const item of actual) {
    assert.match(item, /^[a-z][a-z_]{2,}$/, `${where}：非法枚举项 ${JSON.stringify(item)}`);
  }
  const a = [...new Set(actual)].sort();
  const e = [...new Set(expected)].sort();
  assert.deepEqual(a, e, `${where}：与常量不一致（缺：${e.filter((x) => !a.includes(x))}；多：${a.filter((x) => !e.includes(x))}）`);
  assert.equal(actual.length, a.length, `${where}：枚举项重复`);
}

test('常量自洽：reason 全集 10 值、红色子集是真子集、legacy 值不在全集内', () => {
  assert.equal(TERMINATION_REASONS.length, 10);
  // issue #212 补进来的两值必须在全集里（引擎 0.17.0 实际产出）
  assert.ok(TERMINATION_REASONS.includes('persistence_failed'));
  assert.ok(TERMINATION_REASONS.includes('final_guard_unverified'));
  // 旧文档残留值不得再当枚举值
  for (const legacy of LEGACY_TERMINATION_REASONS) assert.ok(!TERMINATION_REASONS.includes(legacy), legacy);
  // 红色子集逐项属于全集，且含 #212 的两值（决策：两者语义都要求用户看见）
  for (const r of RUN_FAIL_REASON_LIST) assert.ok(TERMINATION_REASONS.includes(r), `红色子集含未知值 ${r}`);
  for (const r of ['failed', 'max_rounds_cap', 'aborted', 'persistence_failed', 'final_guard_unverified']) {
    assert.ok(RUN_FAIL_REASON_LIST.includes(r), `红色子集缺 ${r}`);
  }
  // 正常/中性 reason 绝不允许进红色集合（否则灰色分隔条语义丢失）
  for (const r of ['end_turn', 'no_tool', 'judge_done']) {
    assert.ok(!RUN_FAIL_REASON_LIST.includes(r), `${r} 不该是红色告警`);
  }
  assert.equal(PERSISTENCE_TERMINATION_REASON, 'persistence_failed');
  // issue #236：双语标签覆盖「除 end_turn 外的每个 reason」（end_turn 走 runEndNormal）
  for (const r of RUN_END_LABEL_REASONS) assert.ok(TERMINATION_REASONS.includes(r), `标签表含未知值 ${r}`);
  assert.deepEqual(
    [...RUN_END_LABEL_REASONS].sort(),
    TERMINATION_REASONS.filter((r) => r !== 'end_turn').sort(),
    '标签表 = 全集减 end_turn（#236 的覆盖面：任何 reason 都不许裸英文上屏）',
  );
  // issue #236：界面刷红集合 = 红色集合减掉「用户主动停止」（派生，不手抄）
  assert.equal(USER_STOP_TERMINATION_REASON, 'aborted');
  assert.ok(RUN_FAIL_REASONS.has(USER_STOP_TERMINATION_REASON), 'aborted 仍属功能面集合（#261B 重试 / #306 补拉）');
  assert.deepEqual(
    [...RUN_TERMINATION_SYSERR_REASONS].sort(),
    [...RUN_FAIL_REASONS].filter((r) => r !== USER_STOP_TERMINATION_REASON).sort(),
    '界面刷红集合必须由红色集合派生（减 aborted）',
  );
  assert.ok(!RUN_TERMINATION_SYSERR_REASONS.has(USER_STOP_TERMINATION_REASON), 'aborted 不得再刷红');
});

test('常量落点可被 node --test 直读：前端 .ts 零 import、零非 erasable 语法', () => {
  const src = fs.readFileSync(path.join(ROOT, 'portal/frontend/src/lib/terminationReasons.ts'), 'utf8');
  assert.doesNotMatch(src, /^\s*import\s/m, '常量文件必须零 import（后端测试直读依赖这一点）');
  assert.doesNotMatch(src, /^\s*(export\s+)?(enum|namespace)\s/m, '禁止 enum/namespace（非 erasable，node 直读会挂）');
  // 前端运行时确实从这份常量取红色集合（不存在第二份枚举字面量）
  const stream = fs.readFileSync(path.join(ROOT, 'portal/frontend/src/composables/useEventStream.ts'), 'utf8');
  assert.match(stream, /from '\.\.\/lib\/terminationReasons'/);
  assert.doesNotMatch(stream, /new Set\(\[[^\]]*'persistence_failed'/, '红色集合不得在前端另抄一份字面量');
});

test('文档枚举表与常量逐项一致（DRIFT 锚点）', () => {
  // reason 全集：model.md §1.7 与 portal.md §4.1/§5.3 三处都必须在，且都等于常量
  const perFile = { 'docs/data/model.md': 1, 'docs/api/portal.md': 2 };
  for (const [file, expectedBlocks] of Object.entries(perFile)) {
    const blocks = driftBlocks(file, 'termination-reason');
    assert.equal(blocks.length, expectedBlocks, `${file}：termination-reason 锚点块数量不符`);
    blocks.forEach((items, i) => assertSameItems(items, TERMINATION_REASONS, `${file}#${i} termination-reason`));
  }
  // 旧值不得出现在任何锚点块里（文档别把它当枚举值列回去）
  for (const file of Object.keys(DOCS)) {
    for (const items of driftBlocks(file, 'termination-reason')) {
      for (const legacy of LEGACY_TERMINATION_REASONS) {
        assert.ok(!items.includes(legacy), `${file}：锚点块里出现了 legacy 值 ${legacy}`);
      }
    }
  }
});

test('文档写明 schema.sql 注释不作真值来源（baseline 冻结，方案 A：一个字节都不改）', () => {
  const model = fs.readFileSync(path.join(ROOT, 'docs/data/model.md'), 'utf8');
  assert.match(model, /schema\.sql[^\n]*注释[^\n]*不作为真值来源/);
  assert.match(model, /baseline 冻结/);
  assert.match(model, /refusing to start/);
  // 红线本身：schema.sql 里那段历史注释（v0.3.5 + reflection_stop）必须还在，说明它没被改过
  const schema = fs.readFileSync(path.join(ROOT, 'docs/data/schema.sql'), 'utf8');
  assert.match(schema, /reflection_stop/);
  assert.match(schema, /erix-agent v0\.3\.5/);
});

test('runner 运行时镜像与前端码集、文档 §6.4 锚点逐项一致；worker 不再手写半截清单', () => {
  const canonical = [...RUN_RETRYABLE_ERROR_CODES].sort();
  assert.deepEqual([...RUNNER_RETRYABLE_CODES].sort(), canonical);
  driftBlocks('docs/api/portal.md', 'run-retryable-error-code')
    .forEach((items, i) => assertSameItems(items, canonical, `portal.md#${i} run-retryable-error-code`));
  assert.deepEqual(canonical, ['checkpoint_failed', 'disconnect', 'rate_limited', 'server', 'timeout']);

  const worker = fs.readFileSync(path.join(ROOT, 'runner/worker.js'), 'utf8');
  // 入参表被 issue #370 扩到三参数（新增 `steered`，只往 termination.detail 补 'steered'，不改 reason）。
  // 本断言的原意不变：worker 的 catch 必须**只有这一处**信封构造、没有第二份手写实现——所以仍是精确
  // 匹配调用形状而不是放宽成 /buildFailureEnvelope\(/（放宽就测不出「有人另写了一份」）。
  assert.match(worker, /buildFailureEnvelope\(\{ err, aborted, steered \}\)/);
  assert.doesNotMatch(worker, /code === 'checkpoint_failed'/, 'worker 里的手写半截清单必须删掉');
  assert.doesNotMatch(worker, /termination: \{ reason: aborted \? 'aborted' : 'failed' \}/,
    'worker 不得再把引擎 termination 拍平成 {reason: failed}');
});

test('引擎源码交叉核对（升级 erix-agent 时的 tripwire）', async () => {
  const engineEntry = import.meta.resolve('erix-agent'); // …/erix-agent/src/index.js
  const engineRoot = path.resolve(fileURLToPath(engineEntry), '..', '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(engineRoot, 'package.json'), 'utf8'));
  // 常量声明对齐的引擎版本 = 实际安装的引擎版本 = 两处 package.json 的 pin
  assert.equal(pkg.version, ENGINE_VERSION_FOR_TERMINATION_REASONS,
    'erix-agent 版本变了：必须重开 issue 复核 reason 全集，再改常量与文档');
  for (const rel of ['package.json', 'runner/package.json']) {
    const root = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    assert.equal(root.dependencies['erix-agent'], ENGINE_VERSION_FOR_TERMINATION_REASONS, `${rel} 的 pin 与常量不符`);
  }

  const orchestrator = fs.readFileSync(path.join(engineRoot, 'src/loop/orchestrator.js'), 'utf8');
  // typedef 的 9 值必须全部落在常量里。⚠ 0.19.0 起 typedef 从单行（0.18.0 `:511`）改成了多行块
  // （`termination:{` 换行 `* reason:"end_turn"|…`，0.19.0 `:443-444`），所以这里的正则必须容忍
  // `termination:{` 与 `reason:` 之间的换行与 JSDoc 前导 `*`。**断言强度未变**：仍要求恰好 9 值、
  // 逐值落在常量里（见下），只是从两个形状都能取到值。
  const typedef = /termination:\{\s*(?:\*\s*)?reason:((?:"[a-z_]+"?\|?)+)/.exec(orchestrator);
  assert.ok(typedef, '引擎 termination typedef 形状变了：重开 issue 复核 reason 全集');
  const jsDocValues = [...typedef[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert.equal(jsDocValues.length, 9, `typedef 值数与预期不符：${jsDocValues.join(',')}`);
  for (const v of jsDocValues) assert.ok(TERMINATION_REASONS.includes(v), `typedef 值 ${v} 不在常量里`);
  // 未写进 typedef 但会实际产出的 persistence_failed（fail() 里定值 + 挂落盘细节）
  // fail() 里的定值三元：signal.aborted ? "aborted" : persistenceFailure === undefined ? "failed" : "persistence_failed"
  assert.match(orchestrator, /\?\s*"failed"\s*:\s*"persistence_failed"/, '引擎不再产出 persistence_failed？复核常量');
  assert.match(orchestrator, /const reason = signal\?\.aborted/, 'fail() 的 reason 判定形状变了？复核透传口径');
  assert.match(orchestrator, /operation:\s*persistenceFailure\.operation/, '引擎不再挂 operation/phase/sideEffect？复核透传');

  // 上游可重试码集（provider 层）
  const errors = fs.readFileSync(path.join(engineRoot, 'src/providers/errors.js'), 'utf8');
  const upstream = /RETRYABLE_CODES\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(errors);
  assert.ok(upstream, '上游 RETRYABLE_CODES 形状变了：复核 runner 的 retryable 判据');
  const upstreamCodes = [...upstream[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...RUNNER_RETRYABLE_CODES].filter((c) => c !== 'checkpoint_failed').sort(),
    upstreamCodes.sort(), 'runner 可重试码与上游 provider 层不一致');
});
