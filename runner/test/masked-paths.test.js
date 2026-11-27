// 密钥遮蔽（maskedPaths）接进生产链路（issue #231 / 工单 fix-261115-02，2026-11-15）。
//
// 病根：`lib/file-tools.js` 的遮蔽能力一直存在（createJail 有 maskedPaths 形参、`#228` 时装配层也补了
// 入参并有单测），但**装配点 `runner/worker.js` 两处调用一个都没传**（`maskedPaths` 在 worker.js 里 0 处）
// ⇒ 能力在生产链路里等于没开，真机表现就是模型 `readFile .env` 直接把数据库密码全文拽进 transcript。
// 所以本文件不只测遮蔽语义，还钉「生产装配点确实传了」这条接线（第 10 组，源码级锁）。
//
// 三条主判据（工单原文）：
//   ① jail 根下放 `.env` ⇒ readFile 拿不到，且错误点名被遮蔽；
//   ② 反向：同目录普通文件照读；
//   ③ 钉一条现状：shell `cat .env` **仍能读到**——这条**不许当 bug 修**（理由见下）。
//
// ⚠ 口径不对称，且这是设计不是漏洞：`lib/shell-tools.js` 头注明写「shell 有意越过项目目录（cwd）的文件牢笼 文件牢笼
//   ——容器是信任边界（不变式 1）」⇒ maskedPaths 的定位是**防止敏感内容被主动读进 transcript / 上下文**，
//   不是安全加固。遮蔽集合只针对**项目目录以内**：FDE home 下的 `~/.ssh`、`~/.git-credentials`、
//   `~/.erix/*` 本来就在 jail 根之外，文件工具一直读不到，不属于「漏了」。
//   口径登记：`docs/design/runner-integration.md` §6.3-3 / §17.1。
//
// 隔离约定：全部用例跑在 `fs.mkdtempSync(os.tmpdir())` 里，不碰真实项目目录与真实家目录。
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJail, createStationFileTools, JailError, STATION_MASKED_PATHS } from '../lib/file-tools.js';
import { createShellTools } from '../lib/shell-tools.js';

// ---- 夹具生命周期：mkdtemp 与注册 rm 必须在同一条用例内闭环（#880）----
// withTempDir 的 erix-mask-231- 一律进 tmpDirs；它自己 finally 里那份 rm 仍是第一道防线。
// force 是必需的：两道 rm 会撞同一个目录，必须容忍「已经没了」；真漏注册闸会当场抱住。
const tmpDirs = [];
function trackTmp(dir) {
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    // rmSync 必须是真语句：注释掉它 while 就空转成死循环（#880 批一踩过）。
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true, maxRetries: 3 });
  }
});

const RUNNER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 生产口径的装配（与 worker.js 的调用形态一致）：jail 与装配层拿同一份名单。 */
function stationTools(root, maskedPaths = STATION_MASKED_PATHS) {
  const jail = createJail({ root, writable: [root], maskedPaths });
  return { jail, tools: createStationFileTools({ jail, cwd: root, maskedPaths }) };
}

async function withTempDir(fn) {
  const dir = fs.realpathSync(trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'erix-mask-231-'))));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 造一个「像真项目」的骨架：根内密钥 + 普通文件 + 深层密钥 + 会被误伤的普通名字。 */
function seedProject(root) {
  fs.writeFileSync(path.join(root, '.env'), 'DB_PASSWORD=hunter2\n');
  fs.writeFileSync(path.join(root, '.env.local'), 'DB_PASSWORD=local9\n');
  fs.writeFileSync(path.join(root, '.env.example'), 'DB_PASSWORD=\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# project\n');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'plain note\n');
  fs.writeFileSync(path.join(root, '.npmrc'), '//registry.npmjs.org/:_authToken=TOK\n');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'config'), '[remote "origin"]\n\turl = https://u:p@gh/x\n');
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.mkdirSync(path.join(root, 'deploy', 'tls'), { recursive: true });
  fs.writeFileSync(path.join(root, 'deploy', 'tls', 'server.pem'), 'PEMDATA-BLOB\n');
  fs.mkdirSync(path.join(root, 'deploy', 'keys'), { recursive: true });
  fs.writeFileSync(path.join(root, 'deploy', 'keys', 'id_ed25519'), 'OPENSSH-BLOB\n');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'main.js'), 'export const x = 1;\n');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sub', '.npmrc'), 'nested token\n');
  fs.writeFileSync(path.join(root, 'sub', 'id_mapping.csv'), 'id,name\n');
}

