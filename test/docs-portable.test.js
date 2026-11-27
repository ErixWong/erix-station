// check-doc-portable 的行为夹具（issue docs-261124-31）。
// CLI 的扫描范围是从**脚本自己的文件位置**推 ROOT（`path.resolve(__dirname, '..')`）⇒
// 夹具必须在**副本**上跑（把 CLI 复制进 `<夹具>/scripts/`）：否则测的是被扫的仓库、
// 而不是夹具的 `.md`。照 test/agents-hotlayer.test.js 的夹具写法。
// ⚠ 本文件是 `*.js`，会被闸扫到**注释行**——故注释里不许写 DENY 词字面量；夹具用的脏词一律放进
//   writeFileSync 的**代码行**（非注释），断言正则同理。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts/check-doc-portable.mjs');

/** 在临时 git 仓库里跑 CLI 副本，返回 { rc, out }。 */
function runRepo(dir, fn, args = []) {
  const sh = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  sh(['init', '-q']);
  sh(['config', 'user.email', 'test@test.local']);
  sh(['config', 'user.name', 'test']);
  fn(dir);
  sh(['add', '-A']);
  try {
    const stdout = execFileSync('node', [path.join(dir, 'scripts/check-doc-portable.mjs'), ...args], { encoding: 'utf8' });
    return { rc: 0, out: stdout };
  } catch (e) {
    /** @type {any} */ const err = e;
    const out = `${err.stdout || ''}${err.stderr || ''}`;
    return { rc: typeof err.status === 'number' ? err.status : -1, out };
  }
}

