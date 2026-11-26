// 本仓自有显示投影的黄金样例 + 拥有权闸（erix-station issue #812）。
//
// 这些**全是字面量**：期望值从本仓 `portal/src/display-projection.js` 一次快照里抄下，
// 测试期**不引 erix-agent 当 oracle**——本单的整个前提就是引擎已把这条 API 从包根摘除
// （#928），拿它当基准的断言要随断言一起被改写成字面值。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { projectTranscriptForDisplay } from '../src/display-projection.js';

// ---------------------------------------------------------------------------
// 黄金样例：期望一律写死字面量，钉住「搬家没改口径」。
// ---------------------------------------------------------------------------

test('#812 黄金样例 · 用户 / 助手正文 + reasoning 分离 + 视图键', () => {
  const turns = projectTranscriptForDisplay([
    {
      round: 0,
      ts: '2026-01-01T00:00:00Z',
      dedupKey: 'sess:input:m1',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello there' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'hi, working' }, { type: 'thinking', thinking: 'let me think' }] },
      ],
    },
  ]);
  assert.deepEqual(turns, [
    {
      role: 'user',
      text: 'hello there',
      blocks: [{ type: 'text', text: 'hello there' }],
      round: 0,
      ts: '2026-01-01T00:00:00Z',
      meta: { synthetic: false, dedupKey: 'sess:input:m1' },
      key: '0#0:0',
    },
    {
      role: 'assistant',
      text: 'hi, working',
      blocks: [
        { type: 'text', text: 'hi, working' },
        { type: 'thinking', thinking: 'let me think' },
      ],
      reasoning: 'let me think',
      round: 0,
      ts: '2026-01-01T00:00:00Z',
      meta: { synthetic: false, dedupKey: 'sess:input:m1' },
      key: '0#0:1',
    },
  ]);
});

test('#812 黄金样例 · tool_use 与 tool_result 配对：预览 / isError / 状态 / 耗时', () => {
  const turns = projectTranscriptForDisplay([
    {
      round: 1,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'read the file' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'reading' }, { type: 'tool_use', id: 'tc1', name: 'readFile', input: { path: 'src/a.js' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'file contents here', is_error: false, erix: { executionStatus: 'completed', durationMs: 12 } }] },
      ],
    },
  ]);
  assert.equal(turns.length, 2, 'tool_result-only 的用户行是模型管道，不出气泡');
  const assistant = turns[1];
  assert.equal(assistant.role, 'assistant');
  assert.deepEqual(assistant.toolCalls, [
    {
      name: 'readFile',
      id: 'tc1',
      argsSummary: 'path=src/a.js',
      resultPreview: 'file contents here',
      isError: false,
      executionStatus: 'completed',
      durationMs: 12,
      key: '1#0:1:t0',
    },
  ]);
  assert.equal(assistant.key, '1#0:1');
});

test('#812 黄金样例 · 折叠摘要（marker 是线上存量字面值，逐字保留）', () => {
  const turns = projectTranscriptForDisplay([
    {
      round: 5,
      folded: true,
      foldedRoundRange: { from: 1, to: 4 },
      messages: [],
      foldedPayload: [
        { role: 'user', content: [{ type: 'text', text: '【上下文折叠·v1·erix-9f6e2c】早期第 1–4 轮（共 4 轮）已折叠。工具足迹：readFile。' }] },
      ],
    },
  ]);
  assert.deepEqual(turns, [
    {
      role: 'system',
      text: '【上下文折叠·v1·erix-9f6e2c】早期第 1–4 轮（共 4 轮）已折叠。工具足迹：readFile。',
      blocks: [],
      folded: true,
      round: 5,
      meta: {
        synthetic: true,
        source: 'fold-summary',
        foldedRoundRange: { from: 1, to: 4 },
        foldedPayloadMessages: 1,
      },
      key: '5#0:0',
    },
  ]);
});

test('#812 黄金样例 · 注入消息（meta.source）走合成、system 角色', () => {
  const turns = projectTranscriptForDisplay([
    { round: 2, messages: [{ role: 'system', content: [{ type: 'text', text: 'judge direction hint' }], meta: { source: 'direction-hint' } }] },
  ]);
  assert.deepEqual(turns, [
    {
      role: 'system',
      text: 'judge direction hint',
      blocks: [{ type: 'text', text: 'judge direction hint' }],
      round: 2,
      meta: { synthetic: true, source: 'direction-hint' },
      key: '2#0:0',
    },
  ]);
});