const read = async (tools, p) => String(await tools.executeTool('readFile', { path: p }, {}));
const denied = (text) => /^错误：读取被宿主边界拒绝：/u.test(text);

// ---------------------------------------------------------------------------
// 判据 ① + ②（工单原文那两条）
// ---------------------------------------------------------------------------

test('判据①：jail 根下的 .env 用 readFile 拿不到，错误点名被遮蔽、内容一字节不泄露', () =>
  withTempDir(async (root) => {
    seedProject(root);
    const { jail, tools } = stationTools(root);

    const out = await read(tools, '.env');
    assert.match(out, /^错误：/u, '被遮蔽的读必须是错误文本结果（上游统一形态，不抛异常）');
    assert.match(out, /被宿主边界拒绝/u, '必须是边界拒绝这一类，不是 ENOENT 之类的「文件不存在」');
    assert.match(out, /\.env/u, '错误必须点名被拒的路径（模型据此才知道是遮蔽，不是没这个文件）');
    assert.doesNotMatch(out, /hunter2/u, '被遮蔽的内容一个字节都不许回传');

    // 「点名被遮蔽」的直给证据：jail 自己抛的那条（装配层把它转成布尔，所以工具文本只剩通用文案）。
    assert.throws(() => jail.assertReadable('.env'), (error) => {
      assert.ok(error instanceof JailError, '必须是 JailError，不是 realpath 之类的系统错');
      assert.equal(error.code, 'path_masked', '必须点名「被遮蔽」，不能和 path_escapes_root 混成一类');
      assert.match(error.message, /\.env/u, 'message 要点名被遮蔽的路径');
      return true;
    });
  }));

