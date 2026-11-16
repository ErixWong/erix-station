// 上游文件工具契约（erix-agent/contract-tests）跑在 station 装配工厂上（工单 D3 / M1）。
// 契约面（29 项）钉的是「换个实现也会坑调用方」的事：executeTool 两种调用形态、谓词以绝对路径被
// 调用且**越界返回错误文本而非抛**、readFile 单次返回不超过 max_bytes、vendor/隐藏目录默认跳过且
// 带排除账、无命中统一口径、遍历可被 context.signal 中止、searchText/rg/grep 命中正文逐字相等。
// 契约不覆盖的 station 特有行为（maskedPaths 遮蔽、白名单工具面、jail 谓词与调用方谓词**相与**、
// issue #211 的入口中止检查）在本文件后半部分自带用例钉住。
// 隔离约定：契约套件自带 tmp cwd 注入，不碰真实环境。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileToolsContract } from 'erix-agent/contract-tests';
import { createToolRegistry } from 'erix-agent/tools';
import { createJail, createStationFileTools, STATION_FILE_TOOL_NAMES } from '../lib/file-tools.js';

/** 装配 station 工厂成契约套件期望的 createFileTools 形状（jail 根 = 注入的 cwd）。 */
function createFileTools(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const jail = createJail({ root: cwd, writable: [cwd], maskedPaths: options.maskedPaths });
  return createStationFileTools({
    jail,
    cwd,
    maskedPaths: options.assemblyMaskedPaths,
    allowRead: options.allowRead,
    allowWrite: options.allowWrite,
  });
}

fileToolsContract('station', { createFileTools });

// ---------------------------------------------------------------------------
// station 特有行为（契约套件不覆盖的面）
// ---------------------------------------------------------------------------

