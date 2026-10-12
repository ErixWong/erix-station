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

// issue #240 引入、#246 交付①改口径：预览端口段由平台从全局号池**分配**，提示词必须复述
// 「`~/.erix/ports.json` 的清单是唯一真相」。
// 为什么比 #240 的写法更硬：这条提示词与 portal 侧常量是**两个包里的两份文案**，决策者拍的是
// 「告知 + 尽力」（容器侧不做端口管控，没有任何机制会替我们发现漂移）。#246 后每个 FDE 拿哪一段是
// **运行时决定**的（还会被管理员改段）⇒ 提示词里**不许出现任何端口数字**：抄一份号（无论是旧的
// 4000–4009 还是号池边界 22000–29999）就是埋下一份必然漂移的第二清单。
/** 抠出「预览域名与端口」整段（从标题行到下一个空行）——按段断言，避免靠关键词跨行凑齐语义。 */
function previewSection(prompt) {
  const lines = prompt.split('\n');
  const start = lines.findIndex((l) => l.startsWith('预览域名与端口'));
  assert.notEqual(start, -1, 'SYSTEM_PROMPT 必须有「预览域名与端口」这一段（#240/#246 的告知落点之一）');
  const rest = lines.slice(start);
  const end = rest.findIndex((l) => l.trim() === '');
  const section = (end === -1 ? rest : rest.slice(0, end)).join('\n');
  assert.ok(section.length > 80, '该段不该是空壳');
  return section;
}

test('SYSTEM_PROMPT 讲清「端口段由平台分配 + ports.json 是唯一真相」，且不拄任何端口数字', async () => {
  const prompt = extractSystemPrompt(fs.readFileSync(path.join(RUNNER_DIR, 'worker.js'), 'utf8'));
  const { PREVIEW_PORT_POOL_START, PREVIEW_PORT_POOL_END, PREVIEW_PORT_COUNT } = await import('../../portal/src/previewpool.js');
  const section = previewSection(prompt);

  assert.equal(PREVIEW_PORT_COUNT, 10, '默认块大小仍是 10（条数可以写，**号码**不许写）');
  assert.match(section, /平台.*分配|由平台.*分配/, '必须写明端口段由平台分配（不再是人人同一段）');
  assert.match(section, new RegExp(`默认 ${PREVIEW_PORT_COUNT} 个`), '默认块大小必须与 portal 侧常量一致（不在测试里重打一遍）');
  assert.match(section, /唯一真相/, '必须把 ports.json 钉成唯一真相（#246）');
  assert.match(section, /~\/\.erix\/ports\.json/, '端口与 URL 的清单来源必须写出来');
  assert.match(section, /不要凭记忆|不要假设/, '必须阻止 agent 凭旧先验猜端口（#240 时代留下来的习惯）');

  // 端口数字一个都不许出现：旧的 4xxx 窗口已作废，号池边界也不许拄进提示词。
  assert.doesNotMatch(section, /\b4\d{3}\b/, `不得再出现 #240 时代的固定窗口（\`4000–4009\`）：${section}`);
  assert.doesNotMatch(section, new RegExp(`\\b${PREVIEW_PORT_POOL_START}\\b|\\b${PREVIEW_PORT_POOL_END}\\b`),
    `不得把号池边界 ${PREVIEW_PORT_POOL_START}–${PREVIEW_PORT_POOL_END} 拄进提示词（第二份清单必然漂移）`);
  assert.doesNotMatch(section, /\b\d{4,5}\s*[–—-]\s*\d{4,5}\b/, '不得出现任何端口区间字面量');

  // #257 的红线扩一条：域名也是**生成值**（docs/env.md §1：BASE_DOMAIN = 伞域，部署变量）。
  // 旧写法「把 `*.fde.localhost` / `fde.erix.vip` 写进提示词」与拄端口号是同一个病：换域名就漂。
  // 这里按**形状**禁（而不只禁现网那一个值）：任何带两个点的多段域名字面量都不许进提示词。
  assert.deepEqual(prompt.match(/\b[a-z0-9-]+\.[a-z0-9-]+\.[a-z]{2,}\b/g) || [], [],
    '提示词里不得出现多段域名（伞域 / 预览 host 都是生成值，要写也只写「清单里那一条的 url」）');
  assert.doesNotMatch(prompt, /\berix\.vip\b|\bfde\.localhost\b/i, '不得出现伞域字面量（现网 fde.erix.vip / 旧默认 fde.localhost）');
});

// ---------------------------------------------------------------------------
// issue #257 + #258（工单 feat-261012-01）：预览告知的**分工**本身也被钉死。
// 定稿（#258 `#issuecomment-6117800165`）：应用侧要求链（6 条）的单一真相 = materializer 下发的
// `~/AGENTS.md`，`SYSTEM_PROMPT` 只留一句强制指针。下面两条成对出现是有原因的：
//   ① 缺了 ⇒ 「下发了 ≠ 读了」（R-1 新增 P0：真机里 `AGENTS.md` 只在 2 轮出现，1 轮只是 `ls` 扫到，
//      因为旧提示词压根没提它）；
//   ② 破了 ⇒ 有人开始把具体规则抄进提示词 = 第二个会过期的真相源（同 §8.10「工具名从注册面取、
//      不手抄清单」）。抄规则在短期内看起来更“详细”，但它把 portal 文案与容器提示词绑成两份要同步的真相。
// ---------------------------------------------------------------------------