test('判据②（反向）：同目录的普通文件照读，逐字节内容在输出里', () =>
  withTempDir(async (root) => {
    seedProject(root);
    const { jail, tools } = stationTools(root);

    assert.match(await read(tools, 'notes.txt'), /1: plain note/u);
    assert.match(await read(tools, 'README.md'), /1: # project/u);
    assert.match(await read(tools, 'src/main.js'), /export const x = 1/u);
    assert.equal(jail.assertReadable('notes.txt'), path.join(root, 'notes.txt'),
      'jail 侧也必须放行（否则上一组的「挡住」可能来自越界而不是遮蔽）');
  }));

test('判据③（现状钉桩，不许当 bug 修）：shell `cat .env` 仍能读到全文', () =>
  withTempDir(async (root) => {
    seedProject(root);
    const { tools } = stationTools(root);
    const shell = createShellTools({ worktreeRoot: root });

    const out = await shell.executors.shell({ command: 'cat .env' });
    assert.match(out, /exit_code: 0/u);
    assert.match(out, /DB_PASSWORD=hunter2/u,
      'shell 有意越过文件牢笼（不变式 1）⇒ 遮蔽不该出现在这里，红了就说明有人把「不对称」当 bug 修了');
    // 同一次装配里，文件工具仍然拒它：不对称**同时在场**才是这条口径的完整形状。
    assert.match(await read(tools, '.env'), /^错误：/u);
  }));

// ---------------------------------------------------------------------------
// 生产名单逐项（STATION_MASKED_PATHS 的覆盖面 / 边界）
// ---------------------------------------------------------------------------

test('生产名单逐项命中：.env* 与 .git/config 与 .npmrc 与 *.pem 与 id_*（模式条目任意深度）', () =>
  withTempDir(async (root) => {
    seedProject(root);
    const { tools } = stationTools(root);
    for (const [p, secret] of [
      ['.env', 'hunter2'],
      ['.env.local', 'local9'],
      ['.git/config', 'u:p@gh'],
      ['.npmrc', '_authToken=TOK'],
      ['deploy/tls/server.pem', 'PEMDATA-BLOB'],
      ['deploy/keys/id_ed25519', 'OPENSSH-BLOB'],
    ]) {
      const out = await read(tools, p);
      assert.ok(denied(out), `${p} 必须被遮蔽，实际拿到：${out.slice(0, 60)}`);
      assert.doesNotMatch(out, new RegExp(secret, 'u'), `${p} 的内容不得回传`);
    }
  }));

test('名单的反面同样要钉：.git/HEAD、src/main.js、嵌套 sub/.npmrc 都不该被挡（口径只到点名的那些）', () =>
  withTempDir(async (root) => {
    seedProject(root);
    const { tools } = stationTools(root);
    assert.match(await read(tools, '.git/HEAD'), /refs\/heads\/main/u,
      '.git 只遮 config；HEAD / packed-refs 不是密钥，挡了就是过度遮蔽');
    assert.match(await read(tools, 'src/main.js'), /export const x/u);
    assert.match(await read(tools, 'sub/.npmrc'), /nested token/u,
      '前缀条目只挡项目根那一个（深度语义与名字模式不同，见 STATION_MASKED_PATHS 注记）');
  }));

test('已知误伤是刻意代价（签入模板 .env.example、普通名字 id_mapping.csv 也被挡）', () =>
  withTempDir(async (root) => {
    seedProject(root);
    const { tools } = stationTools(root);
    assert.ok(denied(await read(tools, '.env.example')), '.env* 命中签入仓库的模板：口径如此，出口是 shell');
    assert.ok(denied(await read(tools, 'sub/id_mapping.csv')), 'id_* 按段匹配 ⇒ 任意深度的 id_ 前缀名字都中招');
  }));

test('只挡读不挡写（与 createJail.assertReadable 逐字对齐的旧口径）：writeFile / edit 对 .env 照用', () =>
  withTempDir(async (root) => {
    seedProject(root);
    const { tools } = stationTools(root);
    assert.equal(await tools.executeTool('writeFile', { path: '.env', content: 'DB_PASSWORD=rotated\n' }, {}),
      20, 'writeFile 返回写入字节数（0 也算成功），遮蔽不得把它拦下来');
    assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), 'DB_PASSWORD=rotated\n');
    const edited = String(await tools.executeTool('edit',
      { path: '.env', edits: [{ oldText: 'rotated', newText: 'final' }] }, {}));
    assert.doesNotMatch(edited, /^错误：/u, 'edit 只吃写边界 ⇒ 遮蔽文件仍可改（继承行为，不是本单新洞）');
    assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), 'DB_PASSWORD=final\n');
  }));

test('遍历面同步生效：tree 不列被遮条目、searchText 把它计入模型可见排除账', () =>
  withTempDir(async (root) => {
    seedProject(root);
    const { tools } = stationTools(root);

    const tree = String(await tools.executeTool('tree', { path: '.', include_hidden: true }, {}));
    assert.match(tree, /notes\.txt/u);
    assert.doesNotMatch(tree, /\.env\b/u, '被遮蔽的条目不得出现在 tree 里');
    assert.doesNotMatch(tree, /server\.pem|id_ed25519/u);
    assert.match(tree, /宿主边界拒绝/u, '遮蔽条目要进模型可见的排除账（否则模型以为目录里没有）');

    const search = await tools.executeTool('searchText', { pattern: 'BLOB', mode: 'literal' }, {});
    assert.doesNotMatch(search.content, /PEMDATA-BLOB|OPENSSH-BLOB/u);
    assert.ok(search.metadata.searchSkipped.deniedPaths >= 2,
      '排除账的结构化面：被遮条目数要能数出来');
  }));

// ---------------------------------------------------------------------------
// maskedPaths 条目语义（#231 扩的部分）与 jail 的两道 fail-closed
// ---------------------------------------------------------------------------

