// 单测：issue #596 片 A 返修 F5 —— 两根**读侧超时**旋钮的部署面三腿一致性。
//
// 为什么这条必须存在（不是「文档里写一下就行」）：
//   `deploy/docker-compose.yml` 里 `station-portal` 用的是**显式 `environment` 列表、没有 `env_file`**
//   （该文件在 `FILE_UPLOAD_MAX_BYTES` 那条注释里就写了这个行为）。⇒ 一根新旋钮只要没在那张列表里
//   登记，运维在 `deploy/.env` 里写它**完全不生效**，而且**没有任何报错**。
//   #485（`UPLOAD_SETTINGS_READ_TIMEOUT_MS`）与 #596（`PLATFORM_PROMPTS_READ_TIMEOUT_MS`）
//   两片都只在 `docs/env.md` + `deploy/.env.example` 登记了旋钮，**compose 里没写**，
//   并且当时把这件事当作「已知遗留」写进了注释（= 承认标准部署上配了是空气）。
//   本单把两行接进 compose，并用本文件把「接上了」变成机器判据 —— 同族先例：
//   #472（`FILE_UPLOAD_MAX_BYTES`，评审 major 8）、#270（IPAM 池）、#520（三根空闲退避）。
//
// 四条判据（每条点名它治哪一种红）：
//   F5-G1 两根都在 compose 的 `station-portal.environment`，且必须是 `${VAR:-数字}` 插值形态
//         （裸字面量也算红：那运维在 `.env` 里改还是无效，正是本次要修的病）
//   F5-G2 **三腿一致**：compose 的插值缺省 == 代码 `DEFAULT_READ_TIMEOUT_MS`
//         == **读取路径真正拿去用的那个毫秒数**（第三腿是真起一次读取、看它交给定时器的数字，
//         不是再读一遍常量 —— 那会漏掉「常量对但没接线」）
//   F5-G2b 旋钮是活的：喂一个不同于缺省的值 ⇒ 生效值跟着变（把读取焊死在缺省上必须红）
//   F5-G3 两根都在 `deploy/.env.example`，且那句「compose 没登记 ⇒ 配了不生效」的**假账已销**
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parse } from 'yaml';

import {
  DEFAULT_READ_TIMEOUT_MS as UPLOAD_DEFAULT_MS,
  READ_TIMEOUT_ENV_VAR as UPLOAD_KNOB,
  resolveEffectiveMaxFileBytes,
} from '../src/upload-settings.js';
import {
  DEFAULT_READ_TIMEOUT_MS as PROMPTS_DEFAULT_MS,
  READ_TIMEOUT_ENV_VAR as PROMPTS_KNOB,
  resolveEffectiveAgentsMd,
} from '../src/platform-prompts.js';

const COMPOSE = new URL('../../deploy/docker-compose.yml', import.meta.url);
const ENV_EXAMPLE = new URL('../../deploy/.env.example', import.meta.url);

/** 口径照 `deploy-env-idle-backoff.test.js` / `deploy-env-defaults.test.js`，不另造一套。 */
function interpolationDefault(value) {
  const m = /^\$\{([A-Z0-9_]+):-([^}]*)\}$/.exec(String(value));
  return m ? m[2] : String(value);
}

function composePortalEnv() {
  return parse(fs.readFileSync(COMPOSE, 'utf8')).services['station-portal'].environment;
}

const silentLog = { log() {}, warn() {}, error() {}, debug() {} };

/** 「查询发出去而**不返回**」那一档：一根永不 settle 的 pool，正是超时旋钮要治的形状。 */
function hangingPool() {
  return { query: () => new Promise(() => {}) };
}

/**
 * 真起一次读取路径，并**录下它交给真 `setTimeout` 的毫秒数**。
 *
 * 为什么这不算「再读一遍常量」：录到的是 `withReadTimeout()` 在被测模块里现算出来的那个值
 * （链路是「读 env ⇒ `readTimeoutMs()` ⇒ `withReadTimeout(promise, timeoutMs)` ⇒ `setTimeout`」），
 * 旋钮名写错、解析器换掉、或读取路径把值写死，这里都会变成另一个数或空数组。
 * 替换只在**同步段**里生效（async 函数在首个 `await` 之前同步执行 ⇒ 那一句 `setTimeout`
 * 已经在本窗口内登记完），随即还原，不去动事件循环里的其他定时器。
 */
