// FDE 镜像的 .NET SDK 矩阵判据（issue #436：SDK 10 与既有 SDK 8 side-by-side）。
//
// 形状照 runner-image-cache-dir.test.js 先例：读 runner/Dockerfile 文本，不跑 docker（单测不许依赖 daemon）。
// 钉住四件事（每一条都对应一个真实会静默失效的失败模式）：
//   1. 两条 COPY --from=…/dotnet/sdk:8.0 与 :10.0 都在，且 10 那行**在 8 之后**——顺序反了照样能建出镜像，
//      只是被 8 的 muxer 覆盖回去，`dotnet --list-sdks` 少一行 10（叠加 COPY 是目录合并，后写的赢顶层 muxer）；
//   2. 构建期 RUN 必须**同时**断言 8. 与 10. 存在（sdk + NETCore.App/AspNetCore.App 运行时），
//      且**不写死补丁号**——官方 tag 是浮动的，钉 8.0.427 这类值会在官方推补丁后把镜像构建钉死；
//   3. 必须有**离线 CoreCLR 烟测**（跑 10 的 Roslyn csc.dll）：`dotnet --list-sdks` 只跑 muxer、不加载运行时，
//      而 sdk:10.0 官方底座是 Ubuntu 24.04 / glibc 2.39、我们跑在 Debian 12 / glibc 2.36 上——
//      某个 10.0.x 补丁抬高 glibc 要求时，只有真加载一次运行时才会在**构建期**红；
//   4. dotnet 层仍排在 playwright / CLI 下载 / 代码 COPY 之前（Dockerfile 文件头的层序不变式：
//      重且稳定的层在前，改 runner 代码不触发重装 .NET/浏览器）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DOCKERFILE = path.join(REPO, 'runner', 'Dockerfile');

const text = fs.readFileSync(DOCKERFILE, 'utf8');
const lines = text.split('\n');
const lineOf = (needle) => {
  const i = lines.findIndex((l) => l.includes(needle));
  assert.ok(i >= 0, `Dockerfile 里必须存在含 ${needle} 的行（改动层序/写法时同步本判据）`);
  return i;
};

test('runner 镜像必须叠加 COPY SDK 8 与 SDK 10 的 /usr/share/dotnet（10 在后）', () => {
  const at8 = lineOf('COPY --from=mcr.microsoft.com/dotnet/sdk:8.0 /usr/share/dotnet /usr/share/dotnet');
  const at10 = lineOf('COPY --from=mcr.microsoft.com/dotnet/sdk:10.0 /usr/share/dotnet /usr/share/dotnet');
  assert.ok(at10 > at8,
    'SDK 10 的 COPY 必须排在 SDK 8 之后：两条 COPY 合并进同一目录，后写的会覆盖顶层 muxer `dotnet`（顺序反了 10 会被 8 盖掉）');
  // 目标目录必须是同一个 /usr/share/dotnet（换个目录 = 两套并行安装，dotnet 只认 DOTNET_ROOT 那一套）
  const copies = lines.filter((l) => /^COPY --from=mcr\.microsoft\.com\/dotnet\/sdk:/.test(l));
  assert.equal(copies.length, 2, '必须正好两条 dotnet SDK COPY（多一条意味着有人在复制别的东西进 /usr/share/dotnet）');
  for (const l of copies) assert.match(l, / \/usr\/share\/dotnet \/usr\/share\/dotnet$/, `COPY 目标必须是 /usr/share/dotnet：${l}`);
});

test('构建期 RUN 必须同时断言 SDK 8. 与 10.（不写死补丁号）', () => {
  const runBlock = lines.slice(
    lineOf('ln -s /usr/share/dotnet/dotnet /usr/local/bin/dotnet'),
  ).join('\n').split('\n\n')[0];
  assert.match(runBlock, /dotnet --list-sdks \| grep -q '\^8\\\.'/, '必须断言 SDK 8.x 存在（grep -q \'^8\\.\'）');
  assert.match(runBlock, /dotnet --list-sdks \| grep -q '\^10\\\.'/, '必须断言 SDK 10.x 存在（grep -q \'^10\\.\'）');
  // 运行时也要两个框架都在：只查 --list-sdks 时，shared/ 缺失（比如有人改成只 COPY sdk/ 子目录）不会被发现
  assert.match(runBlock, /for fw in Microsoft\.NETCore\.App Microsoft\.AspNetCore\.App/, '必须对 NETCore.App 与 AspNetCore.App 两个框架都断言');
  assert.match(runBlock, /grep -q "\^\$fw 8\\\."/, '必须断言每个框架的 8.x 运行时存在');
  assert.match(runBlock, /grep -q "\^\$fw 10\\\."/, '必须断言每个框架的 10.x 运行时存在');
  // 补丁号会随官方 tag 漂：写死等于给镜像构建埋一颗定时炸弹（官方一推补丁就构建失败）
  assert.doesNotMatch(text, /\b(?:8|10)\.0\.\d+\b/,
    '不得硬编码补丁号（如 8.0.427 / 10.0.403）：官方 sdk tag 是浮动的，补丁号必然漂移');
});

test('必须有离线 CoreCLR 烟测（真加载 10 的运行时，--list-sdks 只跑 muxer 不够）', () => {
  // 只认 RUN 指令里的那一行（注释里也会出现 csc.dll 字样，按「以 && 开头」区分）
  const smoke = lines.find((l) => l.trimStart().startsWith('&&') && l.includes('csc.dll'));
  assert.ok(smoke, '必须有离线 CoreCLR 烟测：dotnet --list-sdks 不加载运行时，加载不了运行时的镜像照样能过那一步');
  assert.match(smoke, /dotnet "\$\(ls -d \/usr\/share\/dotnet\/sdk\/10\.\*\/ \| head -1\)Roslyn\/bincore\/csc\.dll" -version/,
    '烟测必须是「取 10.x 的 SDK 目录 + Roslyn/bincore/csc.dll -version」（不联网、几秒、真加载 CoreCLR）');
  assert.doesNotMatch(smoke, /https?:\/\//, '烟测不许联网（构建机网络不可靠，且这不是网络判据）');
});

test('dotnet 层必须排在 playwright / CLI 下载 / 代码 COPY 之前（层序不变式）', () => {
  const dotnetAt = lineOf('COPY --from=mcr.microsoft.com/dotnet/sdk:10.0 /usr/share/dotnet /usr/share/dotnet');
  const later = [
    ['playwright 安装', 'npm install -g playwright'],
    ['gh/tea/glab 下载', 'GH_CLI_VERSION'],
    ['runner 代码 COPY', 'COPY agentd.js'],
    ['npm install --omit=dev', 'npm install --omit=dev'],
  ];
  for (const [name, needle] of later) {
    assert.ok(dotnetAt < lineOf(needle),
      `.NET 层必须排在「${name}」之前：这层重且稳定，排后面会让改 runner 代码/升 CLI 版本时重装 .NET`);
  }
});
