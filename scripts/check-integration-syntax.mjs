#!/usr/bin/env node
// 活栈 e2e 脚本（`portal/integration/*.mjs`）的**语法腿**（issue #803）。
//
// 为什么需要一条专门的闸：这些脚本里有几支是「脚本里套脚本」——浏览器里跑的代码写成
// `String.raw` 模板字符串，再由 `docker exec node -e` 送进容器执行。**模板里出现反引号会提前
// 闭合外层模板**（注释里写一个反引号就够），于是：
//   · #804 那一次碎成了**语法合法**的形态：外层模块照过 `node --check`、`npm test` 全绿，
//     只有真跑浏览器腿才炸（`ReferenceError: header is not defined`）；
//   · #803 这一次碎成语法错，当场就报了。
// 两次的共同点：`npm test` 的 `node --test` **不加载** `portal/integration/`（不在默认发现面里），
// 所以这些文件平时一个字都不检查，改坏了要等有人手跑活栈腿才发现。
//
// 两层判据（都零依赖、秒级）：
//   ① 外层：对每个文件跑 `node --check`。
//   ② 内层：把 `String.raw\`…\`` 的模板体抠出来单独 `node --check`。反引号提前闭合时，抠出来的
//      片段会在语句中间断掉 ⇒ 这一层能抓到 #804 那种「外层照样合法」的碎法。
// 抓不住的仍是「语义错」（选择器写错、断言恒真）——那条判据是真跑一次浏览器腿，见 `docs/testing.md` §1.2.3。
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'portal/integration');
const INNER_MARK = 'String.raw`';

/** 从 `i`（模板第一个反引号的位置）起，找到配对的收尾反引号（跳过 `\` 转义）；找不到返回 -1。 */
function closingBacktick(text, i) {
  let j = i + 1;
  while (j < text.length) {
    if (text[j] === '\\') { j += 2; continue; }
    if (text[j] === '`') return j;
    j += 1;
  }
  return -1;
}

function check(file, label) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 60_000 });
  if (r.status === 0) return null;
  const first = String(r.stderr || '').split('\n').find((l) => l.trim() !== '') || '(无 stderr)';
  return `${label} — ${first.slice(0, 200)}`;
}

function main() {
  const files = readdirSync(DIR).filter((n) => n.endsWith('.mjs')).sort().map((n) => path.join(DIR, n));
  if (files.length === 0) {
    console.log('RED  portal/integration 下一个 .mjs 都没有——目录被移走还是改名了？这条闸失去意义');
    return 1;
  }
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'check-integration-syntax-'));
  const bad = [];
  try {
    let innerCount = 0;
    for (const f of files) {
      const rel = path.relative(ROOT, f);
      const outer = check(f, rel);
      if (outer) { bad.push(outer); continue; }
      const text = readFileSync(f, 'utf8');
      let from = 0;
      let n = 0;
      for (;;) {
        const hit = text.indexOf(INNER_MARK, from);
        if (hit === -1) break;
        from = hit + INNER_MARK.length;
        const open = hit + INNER_MARK.length - 1;
        const close = closingBacktick(text, open);
        n += 1;
        innerCount += 1;
        const body = close === -1 ? text.slice(open + 1) : text.slice(open + 1, close);
        const frag = path.join(tmp, `${path.basename(f, '.mjs')}.inner${n}.mjs`);
        writeFileSync(frag, body, 'utf8');
        const inner = check(frag, `${rel}[内层脚本 #${n}${close === -1 ? '，没找到收尾反引号' : ''}]`);
        if (inner) bad.push(inner);
      }
    }
    for (const b of bad) console.log(`RED  ${b}`);
    console.log(bad.length === 0
      ? `VERDICT ok（${files.length} 个活栈 e2e 脚本 + ${innerCount} 段内嵌脚本语法全通过；语义仍要真跑一次）`
      : `VERDICT red（${bad.length} 处语法不过）`);
    return bad.length === 0 ? 0 : 1;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

process.exit(main());