test('条目语义：名字模式按段匹配（* 不跨 /），斜杠模式按整条相对路径匹配，脏条目不炸装配', () =>
  withTempDir(async (root) => {
    fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
    fs.mkdirSync(path.join(root, '.github', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'on: push\n');
    fs.writeFileSync(path.join(root, '.github', 'nested', 'ci.yml'), 'on: push\n');
    fs.writeFileSync(path.join(root, 'plain.txt'), 'plain\n');
    fs.writeFileSync(path.join(root, 'k.pem'), 'PEM\n');

    const { tools } = stationTools(root, [
      '.github/workflows/*.yml', // 带斜杠：只匹配这一条相对路径
      '*.pem',                   // 不带斜杠：任意深度的同名段
      42, '', null, undefined,   // 脏条目：丢掉而不是让装配炸掉（遮蔽是附加闸，不该让 run 起不来）
    ]);
    assert.ok(denied(await read(tools, '.github/workflows/ci.yml')), '斜杠模式必须命中它点名的那条');
    assert.match(await read(tools, '.github/nested/ci.yml'), /1: on: push/u,
      '`*` 不跨 `/` ⇒ 同名片段不能跨目录命中（否则 `*.yml` 会挡光整个仓库的 yml）');
    assert.ok(denied(await read(tools, 'k.pem')));
    assert.match(await read(tools, 'plain.txt'), /1: plain/u, '脏条目不得顺手把普通文件也挡了');
  }));

test('symlink 两个方向都 fail-closed：改名绕不过遮蔽，别名指进密钥也照样挡', () =>
  withTempDir(async (root) => {
    seedProject(root);
    fs.writeFileSync(path.join(root, 'db-creds.txt'), 'LEAKME\n');
    fs.symlinkSync('db-creds.txt', path.join(root, '.env.bak'));   // 词法像密钥，realpath 不像
    fs.symlinkSync('.env', path.join(root, 'readme-copy.txt'));    // 词法普通，realpath 是密钥
    const { jail, tools } = stationTools(root);

    assert.ok(denied(await read(tools, '.env.bak')),
      '`.env` 指向别处时仍要挡（只比 realpath 的话，「建个软链」就能把遮蔽拆掉）');
    assert.throws(() => jail.assertReadable('.env.bak'), (error) => error instanceof JailError
      && error.code === 'path_masked',
    '上面那条过了不算证：装配层自己也比词法段，所以必须直接钉 jail 这一层的词法分支');
    assert.ok(denied(await read(tools, 'readme-copy.txt')),
      '普通名字指向 `.env` 也要挡（realpath 那一面命中）');
    assert.throws(() => jail.assertReadable('readme-copy.txt'), (error) => error instanceof JailError
      && error.code === 'path_masked', '同理，realpath 那一面也要直接钉到 jail 层');
  }));

test('遮蔽在 jail 侧与装配层各自独立生效（任一边的入参都真在干活，不是一边靠另一边兜）', () =>
  withTempDir(async (root) => {
    seedProject(root);
    const jailOnly = createStationFileTools({
      jail: createJail({ root, writable: [root], maskedPaths: STATION_MASKED_PATHS }),
      cwd: root,
    });
    const assemblyOnly = createStationFileTools({
      jail: createJail({ root, writable: [root] }),
      cwd: root,
      maskedPaths: STATION_MASKED_PATHS,
    });
    assert.ok(denied(await read(jailOnly, '.env')), '只给 jail 传 maskedPaths 时必须挡（worker 就是这么传的）');
    assert.ok(denied(await read(assemblyOnly, '.env')), '只给装配层传 maskedPaths 时同样必须挡');
    assert.match(await read(jailOnly, 'notes.txt'), /plain note/u);
  }));

test('cwd 写成目录的符号链接时：生产形态（jail + 装配层）遮蔽不许静默失效', () =>
  withTempDir(async (rootRaw) => {
    const real = fs.realpathSync(fs.mkdtempSync(path.join(rootRaw, 'real-')));
    const linked = path.join(rootRaw, 'linked');
    fs.writeFileSync(path.join(real, '.env'), 'DB_PASSWORD=via-link\n');
    fs.writeFileSync(path.join(real, 'notes.txt'), 'plain note\n');
    fs.mkdirSync(path.join(real, '.git'), { recursive: true });
    fs.writeFileSync(path.join(real, '.git', 'config'), 'url = https://u:p@gh/x\n');
    fs.symlinkSync(real, linked, 'dir');

    // 生产形态（worker 就是这么装的）：jail 的根是 realpath 过的，两种写法都被它兜住。
    const { tools } = stationTools(linked);
    assert.ok(denied(await read(tools, '.env')),
      '名字模式要同时命中「链接写法」与「真目录写法」（只按一种拼写比 ⇒ 真机上静默关掉）');
    // 前缀条目比名字模式更吃根拼写（它比整条路径），所以上面那条过了不算证。
    assert.ok(denied(await read(tools, '.git/config')), '前缀型条目同样不许在链接写法下失效');
    assert.match(await read(tools, 'notes.txt'), /plain note/u);

    // 已知边界（#228 既有，#231 不扩，写在这里是为了让它看得见而不是默掉）：只给装配层不给 jail 时，
    // 那张表按**调用方给的 root** 编 ⇒ 链接写法下前缀条目会被 realpath 到真目录、比不中。
    // 生产不受影响（上一段就是这个形态）；要消掉它得在装配层也编两张表，而生产里它不改变任何结论。
    const noJail = createStationFileTools({ cwd: linked, maskedPaths: STATION_MASKED_PATHS });
    assert.ok(denied(await read(noJail, '.env')), '名字模式不依赖 jail（它比的是段名，与根拼写无关）');
    assert.match(await read(noJail, '.git/config'), /u:p@gh/u, '前缀条目在无 jail + 链接写法下不挡：本单认定的已知边界');
  }));

/**
 * 遮蔽夹具表（与 `STATION_MASKED_PATHS` **同文件维护**：往名单里加一条，就得在这里给它添一条命得中的夹具）。
 *
 * 这张表**不是**「应当被遮的密钥清单」（那份口径在 `lib/file-tools.js` 的注记里），它只是**探针**：
 * 下面那条自检判据拿它去问「这条名单条目真的能命中东西吗」。所以两个方向都不能空：
 *   ① 表里每条都得真的落盘（否则「拿不到」可能来自 ENOENT 而不是遮蔽，红会红错地方）；
 *   ② 整份名单装上后它们确实该被挡得住（否则判据的绿是空转出来的）——这两条都在下面的用例里钉着。
 */
const MASK_FIXTURE_PATHS = Object.freeze([
  '.env',                      // `.env*` 与（假想的）`**/.env` 都该在这儿见分晓
  '.env.local',
  '.env.example',
  '.git/config',               // 前缀条目：只有这一条命中，`sub/.npmrc` 型的不算
  '.npmrc',
  'deploy/tls/server.pem',     // `*.pem` 的任意深度面
  'deploy/keys/id_ed25519',    // `id_*` 的任意深度面
]);

/** 落盘夹具（内容随便，判据只看「readFile 拿不拿得到」）；README.md 是「别把谁都挡了」的负面参照。 */
function seedMaskFixtures(root) {
  for (const rel of MASK_FIXTURE_PATHS) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), `MASK-FIXTURE ${rel}\n`);
  }
  fs.writeFileSync(path.join(root, 'README.md'), 'MASK-FIXTURE-README\n');
}

