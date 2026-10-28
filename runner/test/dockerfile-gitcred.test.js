import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// issue #399（源码契约锚点）：runner 镜像的 system 级 git credential 配置。
// 真机语义（fill 代答 / ro 下 erase 存活 / approve 零噪音）已在容器实测评过（见 PR 正文）；
// 这里锁的是**形状不回退**——这三条任何一个被"顺手整理"掉，凭据就会回到「一次 401 静默删行」：
//   ① 平台 helper 必须落在 **/etc/gitconfig**（system 级）：local/-c 的 helper 是追加在 system
//      之后的，写 ~/.gitconfig 会被 FDE 后配的条目插队（容器实测，#399 表格末行）。
//   ② 平台条必须**排在 store 前**：git 逐 helper 询问、先答先赢。
//   ③ helper 必须是 fill-only 脚本（get 代答、store/erase 静默 no-op），且指向
//      /run/erix/git/credentials——那正是 ro bind 的挂载点（provisioner binds 有独立断言）。

const dockerfile = fs.readFileSync(new URL('../../runner/Dockerfile', import.meta.url), 'utf8');

// 把 Dockerfile 的续行（`\` 结尾）拼回逻辑行再断言。
function logicalLines(text) {
  const out = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (line.endsWith('\\')) cur += line.slice(0, -1) + ' ';
    else { out.push(cur + line); cur = ''; }
  }
  if (cur) out.push(cur);
  return out;
}

const blocks = logicalLines(dockerfile).filter((b) => b.includes('erix-gitcred') || b.includes('/etc/gitconfig'));
const gitconfigBlock = blocks.find((b) => b.includes('> /etc/gitconfig')) ?? '';
const helperBlock = blocks.find((b) => b.includes('> /usr/local/libexec/erix-gitcred')) ?? blocks.find((b) => b.includes('erix-gitcred')) ?? '';

test('#399 /etc/gitconfig：平台 helper 在 system 级且排在 store 前', () => {
  assert.ok(gitconfigBlock, '必须仍有一条写 /etc/gitconfig 的 RUN');
  assert.ok(gitconfigBlock.includes('sharedRepository = group'), '既有的跨 UID 协作配置不得丢');
  assert.ok(gitconfigBlock.includes('directory = *'), 'safe.directory 配置不得丢');
  const credHelpers = [...gitconfigBlock.matchAll(/helper = ([^\\]*?)(?:\\n|$)/g)].map((m) => m[1]);
  assert.equal(credHelpers.length, 2, `credential.helper 必须恰有两条（平台 + FDE store），实际 ${credHelpers.length}：${JSON.stringify(credHelpers)}`);
  assert.ok(credHelpers[0].includes('erix-gitcred') && credHelpers[0].includes('/run/erix/git/credentials'),
    `第一条必须是读 /run/erix/git/credentials 的平台 helper：${credHelpers[0]}`);
  assert.ok(credHelpers[1].trim() === 'store', `第二条必须是裸 store（读 $HOME/.git-credentials）：${credHelpers[1]}`);
});

test('#399 fill-only helper：get 代答、其余操作静默 exit 0，脚本 0755', () => {
  assert.ok(helperBlock, 'erix-gitcred 必须仍在 Dockerfile 里');
  assert.ok(helperBlock.includes('get "*) exec git credential-store'), 'get 必须 exec git credential-store 代答（--file 由 helper 行传入）');
  assert.ok(helperBlock.includes('*) exit 0'), 'store/erase 必须静默 exit 0（非零会把 lock 噪音请回来）');
  assert.ok(helperBlock.includes('chmod 0755 /usr/local/libexec/erix-gitcred'), '脚本必须 root:root 0755（agent 非 root 改不动）');
  assert.ok(helperBlock.includes('install -d -o root -g root -m 0755 /usr/local/libexec'), 'libexec 目录必须 root:root 0755');
});

test('#399 凭据脚本对 get/store/erase 三相的行为（直接跑 printf 出的脚本本体）', async (t) => {
  // 把 Dockerfile 里 printf 的脚本原文抠出来（printf '...' > /usr/local/libexec/erix-gitcred 的第一个参数）。
  const m = helperBlock.match(/printf '((?:[^'\\]|\\.)*)' > \/usr\/local\/libexec\/erix-gitcred/);
  assert.ok(m, 'Dockerfile 里必须能以 printf 单引号串的形式找到 helper 脚本');
  const script = m[1].replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  const { mkdtempSync, writeFileSync, chmodSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'erix-gitcred-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const scriptPath = join(dir, 'erix-gitcred');
  writeFileSync(scriptPath, script, { mode: 0o755 });
  chmodSync(scriptPath, 0o755);
  const credFile = join(dir, 'credentials');
  writeFileSync(credFile, 'https://u:s3cret@plat.host\n');

  const { execSync } = await import('node:child_process');
  // stdin 走临时文件 + shell 重定向：execFileSync+input 在子进程不读 stdin 的分支（store/erase）上有 EPIPE 竞态。
  const stdinFile = join(dir, 'stdin');
  const run = (op, stdin = '') => {
    writeFileSync(stdinFile, stdin);
    return execSync(`/bin/sh ${JSON.stringify(scriptPath)} --file=${JSON.stringify(credFile)} ${op} < ${JSON.stringify(stdinFile)}`, { encoding: 'utf8' });
  };

  const got = run('get', 'protocol=https\nhost=plat.host\n\n');
  assert.match(got, /username=u/);
  assert.match(got, /password=s3cret/);
  assert.equal(run('store', 'protocol=https\nhost=plat.host\nusername=u\npassword=s3cret\n\n'), '');
  assert.equal(fs.readFileSync(credFile, 'utf8'), 'https://u:s3cret@plat.host\n', 'store 不得写平台文件');
  assert.equal(run('erase', 'protocol=https\nhost=plat.host\nusername=u\npassword=WRONG\n\n'), '');
  assert.equal(fs.readFileSync(credFile, 'utf8'), 'https://u:s3cret@plat.host\n', 'erase 不得删平台文件里的行——#399 的全部意义');
});
