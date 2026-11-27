// runner/test/capability-index.test.js —— issue #595 §6：`capabilities.json` → 提示词段的四条判据
//
// 判据继承 #451 对 AGENTS.md 那一套（docs/design/capability-market.md §6、lib/capability-index.js 头注释）：
//   ① 内容只来自原文  ② 字节确定性（prompt 缓存前缀）  ③ 失败降级不抛  ④ 4 KiB 上限 + 截断记账。
// 隔离约定（docs/testing.md §2.1）：全部用注入的假 fs / tmp 目录，不碰真实 `$HOME`。
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CAPABILITY_MAX_SECTION_BYTES,
  normalizeCapabilities,
  readCapabilityIndex,
  renderCapabilityIndex,
  splitByEnabled,
  buildCapabilityIndex,
} from '../lib/capability-index.js';

// ---- 夹具生命周期：mkdtemp 与注册 rm 必须在同一条用例内闭环（#880）----
// 本文件建的每一个 /tmp 目录都进 tmpDirs；漏一个就会在 /tmp 留下 capidx-*，
// 而 scripts/check-tmp-hygiene.mjs 正是数这个名字（增量口径：本轮新增必须为 0）。
const tmpDirs = [];
function trackTmp(dir) {
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    // rmSync 必须是真语句：注释掉它 while 就空转成死循环（#880 批一踩过）。
    fs.rmSync(tmpDirs.pop(), { recursive: true, maxRetries: 3 });
  }
});

const skill = (id, over = {}) => ({
  id,
  name: `技能 ${id}`,
  summary: `一句话 ${id}`,
  when_to_use: `什么时候用 ${id}，说清楚一点免得模型猜`,
  enabled: true,
  tools: [`${id}_run`],
  readme: `~/.erix/skills/${id}/SKILL.md`,
  ...over,
});

/** 假 fs：只认 capabilities.json 这一个路径，行为由传入的桩决定。 */
function fakeFs({ exists = true, body = null, readErr = null, jsonErr = null }) {
  const file = '/fake/home/.erix/capabilities.json';
  return {
    file,
    existsSync: () => exists,
    readFileSync: () => {
      if (readErr) throw readErr;
      if (jsonErr) throw jsonErr;
      return body ?? JSON.stringify({ version: 1, skills: [] });
    },
    statSync: () => ({ size: 100 }),
  };
}

// ---------------------------------------------------------------------------
// ① 只来自原文
// ---------------------------------------------------------------------------

test('CI-1 段里的每个事实性字段都逐字来自文件，不添加平台侧描述', () => {
  const s = skill('pdf_tools', {
    summary: '从 PDF 抽文本', when_to_use: '用户给的是 pdf 文件时', tools: ['pdf_extract', 'pdf_pages'],
  });
  const section = renderCapabilityIndex([s]);
  for (const needle of ['pdf_tools', '从 PDF 抽文本', '用户给的是 pdf 文件时', 'pdf_extract, pdf_pages',
    '~/.erix/skills/pdf_tools/SKILL.md']) {
    assert.ok(section.includes(needle), `原文里的「${needle}」必须逐字出现在段里`);
  }
  // 反向：渲染器不许自己发明技能（名字/摘要之外不许出现「这个技能能做什么」的补充句）
  assert.doesNotMatch(section, /推荐|建议用于|最佳实践/, '渲染器不得添加平台侧的价值判断（第二份真相必然漂移）');
  assert.ok(section.startsWith('\n\n## 平台技能'),
    '段必须以 `\\n\\n` 起头并带标题（拼接形状与 agentsMdSection 一致，模型靠标题分清内置工具与技能工具）');
});

// ---------------------------------------------------------------------------
// ② 字节确定性
// ---------------------------------------------------------------------------