/**
 * 「每条名单条目都至少命中一个夹具」的**遍历式**检查；返回一个夹具都没命中的条目。
 *
 * 逐条**单独装配**（`maskedPaths: [entry]`）而不是整份名单一起装 ⇒ 命中必须归给这条条目本身，
 * 不许被隔壁条目顺带兜住（否则 `.env* ` 打错字也能靠 `.env*` 那条假装绿）。
 */
async function entriesMatchingNoFixture(root, entries) {
  const misses = [];
  for (const entry of entries) {
    const { tools } = stationTools(root, [entry]);
    let hit = null;
    for (const fixture of MASK_FIXTURE_PATHS) {
      if (denied(await read(tools, fixture))) { hit = fixture; break; }
    }
    if (hit === null) misses.push(entry);
  }
  return misses;
}

/**
 * 自检判据（issue #231 的 copilot 二次审计补）：名单里**任何一条**都必须在夹具表上真命中东西。
 *
 * 它防的不是「遮蔽语义写错」——那是上面那些具名用例的活——而是一种更阴的失效：**条目打错字，
 * 编得出式子、静默不挡**。审计给的两个实例：`'.env* '`（多个尾空格 ⇒ 式子里多一个字面空格，
 * 谁都匹配不上）与「两个星号 + `/.env`」那种写法（本表的 `*` 不跨 `/`、**没有 globstar** ⇒ 它只能命中
 * `sub/.env`
 * 这种带目录的写法，根目录那个 `.env` 照样漏）。两种都能安然通过「当前这几个条目各自的行为」
 * 那几条具名用例，因为具名用例钉的是「已知条目 = 已知行为」，而**新增**条目的行为没人问过。
 *
 * ⚠ **这条是遍历式的，它防不住「从名单里删掉一个条目」**：名单少了谁，剩下的照样条条命中。
 *   覆盖「删条目」的是那几条**具名**用例（`生产名单逐项命中` 逐条点名、`遮蔽集合本身` 冻结名单字面量、
 *   以及 `.git/HEAD` / `sub/.npmrc` 那些反面钉子）——别把这条当「删了也红」的万能锁用。
 *   下面「删条目不红」那条用例就是把这个限制钉住，免得后继误信它能防删。
 *
 * ⚠ 另一条限制（同样别误信）：它问的是「这条条目**到底挡不挡得住任何东西**」，不是「挡的是不是你
 *   心里想那个」。新条目只要随便能命中夹具表上一个就算过 ⇒ **加条目的同时还要往
 *   `生产名单逐项命中` 那张表里加一行具名断言**，那才是「命中了你想要的东西」的锁。
 */