test('SYSTEM_PROMPT 有「开工先读 ~/AGENTS.md」的强制指针，且自带读得到它的实际手段（#259 前提）', () => {
  const prompt = extractSystemPrompt(fs.readFileSync(path.join(RUNNER_DIR, 'worker.js'), 'utf8'));
  const pointer = linesMentioning(prompt, '~/AGENTS.md');
  assert.ok(pointer.length > 0, 'SYSTEM_PROMPT 必须指向 ~/AGENTS.md（#258 定稿的强制指针）——缺了模型根本不知道有这份文件');
  // 措辞必须是「先读」：R-1 P0 的判据是 transcript 里出现读 ~/AGENTS.md 的调用，「可以参考」挡不住。
  assert.ok(pointer.some((l) => /先读/.test(l)), `强制指针必须写「先读」，实际是：${pointer.join(' / ')}`);
  // 指针必须落在预览段里（agent 起服务给人访问时才会去翻这一段）。
  const section = previewSection(prompt);
  assert.match(section, /~\/AGENTS\.md/, '强制指针必须落在「预览域名与端口」段内（与它的消费时机同段）');
  assert.match(section, /不复述|不重抄/, '指针必须说明本节有意不复述那些规则（否则下一句就会被人当成可以拄规则）');
  // ⚠ #259 未落地前 createJail({ root: cwd }) 的读边界只有项目根（无只读例外）⇒
  //   指针必须自带 shell 手段，否则模型按自然习惯 readFile 会撞「被宿主边界拒绝」白烧一轮。
  assert.match(section, /文件工具读不到[\s\S]{0,60}用 shell 读/, '家目录读不到的口径与 shell 手段必须同段给出');
  assert.match(section, /cat ~\/AGENTS\.md/, '必须给出可直接照抄的 `cat ~/AGENTS.md`');
  assert.match(section, /cat ~\/\.erix\/ports\.json/, 'ports.json 的读取手段不得在改版时丢掉');
});

test('单一来源防漂移：提示词里不得出现 allowedHosts / credentials / CORS 这三个具体规则词', async () => {
  const prompt = extractSystemPrompt(fs.readFileSync(path.join(RUNNER_DIR, 'worker.js'), 'utf8'));
  for (const word of ['allowedHosts', 'credentials', 'CORS']) {
    // 用环视做词界（而不是 \b）：allowedHosts 是小驼峰，前缀也可能是字母。
    assert.doesNotMatch(
      prompt,
      new RegExp(`(?<![A-Za-z0-9_])${word}(?![A-Za-z0-9_])`, 'i'),
      `提示词里出现了“${word}”——应用侧规则正在被抄进 SYSTEM_PROMPT（单一真相在 ~/AGENTS.md，由 materializer 下发）。` +
      '要加内容就改 portal/src/materializer.js 的 renderHomeAgentsMd()，不要把 6 条抄到提示词里。',
    );
  }
  // 反面兜底：这三条在单一真相里必须真的存在（否则②只是把提示词清空，不是防漂移）。
  // 取 portal 侧同源实现而不是重抄一衍文案：单一真相被删时这条也要红。
  const agentsMd = await import('../../portal/src/materializer.js').then((m) => m.renderHomeAgentsMd({ fdeName: 'alice' }));
  for (const word of ['allowedHosts', 'credentials', 'CORS']) {
    assert.match(agentsMd, new RegExp(word, 'i'), `单一真相里必须含“${word}”（提示词不抄，文件里必须写）`);
  }
});

test('SYSTEM_PROMPT 挡掉三种跑偏：自造域名/端口、找平台加端口、文件工具去读家目录', () => {
  const prompt = extractSystemPrompt(fs.readFileSync(path.join(RUNNER_DIR, 'worker.js'), 'utf8'));
  const section = previewSection(prompt);
  // ① 自造：域名由平台按 <fde>-p-<port> 生成（与路由同源），agent 只能选不能用
  assert.match(section, /不要自造域名或端口|不要自造/, '必须禁止自造域名/端口');
  assert.match(section, /必须从清单里选/, '必须把选择范围钉在平台给的那一段里');
  // ② 索要：没有 port_quota_exceeded 这回事，也别去提工单
  assert.match(section, /不要要求平台再加|不要要求平台/, '必须写明不要要求平台加端口（配额语义已删除）');
  // ③ 可达性：jail 根是项目目录，~/.erix/ports.json 只能经 shell 读（说了等于没说会白烧轮次）
  assert.match(section, /shell/, '必须给出读得到 ports.json 的实际手段（文件工具够不到家目录）');
  assert.match(prompt, /0\.0\.0\.0/, 'dev server 绑 0.0.0.0 的硬约定不能丢（fde-platform §8.4）');
});