/** tmp 目录（realpath 后交给断言，避免 /var→/private/var 这类符号链接根因干扰路径比对）。 */
async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-ft-contract-'));
  try {
    return await fn(fs.realpathSync(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('station 工具面 = 5 个白名单（不暴露弃用别名 rg / grep），且白名单不复制工具清单', () =>
  withTempDir(async (root) => {
    const tools = createFileTools({ cwd: root });
    assert.deepEqual(tools.schemas.map((schema) => schema.name), [...STATION_FILE_TOOL_NAMES]);
    assert.deepEqual(Object.keys(tools.executors).sort(), [...STATION_FILE_TOOL_NAMES].sort());
    // 白名单只列名字：schema 本体必须来自上游 definitions（逐字相等，没被本地抄写走样）
    assert.deepEqual(
      tools.schemas.find((schema) => schema.name === 'searchText'),
      tools.definitions.find((definition) => definition.name === 'searchText'),
    );
    // 上游全量仍在 definitions 里（= executeTool 能执行的全集），但注册面只有 5 个
    assert.deepEqual(
      tools.definitions.map((definition) => definition.name).sort(),
      ['edit', 'grep', 'readFile', 'rg', 'searchText', 'tree', 'writeFile'],
    );
    // 注册进 registry 后别名拿不到 executor（模型看不见 = 也调不动）
    const registry = createToolRegistry({ executors: tools.executors, schemas: tools.schemas });
    assert.match(String(await registry.executeTool('rg', { pattern: 'x' }, {})), /^Unknown tool: rg$/u);
    assert.match(String(await registry.executeTool('grep', { pattern: 'x' }, {})), /^Unknown tool: grep$/u);
  }));

test('maskedPaths（jail 侧遮蔽）继续生效：readFile 被拒、searchText 计入排除账、tree 不列出', () =>
  withTempDir(async (root) => {
    fs.writeFileSync(path.join(root, 'keep.txt'), 'needle keep\n');
    fs.mkdirSync(path.join(root, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'secrets', 'token.txt'), 'needle secret\n');
    const tools = createFileTools({ cwd: root, maskedPaths: ['secrets'] });

    const read = await tools.executeTool('readFile', { path: 'secrets/token.txt' }, {});
    assert.match(String(read), /^错误：/u, '遮蔽路径的读必须是错误文本结果');
    assert.match(String(read), /读取被宿主边界拒绝/u);
    assert.doesNotMatch(String(read), /needle secret/u, '被遮蔽的内容一个字节都不许回传');

    assert.match(await tools.executeTool('readFile', { path: 'keep.txt' }, {}), /1: needle keep/u);

    const search = await tools.executeTool('searchText', { pattern: 'needle', mode: 'literal' }, {});
    assert.match(search.content, /keep\.txt/u);
    assert.doesNotMatch(search.content, /needle secret/u);
    assert.match(search.content, /宿主边界拒绝/u, '遮蔽条目必须进模型可见的排除账');
    assert.ok(search.metadata.searchSkipped.deniedPaths >= 1, '遮蔽条目必须计入结构化排除账');

    const tree = await tools.executeTool('tree', { path: '.' }, {});
    assert.match(String(tree), /keep\.txt/u);
    assert.doesNotMatch(String(tree), /token\.txt/u, 'tree 不得列出被遮蔽的条目');
  }));

test('maskedPaths（装配层 maskedPaths 入参）同样生效', () =>
  withTempDir(async (root) => {
    fs.writeFileSync(path.join(root, 'keep.txt'), 'keep\n');
    fs.writeFileSync(path.join(root, 'id_ed25519'), 'PRIVATE KEY\n');
    const tools = createStationFileTools({
      jail: createJail({ root, writable: [root] }),
      cwd: root,
      maskedPaths: ['id_ed25519'],
    });
    const read = await tools.executeTool('readFile', { path: 'id_ed25519' }, {});
    assert.match(String(read), /^错误：读取被宿主边界拒绝/u);
    assert.doesNotMatch(String(read), /PRIVATE KEY/u);
    assert.match(await tools.executeTool('readFile', { path: 'keep.txt' }, {}), /1: keep/u);
  }));

test('边界谓词是「相与」而不是替换：调用方拒绝挡得住 jail 放行，jail 拒绝也挡得住调用方放行', () =>
  withTempDir(async (root) => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
    fs.mkdirSync(path.join(root, 'private'), { recursive: true });
    fs.writeFileSync(path.join(root, 'private', 'b.txt'), 'b\n');

    // ① jail 全放行，调用方拒绝 private → 必须挡（证明 jail 没替换调用方谓词）
    const hostDenies = createStationFileTools({
      jail: createJail({ root, writable: [root] }),
      cwd: root,
      allowRead: (target) => !target.startsWith(path.join(root, 'private')),
      allowWrite: () => false,
    });
    assert.doesNotMatch(String(await hostDenies.executeTool('tree', { path: '.' }, {})), /b\.txt/u);
    assert.doesNotMatch(
      String(await hostDenies.executeTool('readFile', { path: 'private/b.txt' }, {})),
      /^1: b$/u,
    );
    assert.match(String(await hostDenies.executeTool('writeFile', { path: 'a.txt', content: 'x' }, {})),
      /^错误：写入被宿主边界拒绝/u, '调用方 allowWrite=false 必须真的生效');

    // ② 调用方默认全放行，jail 根在 private 子树 → 读兄弟子树必须挡（证明调用方没替换 jail 谓词）
    const jailOnly = createStationFileTools({
      jail: createJail({ root: path.join(root, 'private'), writable: [path.join(root, 'private')] }),
      cwd: path.join(root, 'private'),
    });
    assert.match(String(await jailOnly.executeTool('readFile', { path: '../a.txt' }, {})),
      /^错误：读取被宿主边界拒绝/u);
    assert.match(String(await jailOnly.executeTool('writeFile', { path: '../a.txt', content: 'x' }, {})),
      /^错误：写入被宿主边界拒绝/u);
  }));

test('issue #211：装配层入口补一次中止检查（上游 readFile/writeFile/edit 不接 context）', () =>
  withTempDir(async (root) => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'x\n');
    const tools = createFileTools({ cwd: root });
    const controller = new AbortController();
    controller.abort();
    for (const [name, input] of [
      ['readFile', { path: 'a.txt' }],
      ['writeFile', { path: 'b.txt', content: 'y' }],
      ['edit', { path: 'a.txt', edits: [{ oldText: 'x', newText: 'z' }] }],
      ['tree', {}],
      ['searchText', { pattern: 'x', mode: 'literal' }],
    ]) {
      await assert.rejects(() => tools.executors[name](input, { signal: controller.signal }),
        { name: 'AbortError' }, `${name} 已中止时必须不开工`);
      await assert.rejects(
        tools.executeTool({ id: 't', name, input, signal: controller.signal }),
        { name: 'AbortError' }, `${name} 结构化调用形态同样要拦`,
      );
    }
    assert.equal(fs.existsSync(path.join(root, 'b.txt')), false, '已中止的 writeFile 不得落盘');
    assert.match(await tools.executeTool('readFile', { path: 'a.txt' }, {}), /1: x/u, '未中止时照常工作');
  }));