const fixture = (fn, args = []) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'docport-'));
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  copyFileSync(CLI, path.join(dir, 'scripts/check-doc-portable.mjs'));
  try {
    return runRepo(dir, fn, args);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** 同一棵夹具树上跑两次 CLI（不带 / 带测量开关）——用于证明测量不改退出码。 */
function fixtureTwice(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'docport-'));
  const cli = path.join(dir, 'scripts/check-doc-portable.mjs');
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  copyFileSync(CLI, cli);
  const sh = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  const run = (args) => {
    try {
      return { rc: 0, out: execFileSync('node', [cli, ...args], { encoding: 'utf8' }) };
    } catch (e) {
      /** @type {any} */ const err = e;
      return { rc: typeof err.status === 'number' ? err.status : -1, out: `${err.stdout || ''}${err.stderr || ''}` };
    }
  };
  try {
    sh(['init', '-q']);
    sh(['config', 'user.email', 'test@test.local']);
    sh(['config', 'user.name', 'test']);
    fn(dir);
    sh(['add', '-A']);
    const base = run([]);
    const measured = run(['--identity-words']);
    return { rcBase: base.rc, outBase: base.out, rcMeasured: measured.rc, outMeasured: measured.out };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 测量格子的词（都是**代码行**拼接，注释里不留明文；下同）。
const LOGIN = ['er', 'ic'].join('');
const GENERIC = ['gen', LOGIN].join(''); // 词边界反例：含词根的通用词
const HOME_HOST = ['/home/', LOGIN].join(''); // 既有组合词：宿主家目录
const HOME_CONTAINER = ['/home/', 'e', 'rix'].join(''); // 产品容器内用户名（既有例外）
const MEASURE_HDR = /身份词测量/; // 测量读数真的打了（否则「不被报」的断言会空转）

// ① 真仓库（工作树）跑 exit 0 —— 这是「仓库文档现在真的可公开」
test('真仓库跑 check:doc-portable exit 0', () => {
  const out = execFileSync('node', [CLI], { encoding: 'utf8' });
  assert.match(out, /check:doc-portable ok/);
});

// ② 夹具里塞一行含某机器坐标（DENY_INFRA 词）的 md → 必须 exit≠0 且输出带该 file:line
//    ⚠ 夹具里的坐标也用**片段拼接**：本文件本身在仓库里，不留明文（下同）
test('夹具：含机器坐标的 md 被拦，且报出 file:line', () => {
  const proxy = ['172.20.', '0.35'].join('');
  const { rc, out } = fixture((dir) => {
    writeFileSync(path.join(dir, 'ok.md'), '# ok\n\n这行干净：只有伞域名与端口号 8090。\n');
    writeFileSync(path.join(dir, 'dirty.md'), `# t\n\n本机坐标 ${proxy} 出口代理。\n`);
  });
  assert.notEqual(rc, 0, 'DENY 词还在却 exit 0 = 闸失效');
  assert.ok(out.includes(`dirty.md:3: ${proxy}`), `输出未点名脏文件的 file:line，实得:\n${out}`);
  assert.doesNotMatch(out, /ok\.md:/, '干净文件不该被点名');
});

// ③ 身份级 DENY_IDENTITY 永不被 EXEMPT 豁免：把含真实邮箱域的行写进一条 EXEMPT 路径，
//    必须 exit≠0 且点名该 file:line——证明历史账能留坐标、却不能留身份（本轮补上的那一层）。
test('夹具：身份词写进 EXEMPT 路径仍被拦，且报出 file:line', () => {
  const org = ['inteva', 'products'].join('');
  const { rc, out } = fixture((dir) => {
    mkdirSync(path.join(dir, 'docs', 'ops'), { recursive: true });
    writeFileSync(
      path.join(dir, 'docs', 'ops', 'handoff-2026-10-14.md'),
      `# 交接单\n\n上游中转组织 ${org} 的额度全局耗尽。\n`,
    );
  });
  assert.notEqual(rc, 0, '身份词还在 EXEMPT 文件里却 exit 0 = EXEMPT 越界豁免了身份');
  assert.ok(
    out.includes(`docs/ops/handoff-2026-10-14.md:3: ${org}`),
    `输出未点名 EXEMPT 文件里的身份 file:line，实得:\n${out}`,
  );
});

// ---------- 以下五格：测量通道（issue 889 第一步）+ 翻拦后的口径（889 第二步）----------
// 旧 DENY_IDENTITY 全走子串匹配，宿主登录名那条还是组合词（要配家目录前缀）
// ⇒「裸登录名当业务前缀」（`<登录名>-p-<port>` 预览域名）整个漏。第一步只量面：命中要报出来，退出码不变。
// ⚠ 第二步已把这条测量条目**并进 DENY**（`DENY_IDENTITY.push(...MEASURE_COMPILED…)`）⇒ 这些格子不再断言
//   「有测量命中而 rc=0」（那条前提已被翻拦取代）；rc 的语义改由 ⑩（探针必拦）与 ⑫（真仓库必须干净）钉。

// ④ `<登录名>-p-8080` 必须被测量输出报出（含 file:line）。
//    翻拦之后这一行同时也是一条拦截命中 ⇒ 本格只管「报没报出来」，不管退出码。
test('测量：裸登录名当业务前缀被报出 file:line', () => {
  const { out } = fixture((dir) => {
    writeFileSync(path.join(dir, 'preview.md'), `# 预览域名\n\n端口 8080 映射到 ${LOGIN}-p-8080。\n`);
  }, ['--identity-words']);
  assert.match(out, MEASURE_HDR, '测量开关没打读数 = 等于没做这一步');
  assert.ok(
    out.includes(`preview.md:3: ${LOGIN}`),
    `测量输出未点名裸登录名的 file:line，实得:\n${out}`,
  );
});

// ⑤ 词边界的反例：通用词里含着词根（子串匹配会误报），带边界的通道就不得报它。
//    先自证前提：GENERIC 确实含 LOGIN——不然本格测不到「退化成 includes 时必须红」。
test('测量：含词根的通用词不被误报（词边界不得退化成 includes）', () => {
  assert.ok(GENERIC.includes(LOGIN), '夹具前提不成立：通用词未含词根，本格将空转');
  assert.ok(!new RegExp(`\\b${LOGIN}\\b`).test(GENERIC), '夹具前提不成立：该通用词本身就有词边界');
  const { rc, out } = fixture((dir) => {
    writeFileSync(path.join(dir, 'words.md'), `# t\n\n这里是 ${GENERIC} 形态的占位词，不是身份。\n`);
  }, ['--identity-words']);
  assert.match(out, MEASURE_HDR, '测量开关没打读数 = 断言会空转');
  assert.equal(rc, 0);
  assert.ok(
    !out.includes('words.md:3'),
    `通用词 ${GENERIC} 被当成身份误报（词边界退化成了 includes），实得:\n${out}`,
  );
});

// ⑥ 产品容器内用户名（家目录下的容器账号）仍不得被报：既有例外不许被新通道撞掉。
test('测量：容器内用户名的家目录路径仍不被报', () => {
  const { rc, out } = fixture((dir) => {
    writeFileSync(path.join(dir, 'container.md'), `# t\n\n容器内路径 ${HOME_CONTAINER} 与端口 9443。\n`);
  }, ['--identity-words']);
  assert.match(out, MEASURE_HDR);
  assert.equal(rc, 0, '容器内用户名不该被拦，rc 却非 0 = 新通道把例外撞了');
  assert.ok(
    !out.includes('container.md:3'),
    `容器内家目录 ${HOME_CONTAINER} 被误报，实得:\n${out}`,
  );
});

// ⑦ 旧组合词不得退化：家目录前缀 + 登录名 仍必须 exit≠0 并拦下（输出形状不变），
//    同时新边界通道也要把同一行报出来（两条命中并存，不互相取代）。
test('测量：家目录前缀组合词仍被拦（旧规则不退化）且同时被测量报出', () => {
  const { rc, out } = fixture((dir) => {
    writeFileSync(path.join(dir, 'host.md'), `# t\n\n宿主家目录 ${HOME_HOST}。\n`);
  }, ['--identity-words']);
  assert.notEqual(rc, 0, '旧组合词退化了 = 闸变松');
  assert.ok(
    out.includes(`host.md:3: ${HOME_HOST}`),
    `拦截输出未点名 ${HOME_HOST} 的 file:line（旧行为变了），实得:\n${out}`,
  );
  assert.ok(
    out.includes(`host.md:3: ${LOGIN}`),
    `新边界通道未报同一行，实得:\n${out}`,
  );
});

// ⑧ 测量开关只决定**打印**，不改退出码：同一棵树上开关前后 rc 相同。
//    两棵树各验一次：只有裸登录名命中的树（翻拦前后 rc 都同一个值）与真被坐标拦下的脏树（同为非 0）。
//    ⚠ 翻拦前本格还断言「量面树 base rc=0」——那条前提已被第二步取代，故这里只钉「开关前后相等」。
test('测量：开关不改变退出码（同一棵树开关前后 rc 相同）', () => {
  const clean = fixtureTwice((dir) => {
    writeFileSync(path.join(dir, 'preview.md'), `# t\n\n${LOGIN}-p-8080 是预览域名示例。\n`);
  });
  assert.ok(
    clean.outMeasured.includes(`preview.md:3: ${LOGIN}`),
    `量面树开关后没报出命中，本格将空转，实得:\n${clean.outMeasured}`,
  );
  assert.equal(
    clean.rcMeasured,
    clean.rcBase,
    `量面树上开关改了退出码（${clean.rcBase} → ${clean.rcMeasured}）= 开关不再只是「打印开关」`,
  );
  const dirty = fixtureTwice((dir) => {
    const proxy = ['172.20.', '0.35'].join('');
    writeFileSync(path.join(dir, 'dirty.md'), `# t\n\n本机坐标 ${proxy}。\n`);
  });
  assert.notEqual(dirty.rcBase, 0, '脏树 base rc 应为非 0，否则本格测不到东西');
  assert.equal(
    dirty.rcMeasured,
    dirty.rcBase,
    `被拦树上开关也改了退出码（${dirty.rcBase} → ${dirty.rcMeasured}）`,
  );
});


// ⑨ dev 脚本账号名（#777 D6）：它写在**扫描面内**必须被拦并报出 file:line。
//    本格存在的理由：这个名字此前不在任何 DENY 清单里 ⇒ 闸查不到自家违例（AGENTS §4.1 与
//    docs/testing.md §1.3 自己就写着它，而 AGENTS §6 规定 dev 账号名不进本仓库）。
//    夹具里的名字同样**拆片构造**——本文件是 `*.js`，注释里不许留明文（下同）。
test('夹具：dev 脚本账号名出现在扫描面内被拦，且报出 file:line', () => {
  const devAcct = ['agent', '01'].join('');
  assert.ok(devAcct.length === 7, '夹具前提不成立：拆片没拼回 7 个字符的本名');
  const { rc, out } = fixture((dir) => {
    writeFileSync(path.join(dir, 'devacct.md'), `# 脚本账号\n\n脚本一律登 \`${devAcct}\` 走会话。\n`);
    writeFileSync(path.join(dir, 'clean.md'), '# ok\n\n这行只写「dev 脚本账号」这个中性说法。\n');
  });
  assert.notEqual(rc, 0, 'dev 账号名还在扫描面里却 exit 0 = 这条 DENY 没生效');
  assert.ok(
    out.includes(`devacct.md:3: ${devAcct}`),
    `输出未点名脏文件的 file:line，实得:\n${out}`,
  );
  assert.doesNotMatch(out, /clean\.md:/, '中性写法那行不该被点名');
});

// ---------- 以下三格：翻拦（issue 889 第二步）----------
// 翻拦 = 把测量条目并进 DENY_IDENTITY（词边界不变）。于是「裸登录名」从「只报」变成「必拦」：
//   ⑩ 探针必须被拦（翻拦真的生效）；⑪ 词边界必须还在（退化成子串就没人抓得住）；
//   ⑫ 真仓库必须干净（这条会随「谁以后又把名字写回文档」而红 = 翻拦的收益本身）。

// ⑩ 探针：裸登录名写在扫描面的 md 里 ⇒ rc≠0 且报错点名 docs/probe.md:<行号>。
//    顺带钉打印标签：DENY_IDENTITY 里现在是 {tok,re} 对象条目，标签取错就会打成 `[object Object]`。
test('翻拦：裸登录名探针出现在扫描面内被拦，且报出 file:line（标签不是 [object Object]）', () => {
  const { rc, out } = fixture((dir) => {
    mkdirSync(path.join(dir, 'docs'), { recursive: true });
    writeFileSync(path.join(dir, 'docs', 'probe.md'), `# 预览域名\n\n端口 8080 映射到 ${LOGIN}-p-8080。\n`);
  });
  assert.notEqual(rc, 0, '裸登录名还在扫描面里却 exit 0 = 翻拦没生效（测量条目没进 DENY）');
  assert.ok(
    out.includes(`docs/probe.md:3: ${LOGIN}`),
    `拦截输出未点名探针的 file:line，实得:\n${out}`,
  );
  assert.doesNotMatch(out, /\[object Object\]/, `命中标签打成了对象（label 取错），实得:\n${out}`);
});

// ⑪ 词边界：含词根的通用词（`gen` + 词根）不许被拦。这是边界存在的全部理由——
//    没有本格，「把 boundary 关掉 / 退化成子串」这种退化就没人抓得住（翻拦之后它会满屏假阳性：
//    仓库文档与注释里到处是含这个词根的通用词，`①` 那格也会连带红）。
//    先自证前提：GENERIC 确实含 LOGIN，否则本格空转。
test('翻拦：含词根的通用词不被拦（词边界不得退化成子串）', () => {
  assert.ok(GENERIC.includes(LOGIN), '夹具前提不成立：通用词未含词根，本格将空转');
  assert.ok(!new RegExp(`\\b${LOGIN}\\b`).test(GENERIC), '夹具前提不成立：该通用词本身就有词边界');
  const proxy = ['172.20.', '0.35'].join('');
  const { rc, out } = fixture((dir) => {
    mkdirSync(path.join(dir, 'docs'), { recursive: true });
    writeFileSync(path.join(dir, 'docs', 'words.md'), `# t\n\n这里是 ${GENERIC} 形态的占位词，不是身份。\n`);
    // 同树放一条**真坐标**：先证明这棵树真的产出了命中，否则「没点名 words.md」会因闸没跑而空转。
    writeFileSync(path.join(dir, 'docs', 'dirty.md'), `# t\n\n本机坐标 ${proxy}。\n`);
  });
  assert.notEqual(rc, 0, '夹具里的坐标行本该被拦，rc 却是 0 = 本格的断言会空转');
  assert.ok(out.includes(`docs/dirty.md:3: ${proxy}`), `坐标行未点名，实得:\n${out}`);
  assert.ok(
    !out.includes('docs/words.md:3'),
    `通用词 ${GENERIC} 被当成身份拦下（词边界退化成子串），实得:\n${out}`,
  );
});

// ⑫ 真仓库自身必须干净：测量读数为 0，且 rc=0（翻拦之后「写回文档」= 当场红）。
//    跑的是真仓库根（不是夹具）——这正是翻拦的收益本身，故它允许依赖工作树。
test('翻拦：真仓库的测量读数为 0 且 exit 0（文档里不再有裸登录名形态）', () => {
  let rc = 0;
  let out = '';
  try {
    out = execFileSync('node', [CLI, '--identity-words'], { encoding: 'utf8' });
  } catch (e) {
    /** @type {any} */ const err = e;
    rc = typeof err.status === 'number' ? err.status : -1;
    out = `${err.stdout || ''}${err.stderr || ''}`;
  }
  assert.equal(rc, 0, `真仓库跑 check:doc-portable rc=${rc}（身份/坐标泄露没搬干净），实得:\n${out}`);
  assert.match(out, MEASURE_HDR, '测量开关没打读数 = 本格的断言会空转');
  const m = out.match(/身份词测量[^\n]*?：(\d+) 处/);
  assert.ok(m, `没在输出里读到测量读数，实得:\n${out}`);
  assert.equal(Number(m[1]), 0, `测量读数应为 0，实得 ${m[1]} 处：\n${out}`);
});