test('自检判据：STATION_MASKED_PATHS 每一条都至少命中一个夹具（打错字 ⇒ 静默不挡，这里必须红）', () =>
  withTempDir(async (root) => {
    seedMaskFixtures(root);
    for (const rel of MASK_FIXTURE_PATHS) {
      assert.ok(fs.existsSync(path.join(root, rel)), `夹具没落盘：${rel}（红了会分不清是没命中还是没文件）`);
    }

    const misses = await entriesMatchingNoFixture(root, STATION_MASKED_PATHS);
    assert.deepEqual(misses, [],
      `这些名单条目在夹具表上一个路径都不命中 ⇒ 要么打错字（静默不挡），要么夹具表忘了同步：`
      + `${JSON.stringify(misses)}；夹具表 = masked-paths.test.js 的 MASK_FIXTURE_PATHS`);

    // 夹具表自己也得说得过去：它必须真的挡得住「名单此刻遮的那些」，否则上面的绿是空转出来的。
    const { tools } = stationTools(root);
    for (const rel of ['.env', '.git/config', '.npmrc', 'deploy/tls/server.pem', 'deploy/keys/id_ed25519']) {
      assert.ok(denied(await read(tools, rel)), `夹具 ${rel} 在整份名单下竟能读 ⇒ 夹具选得没代表性，本判据在空转`);
    }
    assert.match(await read(tools, 'README.md'), /1: MASK-FIXTURE-README/u, '负面参照被挡了 ⇒ 夹具表选歪了');
  }));

test('反向自证：往名单里塞一条永不命中的条目，上面那条判据必须红并点名是哪条（审计给的两个实例）', () =>
  withTempDir(async (root) => {
    seedMaskFixtures(root);

    // 这两条都是**编得过**的式子（`compileMaskedTable` 不会拒它们），也都**静默不挡**夹具表上的任何东西：
    //   `'.env* '` —— 尾空格进了式子，段名里没有空格 ⇒ 谁都匹配不上；
    //   `'**/.env'` —— 没有 globstar，`*` 不跨 `/` ⇒ 它命不中根目录那个 `.env`（夹具表里也没有 `sub/.env`）。
    const auditTypo = '.env* ';
    const noGlobstar = '**/.env';
    assert.deepEqual(await entriesMatchingNoFixture(root, [...STATION_MASKED_PATHS, auditTypo]), [auditTypo],
      '塞进带尾空格的条目却没人报红 ⇒ 本判据只会跟着名单点头，等于没加');
    assert.deepEqual(await entriesMatchingNoFixture(root, [...STATION_MASKED_PATHS, noGlobstar]), [noGlobstar],
      '把 `**` 当 globstar 用（本表不认）也必须报红');

    // 而且必须**当场**红、红得准：真装上这两条时，夹具确实照读（证明它们不是「靠别处生效」的假条目）。
    for (const typo of [auditTypo, noGlobstar]) {
      const { tools } = stationTools(root, [typo]);
      assert.match(await read(tools, '.env'), /1: MASK-FIXTURE \.env/u,
        `打错字的条目 ${JSON.stringify(typo)} 竟然把 .env 挡了 ⇒ 上面那条反向自证的前提没了`);
    }
  }));