function observeScheduledTimeout(run) {
  const real = globalThis.setTimeout;
  const scheduled = [];
  globalThis.setTimeout = (fn, ms, ...rest) => {
    scheduled.push(ms);
    return real(fn, ms, ...rest);
  };
  let promise;
  try {
    promise = run();
  } finally {
    globalThis.setTimeout = real;
  }
  return { scheduled, promise };
}

/** 两根旋钮一张表：代码侧真值一律 **import**，不在本文件里再抄一个 1500。 */
const KNOBS = [
  {
    key: UPLOAD_KNOB,
    codeDefault: UPLOAD_DEFAULT_MS,
    alt: 700,
    // 产品入口：`POST /api/files/upload` 每次上传都走这里（无缓存 ⇒ 每次现读）。
    // 超时的可观察形状 = `reason='read_timeout'` + 回落 env/默认。
    run: () => resolveEffectiveMaxFileBytes({ pool: hangingPool(), config: {}, log: silentLog }),
  },
  {
    key: PROMPTS_KNOB,
    codeDefault: PROMPTS_DEFAULT_MS,
    alt: 700,
    // 产品入口：物化 / 手工改名每次现读这一行。
    run: () => resolveEffectiveAgentsMd({ pool: hangingPool(), log: silentLog }),
  },
];

