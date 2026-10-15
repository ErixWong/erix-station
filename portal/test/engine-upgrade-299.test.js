// issue #299：把「前端不依赖引擎包」与「四形态表已写在能看见的地方」变成**可执行判据**。
//
// 为什么值得钉：
//  1. 0.19.0 §4 的 `.d.ts` 变更只打到 **TypeScript 消费方**。我们的判断是「对本仓不适用」，
//     而这个判断此前只存在于升级报告里 ⇒ 下一班会重新问一遍。本文件把它变成 0 命中的 grep。
//  2. 0.20.0 §6 把 `executeTool()` 的四种成功返回形态钉成契约，并导出判别式 `classifyFileToolResult`
//     （**只在 `erix-agent/tools` 子路径**，不进包根）。runner 已改用判别式；前端**不能引**它
//     （见判据 ①），只能手写 ⇒ 手写处必须把四形态表 + 上游判别式的名字写进注释，
//     否则「重新发现一次」是迟早的事（AGENTS §8.24 的反面）。
//
// 判据全部是**读源码**，零运行时依赖、零 LLM/DB/网络。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

/** 递归列出目录里的源码文件（跳过 node_modules / dist）。 */
function sources(dir) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sources(rel));
    else if (/\.(ts|vue|js)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

test('判据 ①：前端零依赖 erix-agent ⇒ 0.19 §4 的 .d.ts 变更对我们不适用（三向都 0）', () => {
  // a) 零 import（含 `from 'erix-agent/tools'` 这类子路径）
  const importers = sources('portal/frontend/src').filter((rel) => {
    const text = read(rel);
    return /(^|\n)\s*(import|export)[^\n]*from\s+['"]erix-agent(\/[^'"]*)?['"]/.test(text)
      || /require\(\s*['"]erix-agent/.test(text);
  });
  assert.deepEqual(importers, [], `前端出现了对 erix-agent 的 import：${importers.join(', ')}`);

  // b) 不在前端的 deps / devDependencies 里
  const pkg = JSON.parse(read('portal/frontend/package.json'));
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    assert.ok(!(field in pkg) || !('erix-agent' in (pkg[field] ?? {})),
      `portal/frontend/package.json 的 ${field} 里出现了 erix-agent ⇒ .d.ts 判据要重开`);
  }

  // c) 后端/runner 是 JS，没有 tsc 编译面（.d.ts 不会改变运行时解析）
  assert.equal(fs.existsSync(path.join(ROOT, 'portal/tsconfig.json')), false,
    'portal 若引入了 tsconfig，0.19 §4 的「宿主侧新类型错误」就要重跑一遍');
  assert.equal(fs.existsSync(path.join(ROOT, 'runner/tsconfig.json')), false, 'runner 同上');
});

test('判据 ②：四形态表在 runner 与前端各自可达的位置在册（防止「重新发现一次」）', () => {
  const runnerSrc = read('runner/lib/file-tools.js');
  assert.match(runnerSrc, /from 'erix-agent\/tools'[^;]*\bclassifyFileToolResult\b|classifyFileToolResult[^;]*from 'erix-agent\/tools'/,
    'runner 必须从 **erix-agent/tools 子路径**用上游判别式（0.20.0 §6；包根没有这个导出）');
  assert.match(runnerSrc, /classifyFileToolResult\(result\)/,
    'tree 根标签收口必须真的过判别式（不是只留了个 import）');
  assert.match(runnerSrc, /readFile\s*\/\s*edit\s*→\s*string|readFile \/ edit → string/,
    '四形态表必须在注释里在册（readFile/edit→string）');
  assert.match(runnerSrc, /writeFile[^。]{0,40}number[^。]{0,40}0[^。]{0,20}成功/,
    '必须写明「writeFile 的 0 是成功」这条坑');

  const feSrc = read('portal/frontend/src/lib/toolSummary.ts');
  assert.match(feSrc, /classifyFileToolResult/,
    '前端手写处必须点名上游判别式 `classifyFileToolResult`（哪怕不能引它）');
  assert.doesNotMatch(feSrc, /from ['"]erix-agent/, '前端仍然不得 import 该包（判据 ①）');
  for (const needle of ['text', 'bytes', 'content-metadata', 'unknown']) {
    assert.ok(feSrc.includes(needle), `前端注释里的四形态表缺 kind='${needle}' 一支`);
  }
});

test('判据 ③：随包契约套件的接入面在册（升级时不会漏跑）', () => {
  const envelope = read('runner/test/tool-result-envelope-contract.test.js');
  assert.match(envelope, /import \{ toolResultEnvelopeContract \} from 'erix-agent\/contract-tests'/,
    '0.20.0 新增的 toolResultEnvelopeContract 必须被接进我们自己的测试面');
  assert.match(envelope, /toolResultEnvelopeContract\('station-runner',\s*async \(\) => import\('erix-agent'\)\)/,
    '必须把**我们的**引擎入口命名空间交给套件（不是只 import 不用）');
  // 已接的两套仍在（engine-api / file-tools / transcript-store）
  for (const [file, name] of [
    ['portal/test/engine-api-contract.test.js', 'engineApiContract'],
    ['runner/test/file-tools-contract.test.js', 'fileToolsContract'],
    ['runner/test/store-contract.test.js', 'transcriptStoreContract'],
  ]) {
    assert.match(read(file), new RegExp(`\\b${name}\\(`), `${file} 不再跑随包套件 ${name}？`);
  }
});
