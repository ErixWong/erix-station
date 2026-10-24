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