test('CI-2 同一份输入逐字节同一输出；输入乱序也得到同一串（prompt 缓存前缀不许漂）', () => {
  const a = [skill('b_two'), skill('a_one'), skill('c_three')];
  const b = [skill('c_three'), skill('a_one'), skill('b_two')];
  const one = renderCapabilityIndex(a);
  const two = renderCapabilityIndex(b);
  assert.equal(one, two, '排序必须发生在渲染侧：SQL 排过也要再排一次（判据不同源）');
  const ids = one.split('\n').filter((l) => l.startsWith('- `')).map((l) => /^- `([^`]+)`/.exec(l)[1]);
  assert.deepEqual(ids, ['a_one', 'b_two', 'c_three'], '列表必须按 id 升序（渲染侧再排一次，判据不同源）');
  // 时间戳/随机数是缓存杀手：段里不许出现任何像日期或 run id 的东西
  assert.doesNotMatch(one, /\d{4}-\d{2}-\d{2}|\b[0-9a-f]{8}-[0-9a-f]{4}\b/, '段里不许出现日期或 uuid（缓存稳定前缀）');
  assert.equal(renderCapabilityIndex(a, {}), one, 'options 缺省与显式空对象必须同形');
});

test('CI-3 空输入 ⇒ 空串：`SYSTEM_PROMPT + section` 必须逐字节等于原提示词', () => {
  for (const input of [[], null, undefined, 'not-an-array']) {
    assert.equal(renderCapabilityIndex(input), '', `输入 ${JSON.stringify(input)} 必须渲染成空串`);
  }
  const BASE = 'BASE-PROMPT';
  assert.equal(BASE + renderCapabilityIndex([]), BASE, '没装技能时提示词必须逐字节不变（口径同 #451）');
});

// ---------------------------------------------------------------------------
// ③ 失败降级
// ---------------------------------------------------------------------------

test('CI-4 四种降级路径各归一种 status，且一律返回空段（绝不让 run 因为读不到而失败）', () => {
  const cases = [
    ['missing', fakeFs({ exists: false })],
    ['unreadable', fakeFs({ readErr: new Error('EACCES: permission denied') })],
    ['bad_json', fakeFs({ body: '{"version":1,"skills":[' })],
    ['bad_shape', fakeFs({ body: JSON.stringify({ version: 1, skills: [{ name: '没有 id' }] }) })],
  ];
  for (const [status, f] of cases) {
    const out = buildCapabilityIndex({ home: '/fake/home', fs: f });
    assert.equal(out.status, status, `${status} 必须如实报出来（排查时「没装过」与「读不到」不能混）`);
    assert.equal(out.section, '', `${status} 时段必须是空串`);
    assert.deepEqual(out.excludeSkillIds, [], `${status} 时不许排除任何技能（读不到 ≠ 用户关了）`);
    assert.deepEqual(out.skills, []);
  }
  // 文件缺失是完全正常的状态：不许产出 note（否则每个空容器都有一条噪音）
  assert.equal(readCapabilityIndex({ home: '/fake/home', fs: fakeFs({ exists: false }) }).note, null,
    'missing 不记 note：市场还没东西是默认形态');
  assert.match(readCapabilityIndex({ home: '/fake/home', fs: fakeFs({ readErr: new Error('EIO') }) }).note, /EIO/,
    '读失败必须把原因留下（note 进记账那条 info）');
});

test('CI-5 采集器自己不认识的条目只丢自己那一条，其余照常渲染', () => {
  const f = fakeFs({ body: JSON.stringify({ version: 1, skills: [skill('ok_one'), null, { name: 'no id' }, skill('ok_two')] }) });
  const out = buildCapabilityIndex({ home: '/fake/home', fs: f });
  assert.equal(out.status, 'ok');
  assert.deepEqual(out.skills.map((s) => s.id), ['ok_one', 'ok_two']);
  assert.match(out.note, /2 条缺 id/, '丢了几条必须记账（静默丢 = 用户以为装了 4 条）');
});

// ---------------------------------------------------------------------------
// ④ L2：启停与 excludeSkillIds
// ---------------------------------------------------------------------------

test('CI-6 enabled=false 的：不进提示词、但 id 必须进 excludeSkillIds', () => {
  const f = fakeFs({ body: JSON.stringify({
    version: 1, skills: [skill('on_one'), skill('off_two', { enabled: false }), skill('on_three')],
  }) });
  const out = buildCapabilityIndex({ home: '/fake/home', fs: f });
  assert.deepEqual(out.excludeSkillIds, ['off_two'], '目录仍在磁盘，不显式排除就会被 loader 照装');
  assert.ok(!out.section.includes('off_two'), '停用的技能不得出现在提示词里（否则模型会调一个不存在的工具）');
  assert.ok(out.section.includes('on_one') && out.section.includes('on_three'));
  assert.deepEqual(splitByEnabled([]), { enabled: [], excludeSkillIds: [] });
  // `enabled` 缺省按启用（§2 的默认值就是 true）：缺字段不等于停用
  const d = normalizeCapabilities({ skills: [{ id: 'no_field' }] });
  assert.equal(d.skills[0].enabled, true, '缺 enabled 字段必须按启用处理');
});

// ---------------------------------------------------------------------------
// ⑤ 上限 4 KiB
// ---------------------------------------------------------------------------

test('CI-7 超上限按 id 序截尾并写「（还有 N 项未列出）」，整段不超过 4 KiB', () => {
  const many = Array.from({ length: 200 }, (_, i) => skill(`s${String(i).padStart(3, '0')}`, {
    summary: 'x'.repeat(60), when_to_use: 'y'.repeat(120),
  }));
  const section = renderCapabilityIndex(many);
  const bytes = Buffer.byteLength(section, 'utf8');
  assert.ok(bytes <= CAPABILITY_MAX_SECTION_BYTES, `整段 ${bytes} 字节必须 ≤ ${CAPABILITY_MAX_SECTION_BYTES}`);
  assert.match(section, /（还有 \d+ 项未列出）/, '必须写明还剩几条没列（静默截断 = 模型以为清单是全集）');
  const shown = section.split('\n').filter((l) => l.startsWith('- ')).length;
  const omitted = Number(/（还有 (\d+) 项未列出）/.exec(section)[1]);
  assert.equal(shown + omitted, 200, '列出的 + 未列出的 = 总数（记账必须闭合）');
  assert.ok(section.includes('`s000`'), '截尾必须从头保留：id 升序的前 N 条');
  assert.ok(!section.includes('`s199`'), '尾部要被截掉');
  // 上限本身可注入（单测要能用小上限验证逻辑，不必造 4 KiB 的数据）
  // 上限可注入（单测要能用小上限验证逻辑，不必造 4 KiB 的数据）：800 字节只够列一条。
  const small = renderCapabilityIndex([skill('aa'), skill('bb')], { maxBytes: 800 });
  assert.match(small, /（还有 1 项未列出）/);
  assert.ok(small.includes('`aa`') && !small.includes('`bb`'), '截尾从头保留（id 升序）');
});

test('CI-8 单条字段过长 ⇒ 就地裁短，不许一条把整段挤掉', () => {
  const long = skill('only_one', { when_to_use: '很'.repeat(2000), summary: '长'.repeat(900) });
  const section = renderCapabilityIndex([long]);
  assert.ok(Buffer.byteLength(section, 'utf8') <= CAPABILITY_MAX_SECTION_BYTES, '一条超长也不能顶破上限');
  assert.ok(section.includes('…'), '裁短必须留省略号（否则模型读到的是被硬切的半句）');
});

// ---------------------------------------------------------------------------
// 真 fs 路径（tmp 目录）：读面走的是 node:fs，假 fs 之外还要证明真读得到
// ---------------------------------------------------------------------------

test('CI-9 tmp 目录里的真文件读得出来，并给出 §5 的字段面', () => {
  const home = trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'capidx-')));
  fs.mkdirSync(path.join(home, '.erix'), { recursive: true });
  fs.writeFileSync(path.join(home, '.erix', 'capabilities.json'),
    JSON.stringify({ version: 1, skills: [skill('real_one')] }, null, 2));
  const out = buildCapabilityIndex({ home });
  assert.equal(out.status, 'ok');
  assert.deepEqual(out.skills[0], {
    id: 'real_one', name: '技能 real_one', summary: '一句话 real_one',
    when_to_use: '什么时候用 real_one，说清楚一点免得模型猜', enabled: true,
    tools: ['real_one_run'], readme: '~/.erix/skills/real_one/SKILL.md',
  });
  assert.ok(out.section.includes('`real_one`'));
});

// ---------------------------------------------------------------------------
// issue #608 §5.2 / §6.5：`mcp` 段（与 skills **共享**同一个 4 KiB）
// ---------------------------------------------------------------------------

const mcpEntry = (name, over = {}) => ({
  name,
  description: `描述 ${name}`,
  exposure: 'deferred',
  tool_count: 2,
  ...over,
});

/** 假 fs + 指定 skills/mcp 两段内容（`mcp: undefined` = 旧版 portal 根本不写这个键）。 */
function capsFs(skills, mcp) {
  const body = { version: 1, skills };
  if (mcp !== undefined) body.mcp = mcp;
  return fakeFs({ body: JSON.stringify(body) });
}

test('CI-10 mcp 段行形状逐字照 §6.5，且绝不把工具名带进上下文', () => {
  const f = capsFs([], [mcpEntry('github', { description: 'GitHub 仓库与 PR 操作' })]);
  const out = buildCapabilityIndex({ home: '/fake/home', fs: f });
  assert.ok(out.section.includes('## 平台 MCP 服务（能力市场）'), out.section);
  const line = '- github — GitHub 仓库与 PR 操作；工具 2 个；用法：mcp({action:"search"}) 找工具后 call';
  assert.ok(out.section.includes(line), `段里必须出现契约那一行：\n${out.section}`);
  // §5.2 的红线：工具名进上下文就是几百 token，所以 `mcp` 段只允许四个字段。
  assert.ok(!out.section.includes('create_issue'), '工具名不得进上下文');
  assert.deepEqual(out.mcp, [{
    name: 'github', description: 'GitHub 仓库与 PR 操作', exposure: 'deferred', tool_count: 2,
  }]);
});

test('CI-11 direct 与 hidden 的 server 不进段；【反向】exposure 一改行就消失', () => {
  const f = capsFs([], [
    mcpEntry('alpha'),
    mcpEntry('beta', { exposure: 'direct' }),
    mcpEntry('gamma', { exposure: 'hidden' }),
  ]);
  const out = buildCapabilityIndex({ home: '/fake/home', fs: f });
  assert.ok(out.section.includes('- alpha —'));
  assert.ok(!out.section.includes('beta'), 'direct 的工具已是独立工具，再列一遍白花字节');
  assert.ok(!out.section.includes('gamma'), 'hidden 连提示词里都不许出现（§10.7）');
  // 反向：把 alpha 也改成 direct ⇒ 整段消失（不是「换了种写法」）
  const allDirect = buildCapabilityIndex({
    home: '/fake/home',
    fs: capsFs([], [mcpEntry('alpha', { exposure: 'direct' })]),
  });
  assert.equal(allDirect.mcpSection, '');
  assert.equal(allDirect.section, '', '只剩 direct/hidden ⇒ 段整体为空，等于没这段');
});

test('CI-12 共享 4 KiB：预算紧时截的是 mcp 段，skills 一条不少【反向】', () => {
  const skills = [skill('aaa'), skill('bbb')];
  const many = [];
  for (let i = 0; i < 40; i += 1) many.push(mcpEntry(`srv${String(i).padStart(2, '0')}`));
  const total = 1400;   // 紧到只够 skills + 几条 mcp
  const out = buildCapabilityIndex({ home: '/fake/home', fs: capsFs(skills, many), maxBytes: total });
  // ① skills 必须**逐字节等于**「没有 mcp 段时」的渲染（共享预算只准往下让）
  assert.equal(out.skillsSection, renderCapabilityIndex(skills, { maxBytes: total }),
    'skills 段被 mcp 挤动了（§5.2「skills 段永不被 mcp 挤掉」）');
  for (const id of ['aaa', 'bbb']) assert.ok(out.section.includes(`\`${id}\``), `技能 ${id} 被挤掉了`);
  // ② 挤掉的必须是 mcp：有截尾行，且真少列了若干 server
  assert.match(out.mcpSection, /还有 \d+ 个 server 未列出/, '预算紧却没写「未列出」= 静默吞信息');
  assert.ok(out.mcpSection.includes('- srv00 —'));
  assert.ok(!out.mcpSection.includes('- srv39 —'), 'mcp 段必须按 name 从尾部截');
  // ③ 两段加起来仍在上限内（截断提示不许把上限顶穿）
  assert.ok(Buffer.byteLength(out.section, 'utf8') <= total,
    `整段 ${Buffer.byteLength(out.section, 'utf8')} 字节 > 预算 ${total}`);
});