test('这条判据的已知限制（钉住，别让后继误信它防删条目）：从名单里删一条，它不红', () =>
  withTempDir(async (root) => {
    seedMaskFixtures(root);
    const minusOne = STATION_MASKED_PATHS.filter((entry) => entry !== '.npmrc');
    assert.ok(minusOne.length === STATION_MASKED_PATHS.length - 1, '本用例假设名单可筛掉一条');
    assert.deepEqual(await entriesMatchingNoFixture(root, minusOne), [],
      '遍历式判据本该看不见「少了谁」；这里红了说明有人把它改成了双向比对（那要连注释一起改）');

    // 而删条目真正会撞红的是具名钉子：整份名单下 `.npmrc` 读得到，`生产名单逐项命中` 那条就红。
    const { tools } = stationTools(root, minusOne);
    assert.match(await read(tools, '.npmrc'), /1: MASK-FIXTURE \.npmrc/u,
      '删掉 `.npmrc` 条目后它居然还被挡 ⇒ 遮蔽另有来源，上面那条限制要重新写');
  }));

test('遮蔽集合本身：只点名那五条、冻结（worker 与测试共用同一份真相）', () => {
  assert.deepEqual([...STATION_MASKED_PATHS], ['.env*', '.git/config', '.npmrc', '*.pem', 'id_*']);
  assert.ok(Object.isFrozen(STATION_MASKED_PATHS), '名单不得被某个 import 方就地改写字面量');
  for (const entry of STATION_MASKED_PATHS) {
    assert.doesNotMatch(entry, /^~|\$\{?HOME/u,
      '遮蔽集合只针对项目目录以内：家目录那几处本来就在 jail 外，写进来是误导');
  }
});

// ---------------------------------------------------------------------------
// 接线锁（#231 的病根本体：能力一直在，装配点从没传）
// ---------------------------------------------------------------------------

test('接线锁：worker.js 的 createJail / createStationFileTools 两处都传 maskedPaths，且名单不抄第二份', () => {
  const src = fs.readFileSync(path.join(RUNNER_DIR, 'worker.js'), 'utf8');
  /** 从锆点取那一处调用的完整括号体（锆点坐不住 = 装配点搬家，当场红而不是默默不再断言）。 */
  const callBody = (label, anchor) => {
    const at = src.search(anchor);
    assert.notEqual(at, -1, `worker.js 里找不到「${label}」——装配点搬家了，本判据要重新定位`);
    const open = src.indexOf('(', at);
    let depth = 0;
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === '(') depth += 1;
      else if (src[i] === ')') {
        depth -= 1;
        if (depth === 0) return src.slice(open, i + 1);
      }
    }
    assert.fail(`「${label}」的调用括号配不上，本判据的括号扫描需重写`);
    return '';
  };
  // 锆点不用裸 `createJail(`：worker.js 的注释里就有一句 `createJail({ root: cwd })`（#259 那段），
  // 拿首次出现当目标会测到注释而不是代码。
  const jailCall = callBody('const jail = createJail', /const jail = createJail\s*\(/u);
  const fileToolsCall = callBody('const fileTools = createStationFileTools', /const fileTools = createStationFileTools\s*\(/u);
  assert.match(jailCall, /maskedPaths:\s*STATION_MASKED_PATHS/u,
    `createJail 没传 maskedPaths ⇒ 遮蔽又变回 0 引用（#231 病根复发）：${jailCall}`);
  assert.match(fileToolsCall, /maskedPaths:\s*STATION_MASKED_PATHS/u,
    `createStationFileTools 没传 maskedPaths ⇒ 装配层那道遮蔽仍是死的：${fileToolsCall}`);
  assert.match(src, /import\s*\{[^}]*STATION_MASKED_PATHS[^}]*\}\s*from '\.\/lib\/file-tools\.js'/u,
    '名单要从 lib/file-tools.js import，不在 worker.js 里重抄一遍');
  assert.doesNotMatch(src, /'\.env\*'|'\*\.pem'|'id_\*'/u,
    'worker.js 里出现名单字面量 = 第二真相源（改一处漏一处）');
});
