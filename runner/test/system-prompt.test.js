// SYSTEM_PROMPT 防漂移（2026-10-10，首次真实 http 部署前补票）
//
// 为什么要钉这个：issue #228 把文件工具换成上游 erix-agent 0.18.0 的 createFileTools 之后，
// 工具面变了（`rg` 退役 → `searchText`、新增 `edit`、readFile 有界读、遍历默认跳过 vendor），
// 但 worker 的 system prompt 还停在 fork 时代。真机已实例化的损失：模型不知道 `searchText` 的
// `mode` 必填、不知道默认跳过 node_modules/点目录，看到「（无命中）」就误判「代码里没有」，
// 甚至绕去跑 shell 命令——每一-条都是一轮白烧的 token。
//
// 断言口径（两条，都不允许硬编码第二份清单）：
//   ① 工具名集合取自**注册面**（createStationFileTools 的 schemas，即 worker 真正喂给
//      createToolRegistry 的那批名字），逐个名字必须在提示词里出现；
//   ② 关键语义（mode 必填无默认、默认跳过 vendor/点目录 + 撤销开关、edit 精确匹配且失败不落盘、
//      readFile 有界读与「下一步」marker、被遮蔽/越界的错误文本含义）必须写进提示词。
// 技法：worker.js 顶层有 fork 期副作用（umask / process.on('message') / WORKER_READY），单测进程里
// 不 import 它（沿用 termination.test.js / abort-signal.test.js 的源码级断言先例），改成把
// 模板字面量抠出来断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJail, createStationFileTools } from '../lib/file-tools.js';

const RUNNER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 从 worker.js 源码里抠出 SYSTEM_PROMPT 的模板字面量**内容**（不含首尾反引号）。
 * 扫描时跳过转义反引号（\`）——提示词正文里就有一处（项目目录那个）。
 */
function extractSystemPrompt(src) {
  const decl = 'const SYSTEM_PROMPT = `';
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, 'worker.js 必须仍有 `const SYSTEM_PROMPT = \`` 声明');
  let i = start + decl.length;
  let end = -1;
  for (; i < src.length; i += 1) {
    if (src[i] === '\\') { i += 1; continue; }          // 跳过转义对（\\ \` \${ 等）
    if (src[i] === '`') { end = i; break; }
  }
  assert.notEqual(end, -1, 'SYSTEM_PROMPT 模板字面量没有收尾反引号');
  assert.equal(src.slice(end + 1, end + 2), ';', 'SYSTEM_PROMPT 声明必须紧跟分号（抠取器假设的形状变了要同步本文件）');
  return src.slice(start + decl.length, end).replace(/\\\//g, '/').replace(/\\`/g, '`').replace(/\\\$/g, '$');
}

/** 提示词里某个工具/关键词所在的那几行（用来断言语义与其主语同段）。 */
function linesMentioning(prompt, needle) {
  return prompt.split('\n').filter((line) => line.includes(needle));
}

