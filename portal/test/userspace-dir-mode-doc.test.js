// 文档级断言：工作区目录权限口径 = **0770**（issue #273），且**同段**给出「setgid 不承载行为」的理由。
//
// 病根（#273 之前）：`docs/design/user-space.md` §6.2 承诺 `2770`（setgid + 组 rwx），真机稳定 `0770`
// 且**将来也不会**是 2770（mkdir 交不出 setgid；portal 缺 CAP_FSETID 时 chmod 被内核静默清位）。
// 文档承诺是这单的**唯一交付物**——没有机器判据，它必然再次漂回 2770（历史上 wp2a §④ 断言已漂过一次）。
//
// 判据形状（照 portal/test/deploy-env-defaults.test.js 的先例：读文件文本，不跑部署）：
//   1. §6.2 的**工作区目录那一行**必须写 `0770`，且不许写 `2770`（承诺语气）；
//   2. §6.2 必须同时给出理由：`CAP_FSETID` 与「setgid 不承载行为」；
//   3. 全仓 docs 里任何残留的 `2770`（`0o2770` 代码字面量除外）必须处在「说真话」的上下文里
//      （同一行出现 0770 / 遗留 / 静默 / 对照组 / 兑现成 这类限定词）——不许还有承诺语气。
//
// 变异自证：把 §6.2 那行的 `0770` 改回 `2770` ⇒ 本文件必须红（见工单 feat-261024-03-273 验收）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const USER_SPACE = path.join(REPO, 'docs/design/user-space.md');

/** 取 `### 6.2` 到下一个 `###` 之间的正文（§6.2 = 目录/文件权限与 umask 的唯一真相段）。 */
function section62(text) {
  const start = text.indexOf('### 6.2');
  assert.notEqual(start, -1, 'user-space.md 里找不到 §6.2（口径的唯一真相段被删/改名了）');
  const rest = text.slice(start + '### 6.2'.length);
  const end = rest.search(/\n#{1,3} /); // 收进 §6.2 下的 #### 子标题，止于下一个 ###/##/#
  return end === -1 ? rest : rest.slice(0, end);
}

/** 列出 §6.2 里描述「工作区目录」的那一行（`<fde>/` 及其下目录那行）。 */
function workspaceDirRow(sec) {
  const rows = sec.split('\n').filter((l) => l.startsWith('|') && l.includes('/srv/erix/users/<fde>/'));
  assert.equal(rows.length, 1,
    `§6.2 里描述工作区目录（/srv/erix/users/<fde>/ 及其下）的表格行必须恰好 1 行，实得 ${rows.length} 行`);
  return rows[0];
}

test('#273 文档口径：§6.2 工作区目录权限写 0770（无 setgid），不许再承诺 2770', () => {
  const row = workspaceDirRow(section62(fs.readFileSync(USER_SPACE, 'utf8')));
  assert.match(row, /0770/, `§6.2 工作区目录行必须写明 0770（真机实测口径）：${row}`);
  assert.doesNotMatch(row, /2770/,
    `§6.2 工作区目录行不许再出现 2770（那是历史遗留的代码意图值，落盘恒为 0770）：${row}`);
});

test('#273 文档口径：§6.2 同段给出「setgid 不承载行为」的理由（含 CAP_FSETID 根因）', () => {
  const sec = section62(fs.readFileSync(USER_SPACE, 'utf8'));
  assert.match(sec, /CAP_FSETID/,
    '§6.2 必须写明根因里的 CAP_FSETID（缺它 ⇒ chmod 被内核静默清 setgid），否则下一个人只会看到「0770」这个数字');
  assert.match(sec, /setgid[^。\n]*不承载/,
    '§6.2 必须写明「setgid 不承载任何行为」——这是「不是缺陷」的结论句，防止下一个人顺手补 CAP_FSETID 去兑现 2770');
  assert.match(sec, /umask/,
    '§6.2 必须点明将来真要组协作要动的是 umask / 组成员关系（而不是 setgid），防止下一个人修错地方');
});

test('#273 文档口径：全仓 docs 里残留的 2770 必须处在「说真话」的上下文里', () => {
  const docsDir = path.join(REPO, 'docs');
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && p.endsWith('.md')) {
        const lines = fs.readFileSync(p, 'utf8').split('\n');
        lines.forEach((line, i) => {
          if (!line.includes('2770')) return;
          if (line.includes('0o2770')) return; // 代码字面量（本单明确不改）
          // 允许的上下文：同一行必须限定它（现状 0770 / 历史遗留 / 静默清位 / 对照组 / 「别兑现成 2770」）
          if (/0770|遗留|静默|对照组|兑现成/.test(line)) return;
          offenders.push(`${path.relative(REPO, p)}:${i + 1}: ${line.trim()}`);
        });
      }
    }
  };
  walk(docsDir);
  assert.deepEqual(offenders, [],
    `docs 里仍有把 2770 当承诺的地方（#273：口径是 0770，2770 只是历史遗留的代码意图值）：\n${offenders.join('\n')}`);
});
