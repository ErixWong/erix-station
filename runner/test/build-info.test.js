// 版本必须是构建产物（issue #404 结案）。
// 这组测试钉的是"来源顺序"与"绝不抛错"两件事，外加一条防回潮的源码锚点：
// agentd 里不许再出现 `|| '0.1.0'` 那种"看起来合法的兜底版本号"。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBuildInfo, UNKNOWN } from '../lib/build-info.js';

const RUNNER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tmpInfo(objOrText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-info-'));
  const file = path.join(dir, 'build-info.json');
  fs.writeFileSync(file, typeof objOrText === 'string' ? objOrText : JSON.stringify(objOrText));
  return file;
}

test('① 镜像里的 build-info.json 是真值来源：四个字段原样带出，source=build-info', () => {
  const file = tmpInfo({ station_version: '0.1.41', engine_version: '0.26.0', revision: 'abc123', built_at: '2026-10-26T20:00:00Z' });
  const info = readBuildInfo({ env: {}, buildInfoPath: file });
  assert.deepEqual(info, {
    agentVersion: '0.26.0', // 契约口径：agent_version = erix-agent（引擎）版本，docs/api/portal.md U4
    runnerVersion: '0.1.41',
    revision: 'abc123',
    builtAt: '2026-10-26T20:00:00Z',
    source: 'build-info',
  });
});

test('② ERIX_BUILD_INFO_PATH 可指路（测试/非常规安装位），不必硬编 /opt/erix', () => {
  const file = tmpInfo({ station_version: '9.9.9', engine_version: '8.8.8' });
  const info = readBuildInfo({ env: { ERIX_BUILD_INFO_PATH: file } });
  assert.equal(info.source, 'build-info');
  assert.equal(info.runnerVersion, '9.9.9');
  assert.equal(info.revision, UNKNOWN, '缺字段就写 unknown，不猜');
});

test('③ env 是 override，优先级最高，且把 source 改成 env', () => {
  const file = tmpInfo({ station_version: '0.1.41', engine_version: '0.26.0' });
  const info = readBuildInfo({ env: { ERIX_AGENT_VERSION: '0.27.0-rc1' }, buildInfoPath: file });
  assert.equal(info.agentVersion, '0.27.0-rc1', '显式钉值必须赢过镜像里的构建产物');
  assert.equal(info.runnerVersion, '0.1.41', 'override 只盖引擎版本，runner 版本仍是构建产物');
  assert.equal(info.source, 'env');
});

test('④ dev 退路：没有 build-info 时读本地 package.json，绝不抛错', () => {
  const info = readBuildInfo({ env: {}, buildInfoPath: '/nonexistent/build-info.json', packageDir: RUNNER_ROOT });
  assert.equal(info.source, 'package');
  assert.match(info.runnerVersion, /^\d+\.\d+\.\d+/, '仓库里跑要报真实 runner 版本');
  // 引擎版本取决于本地是否装了 erix-agent；装了就必须是真值，没装就是 unknown——两种都不许是假数
  if (fs.existsSync(path.join(RUNNER_ROOT, 'node_modules', 'erix-agent', 'package.json'))) {
    assert.match(info.agentVersion, /^\d+\.\d+\.\d+/);
  } else {
    assert.equal(info.agentVersion, UNKNOWN);
  }
});

test('⑤ 坏 JSON / 空值 / 什么都没有：一律降级成 unknown，且不抛', () => {
  assert.doesNotThrow(() => readBuildInfo({ env: {}, buildInfoPath: tmpInfo('{ 这不是 json'), packageDir: '/nonexistent' }));
  const bad = readBuildInfo({ env: {}, buildInfoPath: tmpInfo('{"station_version":"  "}'), packageDir: '/nonexistent' });
  assert.equal(bad.source, 'unknown', '全空白的 build-info 不算命中，不能报一个空串版本');
  assert.equal(bad.agentVersion, UNKNOWN);
  const emptyOverride = readBuildInfo({ env: { ERIX_AGENT_VERSION: '   ' }, buildInfoPath: tmpInfo({ engine_version: '1.1.1' }) });
  assert.equal(emptyOverride.agentVersion, '1.1.1', '空白 override 不算 override（否则空白能把真值吃掉）');
});

test('⑥ 防回潮：agentd 不许再有 `|| \'0.1.0\'` 兜底，Dockerfile 必须真的烘 build-info.json', async () => {
  const raw = await fs.promises.readFile(path.join(RUNNER_ROOT, 'agentd.js'), 'utf8');
  // 只看代码，不看注释——本文件的注释里就原样引用着被禁的写法（"原先这里是 || '0.1.0'"），
  // 拿它当违规会把判据变成对自己文档的过敏。
  const agentd = raw.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  assert.ok(!/\|\|\s*'0\.1\.0'/.test(agentd), "agentd 里又出现了 || '0.1.0' 这类兜底版本号：未知就该写 unknown");
  assert.ok(agentd.includes('readBuildInfo('), 'agentd 必须经 lib/build-info.js 取版本，而不是自己读 env');
  assert.ok(agentd.includes('runner_version:') && agentd.includes('build_revision:'),
    '心跳要同时带 runner_version / build_revision，否则"哪个构建在跑"又只能靠猜');

  const dockerfile = await fs.promises.readFile(path.join(RUNNER_ROOT, 'Dockerfile'), 'utf8');
  assert.ok(dockerfile.includes('/opt/erix/build-info.json'), 'Dockerfile 不再烘 build-info.json ⇒ 运行时全部退回 unknown');
  assert.ok(/STATION_REVISION/.test(dockerfile), 'revision 必须以 ARG 进镜像（镜像内拿不到 .git）');
  // 版本从镜像内文件取，不从 ARG 传：少一个"必须与构建同步的手工输入"就少一次漂移
  const genLine = dockerfile.split('\n').find((l) => l.includes('/opt/erix/build-info.json') && l.trim().startsWith('RUN'));
  assert.ok(genLine && genLine.includes('"/opt/erix/package.json"') && genLine.includes('erix-agent/package.json'),
    'station/engine 版本必须从镜像内的 package.json 读，不能靠 ARG 传进来（那是第二个要人手工同步的 pin）');
});