async function withRegisteredFileTools(fn) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'erix-prompt-test-')));
  try {
    const jail = createJail({ root: dir, writable: [dir] });
    // worker.js 里喂给 createToolRegistry 的就是 fileTools.schemas（同名 executor 一对一），
    // 所以这里的 schemas 就是「注册进 registry 的文件工具名」的正解来源。
    await fn(createStationFileTools({ jail, cwd: dir }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('SYSTEM_PROMPT 提到每一个注册进 registry 的文件工具名（名字取自注册面，不另立清单）', async () => {
  const prompt = extractSystemPrompt(fs.readFileSync(path.join(RUNNER_DIR, 'worker.js'), 'utf8'));
  assert.ok(prompt.length > 200, 'SYSTEM_PROMPT 不该是空壳');

  await withRegisteredFileTools((fileTools) => {
    const registered = fileTools.schemas.map((schema) => schema.name);
    assert.ok(registered.length >= 5, `注册面至少 5 个文件工具，实际 ${registered.length}`);
    for (const name of registered) {
      assert.ok(
        linesMentioning(prompt, name).length > 0,
        `注册了 ${name} 却没在 SYSTEM_PROMPT 里解释用法——真机上模型只会凭旧先验乱调（issue #228 后已实例化过一次）`,
      );
    }
    // 注册面本身不许悄悄混进别名（别名出现在提示词里必须是否定语境，见下一条用例）
    assert.deepEqual(
      registered.filter((name) => name === 'rg' || name === 'grep'),
      [],
      'rg / grep 是退役别名，不得进 station 注册面（AGENTS.md §8.9）',
    );
  });
});

test('SYSTEM_PROMPT 写清 searchText 的 mode 必填无默认，且默认跳过 vendor/点目录 + 给出撤销开关', () => {
  const prompt = extractSystemPrompt(fs.readFileSync(path.join(RUNNER_DIR, 'worker.js'), 'utf8'));
  const searchLines = linesMentioning(prompt, 'searchText');
  assert.ok(searchLines.length > 0, '提示词必须讲 searchText');
  const searchText = searchLines.join('\n');

  // ① mode 必填、无默认、两个取值都要写出来（缺省猜值是上游 #195 明确否决的行为）
  assert.match(searchText, /mode/, '必须点名 mode 参数');
  assert.match(searchText, /必填|必须传/, '必须写明 mode 必填');
  assert.match(searchText, /没有默认值|无默认/, '必须写明 mode 无默认值（不猜）');
  assert.match(searchText, /mode="literal"/u, '必须给出字面量取值');
  assert.match(searchText, /mode="regex"/u, '必须给出正则取值');

  // ② 默认跳过 vendor 与点目录 + 排除账 + 撤销开关（模型不知道被排除了就无从发起取回）
  assert.match(searchText, /node_modules/, '必须点名默认跳过的 vendor 目录');
  assert.match(searchText, /默认跳过|默认.*跳过/, '必须写明这是默认行为');
  assert.match(searchText, /已跳过/u, '必须解释结果尾部的排除账文案');
  assert.match(searchText, /include_vendor=true/, '必须给出撤销 vendor 跳过的开关名与写法');
  assert.match(searchText, /include_hidden=true/, '必须给出撤销点目录跳过的开关名与写法');
  assert.match(searchText, /（无命中）/u, '必须解释无命中文案，且与错误文本区分开');
  assert.match(searchText, /无效正则/u, '必须解释无效正则文案（与无命中含义不同）');

  // ③ 名字过滤只匹配文件名（不跨 /）——真机上 "**/*.ts" 是常见的空结果来源
  assert.match(prompt, /不跨越|不跨 /, 'name_pattern 不跨 / 的口径必须写进提示词');
});

test('SYSTEM_PROMPT 写清 edit 只做逐字节精确匹配且失败整次不落盘、readFile 有界读带下一步', () => {
  const prompt = extractSystemPrompt(fs.readFileSync(path.join(RUNNER_DIR, 'worker.js'), 'utf8'));

  const editLines = linesMentioning(prompt, 'edit').join('\n');
  assert.match(editLines, /edits:\[\{oldText, ?newText\}\]|edits: *\[\{oldText, ?newText\}\]/,
    '必须给出 edits 的入参形状（模型凭旧先验会传 old_string/new_string）');
  assert.match(editLines, /逐字节精确匹配|精确匹配/, '必须写明只做精确匹配');
  assert.match(editLines, /没有模糊兜底|没有?任何模糊兜底|无模糊兜底/, '必须写明没有模糊兜底');
  assert.match(editLines, /恰好命中一次|命中一次/, '必须写明每条必须唯一命中');
  assert.match(editLines, /0 处|0 次/, '必须写明 0 命中也是失败');
  assert.match(editLines, /多处|多个/, '必须写明多处命中也是失败');
  assert.match(editLines, /不落盘|一个字节都不落盘/, '必须写明失败时整次不落盘');
  assert.match(editLines, /readFile/, '必须要求 oldText 从 readFile 输出逐字取');

  const readLines = linesMentioning(prompt, 'readFile').join('\n');
  assert.match(readLines, /256KB/, '必须写明单次返回的字节上限（上游默认 262144）');
  assert.match(readLines, /下一步|offset=/, '必须写明截断 marker 给了下一步（offset 续读 / 提高 max_bytes）');
  assert.match(readLines, /max_bytes/, '必须点出提高 max_bytes 这条出路');

  // 被挡与越界是同一个错误前缀：不解释清楚，模型会在同一个遮蔽路径上反复重试
  assert.match(prompt, /被宿主边界拒绝/u, '必须解释「被宿主边界拒绝」错误文本');
});

test('SYSTEM_PROMPT 里出现的退役别名必须是否定语境（不得把 rg/grep 说成可用工具）', () => {
  const prompt = extractSystemPrompt(fs.readFileSync(path.join(RUNNER_DIR, 'worker.js'), 'utf8'));
  const aliasLines = prompt
    .split('\n')
    .filter((line) => /(?<![A-Za-z0-9_])(rg|grep)(?![A-Za-z0-9_])/.test(line));
  // 别名可以提（模型旧先验里就是这两个名字），但只能以「没注册/退役」的面目出现
  for (const line of aliasLines) {
    assert.match(line, /退役|没注册|未注册|不存在|别名/,
      `别名出现在这里但不是否定语境：${line}`);
  }
});

test('提示词里的 shell 仍是命令执行面（文件工具不执行命令，这条不能随工具面改版丢）', () => {
  const prompt = extractSystemPrompt(fs.readFileSync(path.join(RUNNER_DIR, 'worker.js'), 'utf8'));
  assert.match(prompt, /shell/, '提示词必须点名 shell（issue #72 起它是唯一命令执行面）');
  // 「shell 有意不受文件遮蔽约束」那句不对称属于 maskedPaths 那一片（见 runner/test/masked-paths.test.js）；
  // 本文件不提前断言一个本片还没交付的性质，否则 B 片会依赖 C 片的改动才能绿。
});