test('#812 黄金样例 · 无消息行回退 response，并透传 stopReason / usage / toolUses / dedupKey', () => {
  const turns = projectTranscriptForDisplay([
    { round: 3, response: { content: [{ type: 'text', text: 'from response' }], stopReason: 'end_turn', usage: { input: 7, output: 3 } }, toolUses: 2, dedupKey: 'sess:engine:round:3' },
  ]);
  assert.deepEqual(turns, [
    {
      role: 'assistant',
      text: 'from response',
      blocks: [{ type: 'text', text: 'from response' }],
      round: 3,
      meta: {
        synthetic: false,
        stopReason: 'end_turn',
        usage: { input: 7, output: 3 },
        toolUses: 2,
        dedupKey: 'sess:engine:round:3',
      },
      key: '3#0:0',
    },
  ]);
});

test('#812 黄金样例 · 配不上对的调用**缺键**（不伪造 resultPreview），预览尺只在投影一侧', () => {
  const turns = projectTranscriptForDisplay([
    { round: 6, messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'tcX', name: 'exec', input: { command: 'ls' } }] }] },
  ]);
  const call = turns[0].toolCalls[0];
  assert.deepEqual(call, { name: 'exec', id: 'tcX', argsSummary: 'command=ls', key: '6#0:0:t0' });
  assert.equal('resultPreview' in call, false, '没有配对依据 ⇒ 缺键，不是空串');
});

// ---------------------------------------------------------------------------
// 拥有权闸：投影已经**不再从 erix-agent 取**，谁再这么取就该红，而不是门户加载期崩。
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SELF = fileURLToPath(import.meta.url);
const MODULE = path.join(ROOT, 'portal', 'src', 'display-projection.js');

// 逐字符状态机去注释（保留字符串内的斜杠），与 engine-removed-exports.test.js 同一口径。
function stripComments(source) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote !== null) {
      out += ch;
      if (ch === '\\') { out += source[i + 1] ?? ''; i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; i += 1; continue; }
    out += ch;
    i += 1;
  }
  return out;
}

function sourceFilesUnder(rel) {
  const files = [];
  const walk = (target) => {
    const abs = path.join(ROOT, target);
    if (!fs.existsSync(abs)) return;
    if (fs.statSync(abs).isFile()) {
      if (/\.(js|mjs|cjs)$/.test(abs)) files.push(abs);
      return;
    }
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      walk(path.join(target, entry.name));
    }
  };
  walk(rel);
  return files;
}

test('#812 拥有权闸 · 任何 portal 源码都不得再从 erix-agent 取这条投影（三种写法全挡）', () => {
  const scan = ['portal/src', 'portal/test'].flatMap((rel) => sourceFilesUnder(rel));
  assert.ok(scan.length > 0, '扫描面不能为空（目录被搬走 ⇒ 直接红，不静默少扫）');

  const namedImport = /import\s*\{[^}]*\bprojectTranscriptForDisplay\b[^}]*\}\s*from\s*['"]erix-agent['"]/;
  const starImport = /import\s*\*\s*as\s+\w+\s+from\s*['"]erix-agent['"]/;
  const dynamicImport = /import\s*\(\s*['"]erix-agent['"]\s*\)/;
  const references = /\bprojectTranscriptForDisplay\b/;

  const offenders = [];
  for (const abs of scan) {
    if (abs === SELF || abs === MODULE) continue;
    const code = stripComments(fs.readFileSync(abs, 'utf8'));
    const rel = path.relative(ROOT, abs);
    if (namedImport.test(code)) offenders.push(`${rel}：具名从 erix-agent 取投影`);
    else if (references.test(code) && starImport.test(code)) offenders.push(`${rel}：命名空间 import * 自 erix-agent 后点出投影`);
    else if (references.test(code) && dynamicImport.test(code)) offenders.push(`${rel}：await import('erix-agent') 解构投影`);
  }
  assert.deepEqual(offenders, [], `投影已归本仓 portal/src/display-projection.js，不应再从 erix-agent 取：\n  ${offenders.join('\n  ')}`);
});

test('#812 拥有权闸 · 本仓里 projectTranscriptForDisplay 的实现恰好一处', () => {
  const defs = [];
  for (const abs of sourceFilesUnder('portal/src')) {
    const code = stripComments(fs.readFileSync(abs, 'utf8'));
    const hits = code.match(/export\s+(?:default\s+)?function\s+projectTranscriptForDisplay\b/g) ?? [];
    for (let k = 0; k < hits.length; k += 1) defs.push(path.relative(ROOT, abs));
  }
  assert.equal(defs.length, 1, `实现必须恰好一处（多了就是第二把尺），实际：${JSON.stringify(defs)}`);
  assert.equal(defs[0], path.join('portal', 'src', 'display-projection.js'));
});