test('CI-13 mcp 超预算按 name 升序截尾并记账；整段始终 ≤ 4 KiB', () => {
  const many = [];
  for (let i = 0; i < 400; i += 1) many.push(mcpEntry(`s${String(i).padStart(3, '0')}`));
  const out = buildCapabilityIndex({ home: '/fake/home', fs: capsFs([], many) });
  assert.ok(Buffer.byteLength(out.section, 'utf8') <= CAPABILITY_MAX_SECTION_BYTES);
  assert.match(out.section, /还有 \d+ 个 server 未列出/);
  assert.ok(out.section.includes('- s000 —'));
  assert.ok(!out.section.includes('- s399 —'));
});

test('CI-14 没有 mcp 段（旧版 portal）⇒ section 逐字节等于 v1【反向防回归】', () => {
  const skills = [skill('aaa'), skill('bbb')];
  const out = buildCapabilityIndex({ home: '/fake/home', fs: capsFs(skills, undefined) });
  assert.equal(out.mcpSection, '');
  assert.equal(out.section, renderCapabilityIndex(skills),
    '加了 mcp 段之后，旧文件的输出必须一字节都不变（prompt 缓存前缀不许漂）');
  assert.deepEqual(out.mcp, [], '缺段 ⇒ 空数组，绝不是 undefined（调用方要能直接 map）');
  // 反向：显式空数组与缺键必须同结果
  const emptyArr = buildCapabilityIndex({ home: '/fake/home', fs: capsFs(skills, []) });
  assert.equal(out.section, emptyArr.section);
});

test('CI-15 mcp 段自身形状不对只丢自己，skills 照常渲染', () => {
  const f = capsFs([skill('aaa')], [mcpEntry('ok_one'), null, { description: '没有名字' }, 42]);
  const out = buildCapabilityIndex({ home: '/fake/home', fs: f });
  assert.equal(out.status, 'ok');
  assert.ok(out.section.includes('`aaa`'), 'skills 不许被 mcp 的坏条目连坐');
  assert.deepEqual(out.mcp.map((s) => s.name), ['ok_one']);
  assert.ok(out.section.includes('- ok_one —'));
});
