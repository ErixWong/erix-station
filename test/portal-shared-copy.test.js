/**
 * `@shared` 别名目标必须进得了 portal 镜像（issue #589 的防回归判据）。
 *
 * 事故（main 于 `04c7d83` 红，CI run 43817003603 的「构建校验：station-portal 镜像」步）：
 * `portal/shared/macro-kinds.js` 是 PR #582（issue #528 枚举单一真源）**新建的目录**，前端 7 个文件
 * 随之 `import … from '@shared/macro-kinds'`，但 `portal/Dockerfile` 的 `frontend-builder` 阶段只
 * `COPY portal/frontend/ ./` —— 而别名目标在 `portal/frontend/` 的**外面**
 * （`portal/frontend/vite.config.ts:17`：`'@shared': new URL('../shared/', import.meta.url)`）
 * ⇒ 镜像里没有那个目录 ⇒ `vite build` 报 `UNLOADABLE_DEPENDENCY: Could not load ../shared/macro-kinds`
 * ⇒ **镜像构建不出来**（不是运行时才炸，构建期就拦）。
 *
 * 为什么这条判据必须存在，而不是「修完就算」：漏拷的成因是「新增一个跨目录的构建期依赖，Dockerfile
 * 没跟上」，这类事**每次加别名目标都可能重来**，而它红的位置（CI 的镜像构建步）离成因（某个 .vue 里
 * 新加的一行 import）很远。所以判据必须同时盯住两端：
 *   ① `portal/frontend/src/**` 里每一个 `@shared/<x>` 引用，其目标在盘上必须存在（引用没写错）；
 *   ② `frontend-builder` 阶段必须有**排在 `RUN npm run build` 之前**的 COPY，把这个目标真正送到
 *      别名在镜像里解析出来的那个路径上（不是「文本里有 COPY 就算」——dst 歪一层照样构建失败）；
 *   ③ 反向自证：删掉那行 COPY、把 dst 写成 `./shared/`、把 COPY 挪到构建之后，同一个判定函数都必须
 *      报不合格（否则判据可能是恒真的安慰剂）。
 *
 * 纯静态：不跑 docker（单测不许依赖 daemon，照 `portal/test/portal-image-git.test.js` 先例）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 剥注释用**共用**的那份实现（口径见 `test/lib/js-source.mjs` 头部）：注释里也会写 `@shared/macro-kinds`
// （`stores/macro.ts:17`、`lib/macroView.ts:8` 等），拿原文匹配会把注释当引用。
import { stripComments } from './lib/js-source.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR_REL = 'portal/frontend/src';
const VITE_CONFIG_REL = 'portal/frontend/vite.config.ts';
const DOCKERFILE_REL = 'portal/Dockerfile';
const DOCKERIGNORE_REL = '.dockerignore';
const STAGE = 'frontend-builder';

const readRepo = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
/** 仓库根相对的 posix 路径（归一化 `./`、重复斜杠、`..`）。 */
const norm = (p) => path.posix.normalize(p.replace(/^\.\//, ''));
/** 再清掉尾斜杠（`path.posix.resolve` 会留着，留着就对不上镜像里的文件路径）。 */
const clean = (p) => norm(p).replace(/\/+$/, '') || '/';
/** 一个逻辑行在原文里的行号（从 1 数）。 */
function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

// ── ① 扫描前端的 `@shared` 引用，并把别名解析成盘上的真路径 ────────────────────

/**
 * 从**一份源码文本**里抽出全部 `@shared/<x>` 引用。
 * 覆盖两种形态：静态 `from '@shared/x'`（含 `export … from`）与动态 `import('@shared/x')`。
 * @param {string} text
 * @returns {Array<{spec: string, line: number}>}
 */
function extractSharedRefs(text) {
  const code = stripComments(text); // 行号与列位不变（等长空格），故 lineOf 仍指得准
  const out = [];
  const res = [
    /\bfrom\s*['"](@shared\/[^'"]+)['"]/g,
    /\bimport\s*\(\s*['"](@shared\/[^'"]+)['"]\s*\)/g,
  ];
  for (const re of res) {
    for (const m of code.matchAll(re)) out.push({ spec: m[1], line: lineOf(code, m.index) });
  }
  return out.sort((a, b) => a.line - b.line);
}

/** 递归列出 `portal/frontend/src` 下要扫的 `.ts` / `.vue`（构建期真的会参与打包的那些）。 */
function listFrontendSources(dirRel) {
  const out = [];
  for (const ent of fs.readdirSync(path.join(ROOT, dirRel), { withFileTypes: true })) {
    const rel = `${dirRel}/${ent.name}`;
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === 'dist') continue;
      out.push(...listFrontendSources(rel));
    } else if (/\.([cm]?[jt]s|vue)$/.test(ent.name)) {
      out.push(rel);
    }
  }
  return out.sort();
}

