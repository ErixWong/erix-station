// #363：runner 技能通道契约钉（不触网）。
// 钉三件会在重构里静默漂移的事：
// 1) runner/skills 的包必须能被上游 loader 真实装配（契约破坏时 loader 只报 errors，不炸 run）；
// 2) Dockerfile 的 COPY 路径 ↔ worker 默认 bundledDir 逐字一致（歪掉的症状是"技能静默缺席"，最难查）；
// 3) loader 原生优先级：~/.erix/skills 同名技能覆盖 bundled（用户空间是日得迭代通道）。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { buildSkillTools } from 'erix-agent/tools';

const runnerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundledDir = path.join(runnerDir, 'skills');
const workerSrc = readFileSync(path.join(runnerDir, 'worker.js'), 'utf8');

test('runner/skills 可被上游 loader 装配出 github_fetch（契约级，不执行不触网）', async () => {
  const built = await buildSkillTools({ home: '/nonexistent-home', cwd: runnerDir, bundledDir, builtinNames: [] });
  assert.deepEqual(built.errors, [], `loader errors 必须为空: ${JSON.stringify(built.errors)}`);
  const names = built.tools.map((t) => t.name);
  assert.ok(names.includes('github_fetch'), `应含 github_fetch，实得 ${names.join(',')}`);
  const t = built.tools.find((x) => x.name === 'github_fetch');
  assert.equal(t.inputSchema.type, 'object');
  assert.ok(t.inputSchema.properties.url.description.length > 0, 'url 必须带描述（模型唯一的用法说明书）');
  assert.equal(typeof built.executeTool, 'function');
});

test('Dockerfile COPY skills ↔ worker 默认 bundledDir 逐字一致（镜像内路径不许漂）', () => {
  const dockerfile = readFileSync(path.join(runnerDir, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^COPY skills \.\/skills$/m, 'Dockerfile 必须 COPY skills（build context=runner/）');
  // WORKDIR 是 /opt/erix → 镜像内路径为 /opt/erix/skills；worker 默认值必须逐字命中。
  assert.match(dockerfile, /^WORKDIR \/opt\/erix$/m);
  assert.ok(
    workerSrc.includes("process.env.STATION_SKILLS_DIR || '/opt/erix/skills'"),
    'worker 默认 bundledDir 必须是 /opt/erix/skills（与 Dockerfile WORKDIR+COPY 对齐）',
  );
});

test('同名技能：~/.erix/skills 覆盖 bundled（用户空间 = 免重建镜像的迭代通道）', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'skills-home-'));
  try {
    mkdirSync(path.join(home, '.erix', 'skills', 'github'), { recursive: true });
    writeFileSync(
      path.join(home, '.erix', 'skills', 'github', 'skill.mjs'),
      'export function getSkillDefinition() { return { schema_version: 1, skill: { id: "github", entrypoint: "skill.mjs" },'
      + ' tools: [{ name: "github_fetch", description: "USER-OVERRIDE", inputSchema: { type: "object" } }] }; }\n'
      + 'export async function github_fetch() { return "user"; }\n',
    );
    const built = await buildSkillTools({ home, cwd: runnerDir, bundledDir, builtinNames: [] });
    assert.equal(built.errors.length, 0);
    assert.equal(built.tools.find((t) => t.name === 'github_fetch').description, 'USER-OVERRIDE');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// issue #595 §6 L2：市场「停用」只改库里一行，**磁盘目录仍在**（~/.erix/skills/<slug>/）。
// 于是装配面必须显式排除，否则用户在页面里关了技能、模型照样调得到那个工具 ——
// 症状是「关了还在」，而提示词段里又看不见它，排查会绕远路。这条就是那条判据的机器版本。
test('excludeSkillIds：~/.erix/skills 里的技能可以被逐条排除（市场停用的落盘面判据）', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'skills-excl-'));
  const writeSkill = (id, desc) => {
    mkdirSync(path.join(home, '.erix', 'skills', id), { recursive: true });
    writeFileSync(
      path.join(home, '.erix', 'skills', id, 'skill.mjs'),
      `export function getSkillDefinition() { return { schema_version: 1, skill: { id: "${id}",`
      + ` entrypoint: "skill.mjs" }, tools: [{ name: "${id}_run", description: "${desc}",`
      + ` inputSchema: { type: "object" } }] }; }\nexport async function ${id}_run() { return "${id}"; }\n`,
    );
  };
  try {
    writeSkill('market_on', 'MARKET-ON');
    writeSkill('market_off', 'MARKET-OFF');
    const base = await buildSkillTools({ home, cwd: runnerDir, bundledDir, builtinNames: [] });
    assert.deepEqual(base.errors, [], `两个市场技能都要能装配: ${JSON.stringify(base.errors)}`);
    const all = base.tools.map((t) => t.name);
    assert.ok(all.includes('market_on_run') && all.includes('market_off_run'), `前置不成立: ${all.join(',')}`);

    const excluded = await buildSkillTools({
      home, cwd: runnerDir, bundledDir, builtinNames: [], excludeSkillIds: ['market_off'],
    });
    const names = excluded.tools.map((t) => t.name);
    assert.ok(!names.includes('market_off_run'), '被排除的技能不得出现在工具面（关了就该调不到）');
    assert.ok(names.includes('market_on_run'), '排除必须是逐条的，不得连坐别的技能');
    // 排除不是错误：目录仍在磁盘、文件仍合法，只是平台这次不装它 ⇒ 不许进 errors（否则每条 warn 都是噪音）
    assert.deepEqual(excluded.errors, [], `排除不得产生 error: ${JSON.stringify(excluded.errors)}`);
    // 空数组必须等于不排除（worker 的默认形态：没装过任何市场技能）
    const empty = await buildSkillTools({ home, cwd: runnerDir, bundledDir, builtinNames: [], excludeSkillIds: [] });
    assert.deepEqual(empty.tools.map((t) => t.name).sort(), all.sort(), 'excludeSkillIds: [] 必须逐字等于不排除');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