/** 跑一次读取：把 value 当作 env 递进去（`readTimeoutMs()` 是每次调用现读 process.env 的）。 */
async function readOnce({ key, value, knob }) {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = String(value);
  try {
    const { scheduled, promise } = observeScheduledTimeout(() => knob.run());
    const started = Date.now();
    const out = await promise;
    return { scheduled, out, waitedMs: Date.now() - started };
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

// ---------------------------------------------------------------------------
// F5-G1 登记 + 形态
// ---------------------------------------------------------------------------
test('#596 F5-G1 两根读超时旋钮必须登记在 compose 的 station-portal.environment（且是可覆盖的插值形态）',
  () => {
    const env = composePortalEnv();
    for (const { key } of KNOBS) {
      const raw = env?.[key];
      assert.ok(raw !== undefined,
        `deploy/docker-compose.yml 的 station-portal.environment 里没有 ${key}：`
        + 'portal 的 environment 是**显式列表、无 env_file**，没登记 ⇒ 运维在 deploy/.env 里写它'
        + '根本不生效（#472 / #520 LOW-1 同型病，#485 与 #596 当时记的是「已知遗留」）');
      const shape = new RegExp(`^\\$\\{${key}:-([0-9]+)\\}$`).exec(String(raw));
      assert.ok(shape,
        `${key} 必须写成 \`\${${key}:-<正整数>}\` 插值形态，实际是 ${JSON.stringify(raw)}：`
        + '裸字面量等于把旋钮焊死在 compose 里，运维照样改不动');
      assert.ok(Number(shape[1]) > 0, `${key} 的插值缺省必须是正整数，实际 ${shape[1]}`);
    }
  });

// ---------------------------------------------------------------------------
// F5-G2 三腿一致
// ---------------------------------------------------------------------------
test('#596 F5-G2 三腿一致：compose 插值缺省 == 代码 DEFAULT_READ_TIMEOUT_MS == 读取真正用的毫秒数',
  async () => {
    const composeEnv = composePortalEnv();
    for (const knob of KNOBS) {
      const composeDefault = Number(interpolationDefault(composeEnv[knob.key]));
      assert.ok(Number.isSafeInteger(composeDefault) && composeDefault > 0,
        `${knob.key}：compose 插值缺省不是正整数（${composeEnv[knob.key]}）`);
      assert.equal(composeDefault, knob.codeDefault,
        `${knob.key}：compose 插值缺省 ${composeDefault} ≠ 代码缺省 ${knob.codeDefault}`
        + '（#472/#270 同型病：部署面与代码各说各话）');

      // 第三腿：**把 compose 里那个值喂进真实读取路径**，看它交给定时器的数字。
      const { scheduled, out, waitedMs } = await readOnce({
        key: knob.key, value: composeDefault, knob,
      });
      assert.deepEqual(scheduled, [composeDefault],
        `${knob.key}：喂进 ${composeDefault} 之后，读取路径登记给 setTimeout 的毫秒数应当恰好是 `
        + `[${composeDefault}]，实际 ${JSON.stringify(scheduled)} ⇒ 接线断了`
        + '（空数组 = 读取路径根本没套超时；别的数字 = 它没在用部署面那个值）');
      assert.equal(out.reason, 'read_timeout',
        `${knob.key}：永不返回的 pool 必须落成 reason='read_timeout'（而不是 no_row/read_failed），`
        + `实际 ${JSON.stringify(out.reason)} ⇒ 这一腿没有打在超时那一档上`);
      // 那个数字**真的在管等待**：不等到点不许提前给答案（只钉下界，上界留给同机负载）。
      assert.ok(waitedMs >= composeDefault - 30,
        `${knob.key}：登记了 ${composeDefault}ms 却只等了 ${waitedMs}ms ⇒ 那个数字没在管事`);
    }
  });

// ---------------------------------------------------------------------------
// F5-G2b 旋钮必须是活的
// ---------------------------------------------------------------------------
test('#596 F5-G2b 旋钮是活的：喂一个不同于缺省的超时 ⇒ 读取用的毫秒数跟着变', async () => {
  // G2 只证「缺省这一档对得上」；若读取里硬写了缺省常量，G2 仍旧绿。
  for (const knob of KNOBS) {
    assert.notEqual(knob.alt, knob.codeDefault,
      `${knob.key}：alt 必须与缺省不同，否则本条证不了「旋钮是活的」`);
    const { scheduled, out, waitedMs } = await readOnce({
      key: knob.key, value: knob.alt, knob,
    });
    assert.deepEqual(scheduled, [knob.alt],
      `${knob.key}=${knob.alt} ⇒ 读取应当用 [${knob.alt}]，实际 ${JSON.stringify(scheduled)}`
      + ' ⇒ 旋钮没接到读取路径上（或被静默回落成缺省）');
    assert.equal(out.reason, 'read_timeout', `${knob.key}=${knob.alt} 仍要落在 read_timeout 那一档`);
    assert.ok(waitedMs < knob.codeDefault,
      `${knob.key}=${knob.alt} 却等了 ${waitedMs}ms（缺省 ${knob.codeDefault}）⇒ 实际生效的还是缺省`);
  }
});

// ---------------------------------------------------------------------------
// F5-G3 运维可配清单 + 销掉那句假账
// ---------------------------------------------------------------------------
test('#596 F5-G3 deploy/.env.example 登记这两根旋钮，且「compose 没登记」那条已知遗留措辞已销账', () => {
  const text = fs.readFileSync(ENV_EXAMPLE, 'utf8');
  for (const { key, codeDefault } of KNOBS) {
    const line = text.split('\n').find((l) => new RegExp(`^\\s*#?\\s*${key}\\s*=`).test(l));
    assert.ok(line, `deploy/.env.example 里没有 ${key}：运维唯一的可配清单上找不到它`);
    const value = line.split('=').slice(1).join('=').trim();
    // 示例里是**注释掉**的（= 用代码缺省），所以只钉「若写了值就必须与代码缺省一致」。
    if (value !== '') {
      assert.equal(Number(value), codeDefault,
        `${key}：.env.example 给的示例值 ${value} ≠ 代码缺省 ${codeDefault} ⇒ 抄示例就等于改了行为`);
    }
  }
  // 假账：compose 里现在真有这两行（F5-G1 已证），注释里就不许再说「没登记 ⇒ 配了不生效」。
  assert.doesNotMatch(text, /没登记这一行/,
    '.env.example 还在说「compose 没登记这一行 ⇒ 要生效得先补 compose 那一行」：'
    + 'F5 之后这两行已经在 compose 里了，留着这句就是假账（评审要求一并改掉）');
});

test.after(() => {});