// ---------------------------------------------------------------------------
// issue #259 × #228：**只读例外只放宽 jail 那一项**。
// #228 定下的接线口径是「喂给上游的 allowRead = 调用方谓词 ∧ ¬遮蔽 ∧ jail 谓词」，例外长在
// jail 那一项上——它既不能替换调用方谓词，也不能让装配层的遮蔽失效。四种「放宽过头」的形状
// 各钉一条（外加一条正向对照，否则前四条只是「全都挡」的假绿）。
// ---------------------------------------------------------------------------
test('#259 例外只放宽 jail 那一项：调用方谓词与装配层遮蔽照样挡得住例外路径', () =>
  withTempDir(async (root) => {
    const home = path.join(root, 'home');
    const project = path.join(home, 'projects', 'todo');
    fs.mkdirSync(path.join(home, '.erix'), { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(home, 'AGENTS.md'), 'platform rules\n');
    fs.writeFileSync(path.join(home, '.erix', 'ports.json'), '{"allocations":[]}\n');
    fs.writeFileSync(path.join(project, 'a.txt'), 'project own\n');
    const exceptions = (h) => [path.join(h, 'AGENTS.md'), path.join(h, '.erix')];
    const agents = path.join(home, 'AGENTS.md');
    const ports = path.join(home, '.erix', 'ports.json');
    const jailFor = (h) => createJail({ root: project, writable: [project], readExceptions: exceptions(h) });

    // ① 正向对照：例外确实放行（读得到，才谈得上后面三条在挡什么）
    const open = createStationFileTools({ jail: jailFor(home), cwd: project });
    assert.match(await open.executeTool('readFile', { path: agents }, {}), /1: platform rules/u);
    assert.match(await open.executeTool('readFile', { path: ports }, {}), /allocations/u);

    // ② 调用方谓词拒绝 ⇒ 例外不得翻它（jail 放宽 ≠ 替换宿主注入的谓词，#228 那条红线）
    const hostDenies = createStationFileTools({
      jail: jailFor(home),
      cwd: project,
      allowRead: (target) => target !== agents && !target.startsWith(path.join(home, '.erix')),
    });
    assert.match(String(await hostDenies.executeTool('readFile', { path: agents }, {})),
      /^错误：读取被宿主边界拒绝/u, '调用方说不要读，例外不许替它做主');
    assert.match(String(await hostDenies.executeTool('readFile', { path: ports }, {})),
      /^错误：读取被宿主边界拒绝/u);
    // 同一次装配里，调用方**没**拒的路径照旧读得到（证明上面两条拒的是谓词，不是整个工具面坏掉了）
    assert.match(await hostDenies.executeTool('readFile', { path: path.join(project, 'a.txt') }, {}),
      /1: project own/u);

    // ③ 装配层遮蔽照样生效，**即使遮蔽项正落在例外目录里**（密钥不能因为开了例外就漏读）
    const masked = createStationFileTools({
      jail: jailFor(home),
      cwd: project,
      maskedPaths: [ports],
    });
    const maskedRead = String(await masked.executeTool('readFile', { path: ports }, {}));
    assert.match(maskedRead, /^错误：读取被宿主边界拒绝/u);
    assert.doesNotMatch(maskedRead, /allocations/u, '被遮蔽的内容一字节不许回传');
    assert.match(await masked.executeTool('readFile', { path: agents }, {}), /platform rules/u,
      '遮蔽只打那一个文件，不许把整条例外顺带带走');

    // ④ 写侧：例外不参与——jail 写边界（不认例外）与调用方写谓词两道都还站着
    assert.match(String(await open.executeTool('writeFile', { path: agents, content: 'x' }, {})),
      /^错误：写入被宿主边界拒绝/u);
    const writeDenied = createStationFileTools({ jail: jailFor(home), cwd: project, allowWrite: () => false });
    assert.match(String(await writeDenied.executeTool('writeFile', { path: path.join(project, 'a.txt'), content: 'x' }, {})),
      /^错误：写入被宿主边界拒绝/u, '调用方 allowWrite=false 不得被例外顺带放宽（例外只管读）');
  }));
