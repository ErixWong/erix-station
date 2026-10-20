// 部署面默认值 ↔ 代码默认值：不许两头各说各话（issue #114 vs #88 修订遗留的 compose 默认）。
//
// 病根（2026-10-21 决策者拍「关掉」换来的）：`portal/src/config.js` 按 **#114**（2026-10-01「run 终态不再
// 自动起名，省 token」）把 `sessionAutoTitle` 的**代码默认设成关**；而 `deploy/docker-compose.yml` 里那行
// `ERIX_SESSION_AUTO_TITLE: ${...:-1}` 出自 **#88 修订 `125eae9`（2026-09-25，那时标题生成还在 worker 侧）**，
// #114 改代码默认时没同步它 ⇒ **「默认关」在任何 compose 部署的栈上从未生效**（真机实测 portal 容器内 `=1`）。
// #322 把生成者统一成 portal 之后，compose 这一行就是全站唯一默认值 ⇒ 必须有机器判据，不能靠人记。
//
// 判据形状：不是各钉各的（那正是「两头各自都对」的失效形状），而是**双向一致性**——
// 把 compose 里插值出来的默认值喂给 `loadConfig`，结果必须等于不喂任何 env 的代码默认。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parse } from 'yaml';

import { loadConfig } from '../src/config.js';

const COMPOSE = new URL('../../deploy/docker-compose.yml', import.meta.url);

/** 取 compose 里 `${VAR:-默认}` 的默认段；写成裸值（无插值）时原样返回。 */
function interpolationDefault(value) {
  const m = /^\$\{([A-Z0-9_]+):-([^}]*)\}$/.exec(String(value));
  return m ? m[2] : String(value);
}

test('#114 默认口径：compose 里自动改名开关的默认值必须是「关」', () => {
  const doc = parse(fs.readFileSync(COMPOSE, 'utf8'));
  const env = doc.services['station-portal'].environment;
  assert.ok('ERIX_SESSION_AUTO_TITLE' in env, 'compose 里 station-portal 必须显式下发 ERIX_SESSION_AUTO_TITLE（否则运维无从开关）');

  const def = interpolationDefault(env.ERIX_SESSION_AUTO_TITLE);
  assert.equal(def, '0',
    'compose 默认必须是 0：#114 定了「默认关，标题取首条用户消息截断，改名由用户点按钮」。'
    + '历史上这里是 1（出自 #88 修订），那段时间「默认关」从未在部署面生效过');
});

test('#114 双向一致性：compose 默认喂进 loadConfig ⇒ 必须等于代码默认（两头不许各说各话）', () => {
  const doc = parse(fs.readFileSync(COMPOSE, 'utf8'));
  const def = interpolationDefault(doc.services['station-portal'].environment.ERIX_SESSION_AUTO_TITLE);

  const codeDefault = loadConfig({}).sessionAutoTitle;
  const deployedDefault = loadConfig({ ERIX_SESSION_AUTO_TITLE: def }).sessionAutoTitle;
  assert.equal(codeDefault, false, '代码默认：没配 env ⇒ 关（config.js 里 #114 那条）');
  assert.equal(deployedDefault, codeDefault,
    `compose 默认 ${JSON.stringify(def)} 喂进代码后得到 ${deployedDefault}，与代码默认 ${codeDefault} 不一致`
    + ' ⇒ 部署面与文档又分叉了（本次修复的正是这种分叉）');

  // 开关仍然可用：显式 1 ⇒ 开；其它值 ⇒ 关（与 config.js 的 `=== '1'` 判据同源）
  assert.equal(loadConfig({ ERIX_SESSION_AUTO_TITLE: '1' }).sessionAutoTitle, true, '运维显式设 1 仍应开回来');
  assert.equal(loadConfig({ ERIX_SESSION_AUTO_TITLE: 'yes' }).sessionAutoTitle, false, '非 1 值不算开（避免「写了就算开」）');
});