/** `@shared` 的宿主侧根（**从 vite.config.ts 里读**，不抄字面量：别名根改了要跟着动）。 */
function aliasRoot() {
  const text = readRepo(VITE_CONFIG_REL);
  const m = text.match(/['"]@shared['"]\s*:\s*new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/);
  assert.ok(m, `${VITE_CONFIG_REL}:${lineOf(text, text.search(/['"]@shared['"]/))} 找不到 '@shared' 别名的 new URL 定义：别名口径变了就同步本判据`);
  const rel = m[1]; // '../shared/'
  const hostRoot = norm(path.posix.relative(ROOT, path.posix.resolve(path.posix.dirname(VITE_CONFIG_REL), rel)));
  // 别名在镜像里的落点：`RUN npm run build` 的 WORKDIR + 同一个相对路径（vite.config.ts 就在那个 WORKDIR 里）
  return { relFromConfigDir: rel.replace(/\/$/, ''), hostRoot };
}

const EXT_CANDIDATES = ['.js', '.mjs', '.mts', '.ts', '.jsx', '.tsx', '.json'];

/**
 * `@shared/<spec>` → 仓库根相对的真路径（照 vite 的 `resolve.extensions` 试后缀）。
 * @returns {{found: string | null, tried: string[]}}
 */
function resolveSpec(aliasHostRoot, spec) {
  const tail = spec.replace(/^@shared\/+/, '');
  const base = norm(`${aliasHostRoot}/${tail}`);
  // vite 的解析顺序：先当文件（含后缀与 `resolve.extensions`），再当目录找 index.*
  const tried = [base, ...EXT_CANDIDATES.map((e) => base + e), ...EXT_CANDIDATES.map((e) => `${base}/index${e}`)];
  for (const cand of tried) {
    if (fs.existsSync(path.join(ROOT, cand)) && fs.statSync(path.join(ROOT, cand)).isFile()) {
      return { found: cand, tried };
    }
  }
  return { found: null, tried };
}

/** 全部 `@shared` 引用 + 其解析结果（断言① 与 ② 共用的输入）。 */
function collectSharedRefs() {
  const { hostRoot, relFromConfigDir } = aliasRoot();
  const refs = [];
  for (const fileRel of listFrontendSources(SRC_DIR_REL)) {
    for (const ref of extractSharedRefs(readRepo(fileRel))) {
      const { found, tried } = resolveSpec(hostRoot, ref.spec);
      refs.push({ ...ref, fileRel, hostRoot, relFromConfigDir, aliasHostRoot: hostRoot, found, tried });
    }
  }
  return refs;
}

// ── ② Dockerfile 判定（**纯函数**：喂文本就出结论，反向自证靠它） ────────────────

/** 把 Dockerfile 折成逻辑行（`\` 续行拼回去），保留**原文行号**；丢掉整行注释。 */
function logicalLines(text) {
  const raw = text.split('\n');
  const out = [];
  let buf = null;
  for (let i = 0; i < raw.length; i += 1) {
    const line = raw[i];
    const trimmed = line.trim();
    if (buf === null && (trimmed === '' || trimmed.startsWith('#'))) continue;
    buf = buf === null ? { line: i + 1, text: trimmed } : { ...buf, text: `${buf.text} ${trimmed}` };
    if (buf.text.endsWith('\\')) buf = { ...buf, text: buf.text.slice(0, -1).trimEnd() };
    else { out.push(buf); buf = null; }
  }
  return out;
}

/** `COPY` 逻辑行 → `{ srcs, dst, fromStage }`；不是 COPY 就返回 null。 */
function parseCopy(instruction) {
  const m = /^\s*COPY\b(.*)$/i.exec(instruction.text);
  if (!m) return null;
  const tokens = m[1].trim().split(/\s+/).filter(Boolean);
  const flags = tokens.filter((t) => t.startsWith('--'));
  const args = tokens.filter((t) => !t.startsWith('--'));
  return {
    line: instruction.line,
    srcs: args.slice(0, -1).map(norm),
    dst: args.length ? args[args.length - 1] : '',
    fromStage: flags.find((f) => /^--from=/i.test(f)) ?? null,
  };
}

/** dockerignore 的一条规则 → 正则（照 filepath.Match 语义：`*`/`?` 不跨目录，`**` 跨）。 */
function ruleToRegExp(pattern) {
  const segs = pattern.split('/').map((seg) => {
    if (seg === '**') return '.*';
    let re = '';
    for (const ch of seg) {
      if (ch === '*') re += '[^/]*';
      else if (ch === '?') re += '[^/]';
      else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return re;
  });
  return new RegExp(`^${segs.join('/')}$`);
}

/**
 * `.dockerignore` 会不会把这个路径挡在构建上下文外面（挡住了 ⇒ COPY 形同虚设，症状与漏拷一模一样）。
 * 语义照 docker：按顺序最后一条命中的规则定生死，`!` 是放行；**父目录被挡 = 子路径也被挡**；
 * 模式不写 `**` 时只匹配从上下文根数的同层路径（所以 `dist` 挡不住 `portal/frontend/dist`）。
 */
function dockerignored(relPath) {
  const text = readRepo(DOCKERIGNORE_REL);
  const segs = relPath.split('/');
  const targets = segs.map((_, k) => segs.slice(0, k + 1).join('/'));
  let verdict = { excluded: false, line: 0, rule: '' };
  text.split('\n').forEach((rawLine, i) => {
    const rule = rawLine.trim();
    if (rule === '' || rule.startsWith('#')) return;
    let pattern = rule;
    let negate = false;
    if (pattern.startsWith('!')) { negate = true; pattern = pattern.slice(1); }
    pattern = pattern.replace(/\/+$/, '');
    const re = ruleToRegExp(pattern);
    if (targets.some((t) => re.test(t))) verdict = { excluded: !negate, line: i + 1, rule };
  });
  return verdict;
}

/**
 * **核心判定**：给定 Dockerfile 文本，回答「镜像里能不能拿到 `@shared` 的每个目标，且在 `npm run build` 之前」。
 * @param {string} text Dockerfile 内容（可以是变异过的副本）
 * @param {Array<{fileRel: string, line: number, spec: string, srcRel: string, aliasHostRoot: string}>} required 需要的目标
 * @param {{ relFromConfigDir: string }} alias 别名相对 vite.config.ts 的路径
 * @returns {string[]} 不合格项（空数组 = 合格）
 */
function judgeDockerfile(text, required, alias) {
  const problems = [];
  const at = (n) => `${DOCKERFILE_REL}:${n}`;
  const all = logicalLines(text);

  const start = all.findIndex((l) => /^\s*FROM\b/i.test(l.text) && new RegExp(`\\bAS\\s+${STAGE}\\b`, 'i').test(l.text));
  if (start < 0) return [`${at(all[0]?.line ?? 1)} 找不到 \`FROM … AS ${STAGE}\` 阶段（阶段被改名/删掉 ⇒ 本判据失去着力点）`];
  let end = all.findIndex((l, i) => i > start && /^\s*FROM\b/i.test(l.text));
  if (end < 0) end = all.length;
  const stage = all.slice(start, end);

  // WORKDIR 逐步累计（COPY 的 dst 与构建命令的 cwd 都按它解析）
  let workdir = '/';
  const stageWorkdir = new Map();
  for (const ins of stage) {
    const w = /^\s*WORKDIR\b\s*(.+)$/i.exec(ins.text);
    if (w) {
      const p = w[1].trim();
      workdir = p.startsWith('/') ? norm(p) : norm(path.posix.join(workdir, p));
    }
    stageWorkdir.set(ins.line, workdir);
  }

  const build = stage.find((l) => /^\s*RUN\b/i.test(l.text) && /\b(npm\s+run\s+build|vite\s+build)\b/.test(l.text));
  if (!build) {
    problems.push(`${at(stage[0].line)} ${STAGE} 阶段里没有构建步（找不到 \`RUN npm run build\`）⇒ 无从判断 COPY 是否排在它之前`);
  }
  const buildLine = build?.line ?? Number.POSITIVE_INFINITY;
  const buildWorkdir = stageWorkdir.get(build?.line ?? -1) ?? workdir;
  const imageAliasRoot = clean(path.posix.resolve(buildWorkdir, alias.relFromConfigDir));

  const copies = stage.map(parseCopy).filter(Boolean);
  // COPY 的源在盘上不存在（且不是通配）= 构建期直接失败，与漏拷同症状
  for (const c of copies) {
    if (c.fromStage) continue;
    for (const s of c.srcs) {
      if (/[*?[\]]/.test(s) || s === '.') continue;
      if (!exists(s)) problems.push(`${at(c.line)} \`COPY\` 的源 \`${s}\` 在仓库里不存在（构建期直接失败）`);
    }
  }

  const describe = (r) => {
    const want = `${imageAliasRoot}/${path.posix.relative(r.aliasHostRoot, r.srcRel)}`;
    const seen = copies.map((c) => `${at(c.line)} COPY ${c.srcs.join(' ')} → ${c.dst}（${c.line < buildLine ? '构建前' : '构建后'}）`);
    const why = copies.length ? `该阶段的 COPY：\n      ${seen.join('\n      ')}` : '该阶段一条 COPY 都没有';
    return [
      `${r.fileRel}:${r.line} 的 \`${r.spec}\` 需要在镜像里存在为 \`${want}\`，但没有任何**排在构建之前**的 COPY 把它送到那儿。`,
      `    ${why}`,
      `    修法：在 \`RUN npm run build\`${buildLine === Infinity ? '' : `（${at(buildLine)}）`}之前补一条 \`COPY ${r.aliasHostRoot}/ ${path.posix.relative(buildWorkdir, imageAliasRoot)}/\``,
    ].join('\n');
  };

  const need = new Map(); // 目标在镜像里的路径 → 需要的源
  for (const r of required) need.set(`${imageAliasRoot}/${path.posix.relative(r.aliasHostRoot, r.srcRel)}`, r);

  for (const [imagePath, r] of need) {
    const hit = copies.some((c) => {
      if (c.line >= buildLine) return false; // 构建之后才拷进来 = 构建时目录还不存在
      return c.srcs.some((s) => landingOf(s, c.dst, stageWorkdir.get(c.line) ?? workdir, r.srcRel) === imagePath);
    });
    if (!hit) problems.push(describe(r));
  }

  // 顺带：这些目标不许被 .dockerignore 挡在构建上下文外面（挡住的后果与漏拷同：镜像里没这目录）
  for (const r of required) {
    const v = dockerignored(r.srcRel);
    if (v.excluded) {
      problems.push(`${DOCKERIGNORE_REL}:${v.line} 的 \`${v.rule}\` 把 ${r.srcRel} 挡在构建上下文外`
        + `（${r.fileRel}:${r.line} 还要 import 它）⇒ \`COPY\` 拷了个空，构建期照旧 \`UNLOADABLE_DEPENDENCY\``);
    }
  }
  return problems;
}

/**
 * `COPY <src> <dst>` 之后，仓库里的 `fileRel` 会落在镜像的哪个路径？落不到就 null。
 * 语义照 docker：源是**目录** ⇒ 目录内容并进 dst（保留 src 之后的子路径）；源是**文件** ⇒ 落在 dst
 * （dst 以 `/` 结尾视为目录，补上 basename）。
 */
function landingOf(srcNorm, dstRaw, workdir, fileRel) {
  const dstAbs = clean(path.posix.resolve(workdir, dstRaw));
  const abs = path.join(ROOT, srcNorm);
  let st = null;
  try { st = fs.statSync(abs); } catch { return null; }
  if (st.isDirectory()) {
    const prefix = srcNorm.endsWith('/') ? srcNorm : `${srcNorm}/`;
    return fileRel.startsWith(prefix) ? clean(path.posix.join(dstAbs, fileRel.slice(prefix.length))) : null;
  }
  if (srcNorm !== fileRel) return null;
  // 单文件源：docker 把 dst 当目录的四种写法——以 `/` 结尾、以 `/.` 结尾、就是 `.` 或 `./`
  const dstIsDir = /\/$/.test(dstRaw) || /\/\.$/.test(dstRaw) || dstRaw === '.' || dstRaw === './';
  return dstIsDir ? clean(path.posix.join(dstAbs, path.posix.basename(fileRel))) : dstAbs;
}

/** 扫描结果 → judgeDockerfile 需要的清单（丢掉解析失败的项，那些由 S1 负责报）。 */
function requiredOf(refs) {
  return refs.filter((r) => r.found)
    .map((r) => ({ fileRel: r.fileRel, line: r.line, spec: r.spec, srcRel: r.found, aliasHostRoot: r.aliasHostRoot }));
}

// ── 变异（反向自证用）：把「那一行」删掉 / 写歪 / 挪后 ──────────────────────────

/** 找出覆盖 `portal/shared/` 的那条 COPY 在原文里的行区间（含续行），并原样返回它的物理行。 */
function copyLineBlock(text, srcNeedle) {
  const lines = text.split('\n');
  const idx = lines.findIndex((l) => /^\s*COPY\b/i.test(l) && l.includes(srcNeedle));
  assert.ok(idx >= 0, `${DOCKERFILE_REL} 里找不到覆盖 \`${srcNeedle}\` 的 COPY 行（反向自证需要先有那一行）`);
  let last = idx;
  while (lines[last].trimEnd().endsWith('\\')) last += 1;
  return { first: idx, last, block: lines.slice(idx, last + 1) };
}

// ── 判据 ────────────────────────────────────────────────────────────────────

test('S1 前端每个 `@shared/<x>` 引用在盘上都解析得到（引用没写错）', () => {
  const refs = collectSharedRefs();
  // 非空自证：扫不到任何引用 = 扫描器/路径口径坏了，那 ①② 都会假绿
  assert.ok(refs.length > 0, `${SRC_DIR_REL} 下扫不到任何 \`@shared\` 引用：要么引用被删光（那别名与 Dockerfile 那行也该删），要么扫描器坏了`);
  const missing = refs.filter((r) => !r.found);
  assert.deepEqual(missing.map((r) => `${r.fileRel}:${r.line} \`${r.spec}\`（试过错开：${r.tried.join(', ')}）`), [],
    `以下 \`@shared\` 引用在盘上找不到目标（构建期会是 UNLOADABLE_DEPENDENCY）：`);
});

test('S2 别名根确实指在 `portal/frontend/` 外面（这正是必须额外 COPY 的理由）', () => {
  const { hostRoot } = aliasRoot();
  assert.equal(hostRoot, 'portal/shared', '别名根不是 portal/shared：口径变了就同步本判据与 portal/Dockerfile');
  assert.ok(!hostRoot.startsWith('portal/frontend/'),
    '`@shared` 指到了 portal/frontend/ 里面 —— 那样 `COPY portal/frontend/ ./` 就够了，本判据可退役（连同 Dockerfile 里那行）');
});

test('S3 扫描器/解析器/落地计算本身不是恒真（夹具：漏形态、指错路径、子目录目标都得算对）', () => {
  const fixture = [
    `import { A } from '@shared/macro-kinds';`,        // 静态
    `const B = await import("@shared/macro-kinds");`,   // 动态
    `export * from '@shared/macro-kinds'`,              // re-export
    `// import { C } from '@shared/macro-kinds';  ← 注释里的不算`,
  ].join('\n');
  assert.equal(extractSharedRefs(fixture).length, 3, '三种真形态必须都认到，注释里那条必须不认');
  // 解析器：指到不存在的目标要报 null（否则 S1 是恒真的）
  const bogus = resolveSpec('portal/shared', '@shared/nope-kinds');
  assert.equal(bogus.found, null, `夹具 @shared/nope-kinds 竟然解析成了 ${bogus.found}`);
  assert.ok(bogus.tried.length > 1);
  // 落地计算：目录源**必须保留子路径**（以后出现 `@shared/sub/x` 时不能算歪一层）
  assert.equal(landingOf('portal/shared/', '../shared/', '/build/portal/frontend', 'portal/shared/macro-kinds.js'),
    '/build/portal/shared/macro-kinds.js');
  assert.equal(landingOf('portal/shared/', '../shared/', '/build/portal/frontend', 'portal/shared/sub/x.js'),
    '/build/portal/shared/sub/x.js');
  assert.equal(landingOf('portal/frontend/', './', '/build/portal/frontend', 'portal/shared/macro-kinds.js'),
    null, '`COPY portal/frontend/ ./` 永远拷不到 portal/shared/ —— 算不出东西才对（#589 的根因）');
});

test('S4 `frontend-builder` 阶段必须在构建前把 `@shared` 目标拷进镜像（issue #589）', () => {
  const refs = collectSharedRefs();
  const required = requiredOf(refs);
  const problems = judgeDockerfile(readRepo(DOCKERFILE_REL), required, { relFromConfigDir: refs[0].relFromConfigDir });
  assert.deepEqual(problems, [], `portal 镜像构建不出来（issue #589 的形态）：\n  ${problems.join('\n  ')}`);
});

test('S5 反向自证：删掉/写歪/挪后那一行 COPY，同一个判定必须报不合格', () => {
  const original = readRepo(DOCKERFILE_REL);
  const refs = collectSharedRefs();
  const required = requiredOf(refs);
  const alias = { relFromConfigDir: refs[0].relFromConfigDir };
  const srcNeedle = 'portal/shared/';

  // 前提：原文必须合格（否则「变异后不合格」说明不了任何事）
  assert.deepEqual(judgeDockerfile(original, required, alias), [], '原文自己就不合格 —— 先修 S4');

  const block = copyLineBlock(original, srcNeedle);
  const mutations = {
    '删掉那一行（issue #589 的原样）': () => {
      const lines = original.split('\n');
      lines.splice(block.first, block.block.length);
      return lines.join('\n');
    },
    'dst 写成 ./shared/（歪一层，构建照样失败）': () => {
      const lines = original.split('\n');
      lines[block.first] = block.block[0].replace(/\.\.\/shared\/\s*$/, './shared/');
      assert.notEqual(lines[block.first], block.block[0], '变异没生效：那一行的 dst 没匹配上');
      return lines.join('\n');
    },
    'COPY 挪到 `RUN npm run build` 之后': () => {
      const lines = original.split('\n');
      lines.splice(block.first, block.block.length);
      const buildIdx = lines.findIndex((l) => /^\s*RUN\b/i.test(l) && /\bnpm\s+run\s+build\b/.test(l));
      assert.ok(buildIdx >= 0, '变异找不到构建步');
      lines.splice(buildIdx + 1, 0, ...block.block);
      return lines.join('\n');
    },
    'src 写成 portal/frontend/shared/（指到不存在的地方）': () => {
      const lines = original.split('\n');
      lines[block.first] = block.block[0].replace('portal/shared/', 'portal/frontend/shared/');
      assert.notEqual(lines[block.first], block.block[0], '变异没生效：src 没匹配上');
      return lines.join('\n');
    },
  };

  for (const [name, mutate] of Object.entries(mutations)) {
    const mutated = mutate();
    assert.notEqual(mutated, original, `变异「${name}」没改动文本 = 白测`);
    const problems = judgeDockerfile(mutated, required, alias);
    assert.ok(problems.length > 0,
      `变异「${name}」竟然仍被判合格 ⇒ S4 是恒真的安慰剂，拦不住 #589 那个形状`);
    // 报的错必须能指到位置（不许只说「不合格」）
    assert.match(problems.join('\n'), /portal\/(?:Dockerfile|frontend\/src)|\.dockerignore/,
      `变异「${name}」的报错没指名到文件/行：${problems.join(' | ')}`);
  }
});
