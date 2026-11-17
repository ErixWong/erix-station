// FDE 级 `~/.erix/ports.json` ↔ DB `port_allocations` 的**逐条对账**（工单 F：wp2a 重建第 3 段）。
//
// 为什么把对账提到 lib（而不是写在 e2e 脚本里）：
//   1) 这是 wp2a 最重的一条断言（下发链路 materializer ↔ portalloc ↔ schema 0019 的三方一致性），
//      留在脚本里就只能靠真机 docker 跑才能验；提成纯函数后，`isolation-negative.mjs` 可以用
//      夹具**行为面**钉住它（把对账改成恒真 ⇒ 那里立刻红），不依赖 docker。
//   2) hostname/url 的生成口径必须与产品同源（`portal/src/projects.js` 的 buildHostname/previewUrl，
//      fde-platform §8.5），脚本里手拼字符串会得到第二份真相。
//
// 判据来源（逐条对应下方检查）：
//   · `schema:2` / `fde` / `generation` / `block{start,end}` / `allocations[{port,url,in_use}]`
//     字段形态 = `portal/src/materializer.js` renderPortsJson（**schema 2 起只载分配事实**，issue #361：
//     `scope`/`role`/`exposure`/`state`/`run_id` 这些「使用面」字段已从文件里**剃除**，
//     它们现在只存在于 DB 行上 ⇒ 本对账的清单侧不许再要求它们，DB 侧照旧验）；
//   · 一块 10 条、号池 22000–29999、按 10 对齐 = `portal/src/previewpool.js`（issue #246 交付①）；
//   · 只列活行（`state <> 'released'`）= materializer readFdeDesiredState 的同一条 WHERE。
//
// ⚠ 本函数**只报问题不抛错**：返回 `{ problems, summary }` 由调用方 `assert.deepEqual(problems, [])`
//   ——一条不匹配的 ports.json 要能在报告里逐条点名，而不是只看到第一个 assert 失败。
import {
  PREVIEW_PORT_COUNT,
  PREVIEW_PORT_POOL_START,
  PREVIEW_PORT_POOL_END,
} from '../../src/previewpool.js';
import { buildHostname, previewUrl } from '../../src/projects.js';

/** 活行状态（§8.6：开户写 allocated，首次 forward-auth 放行幂等升 active；released 不进清单）。 */
export const PREVIEW_LIVE_STATES = new Set(['allocated', 'active']);

/**
 * 逐条对账：宿主/容器读到的 ports.json vs DB port_allocations 活行。
 *
 * @param {object} opts
 * @param {any} opts.portsJson JSON.parse 后的 ports.json
 * @param {Array<{port:number|string,hostname:string,url:string,scope:string,role:string,exposure:string,state:string,run_id?:string|null}>} opts.dbRows
 *   DB 活行（`state <> 'released'`，逐列取 port/hostname/url/scope/role/exposure/state/run_id）
 * @param {string} opts.fdeName 该 FDE 名（hostname 首段的前缀 + ports.json 的 `fde` 字段）
 * @param {string} opts.baseDomain 预览伞域（hostname 后缀，与 compose 同一份 BASE_DOMAIN）
 * @param {string|null} [opts.publicBaseUrl] 公开入口（url 的 scheme/端口来源，#57 阶段2）
 * @param {number} [opts.expectedCount] 应有条数（缺省 = 一块 10 条 = PREVIEW_PORT_COUNT）
 * @returns {{problems: string[], summary: {count:number, blockStart:number|null, ports:number[], generation:any}}}
 */
export function reconcilePortsJsonWithDb({ portsJson, dbRows, fdeName, baseDomain, publicBaseUrl = null, expectedCount = PREVIEW_PORT_COUNT }) {
  const problems = [];
  const add = (message) => problems.push(message);
  const summary = { count: 0, blockStart: null, ports: [], generation: null };

  if (!portsJson || typeof portsJson !== 'object' || Array.isArray(portsJson)) {
    add(`ports.json 不是对象（读到的形态：${JSON.stringify(portsJson)?.slice(0, 120)}）`);
    return { problems, summary };
  }
  const rows = Array.isArray(dbRows) ? dbRows : null;
  if (!rows) {
    add(`DB 活行不是数组（读到的形态：${JSON.stringify(dbRows)?.slice(0, 120)}）`);
    return { problems, summary };
  }

  summary.generation = portsJson.generation;
  if (portsJson.schema !== 2) add(`ports.json.schema 期望 2（#361 只载分配事实），实际 ${JSON.stringify(portsJson.schema)}`);
  if (portsJson.fde !== fdeName) add(`ports.json.fde 期望 ${JSON.stringify(fdeName)}（= 该 FDE 名），实际 ${JSON.stringify(portsJson.fde)}`);
  if (!Number.isInteger(portsJson.generation)) {
    add(`ports.json.generation 必须是数值（materializer 的 generation 计数器），实际 ${JSON.stringify(portsJson.generation)}`);
  }

  const entries = Array.isArray(portsJson.allocations) ? portsJson.allocations : null;
  if (!entries) {
    add('ports.json.allocations 不是数组');
    return { problems, summary };
  }
  summary.count = entries.length;
  if (entries.length !== expectedCount) add(`ports.json 条数期望 ${expectedCount}（一块 ${expectedCount} 条），实际 ${entries.length}`);
  if (rows.length !== expectedCount) add(`DB 活行条数期望 ${expectedCount}（一块 ${expectedCount} 条），实际 ${rows.length}`);

  const jsonPorts = entries.map((e) => Number(e?.port));
  summary.ports = [...jsonPorts].sort((a, b) => a - b);
  // 一块几何：号池内、按 expectedCount 对齐、连续无洞无重（previewpool 的块定义）。
  for (const port of jsonPorts) {
    if (!Number.isInteger(port) || port < PREVIEW_PORT_POOL_START || port > PREVIEW_PORT_POOL_END) {
      add(`端口 ${port} 不在号池 ${PREVIEW_PORT_POOL_START}–${PREVIEW_PORT_POOL_END} 内（#246 交付①）`);
    }
  }
  const blockStart = jsonPorts.length > 0 ? Math.min(...jsonPorts) : null;
  summary.blockStart = blockStart;
  if (blockStart !== null) {
    if (blockStart % expectedCount !== 0) add(`块起点 ${blockStart} 未按 ${expectedCount} 对齐（alignedPreviewBlockStart 口径）`);
    const expectedPorts = Array.from({ length: expectedCount }, (_, i) => blockStart + i);
    const sorted = summary.ports;
    if (sorted.length === expectedCount && sorted.some((p, i) => p !== expectedPorts[i])) {
      add(`块内端口必须连续 ${expectedPorts[0]}–${expectedPorts.at(-1)}，实际 ${sorted.join(',')}`);
    }
  }

  // 清单侧只载**分配事实**（schema 2 / #361）：`port` / `url` / `in_use` 三个字段。
  // ⚠ 这里**不许**再要求 scope/role/exposure/state/run_id —— 它们已被产品剃除（那是使用面幻觉字段），
  //   对账若仍要求它们，就是判据围着旧口径转（261117 实测：main 上 wp2a 因此自 10-24 起一直红）。
  entries.forEach((e, i) => {
    if (!Number.isInteger(Number(e?.port))) add(`ports.json.allocations[${i}].port 必须是整数，实际 ${JSON.stringify(e?.port)}`);
    if (typeof e?.url !== 'string' || e.url === '') add(`ports.json.allocations[${i}].url 必须是非空串，实际 ${JSON.stringify(e?.url)}`);
    if (!(e?.in_use === null || typeof e?.in_use === 'boolean')) {
      add(`ports.json.allocations[${i}].in_use 必须是 boolean 或 null（观测缺失时为 null），实际 ${JSON.stringify(e?.in_use)}`);
    }
    for (const gone of ['scope', 'role', 'exposure', 'state', 'run_id']) {
      if (Object.prototype.hasOwnProperty.call(e ?? {}, gone)) {
        add(`ports.json.allocations[${i}] 仍带着已剃除的字段 \`${gone}\`（schema 2 只载分配事实，见 #361）`);
      }
    }
  });

  // 逐条与 DB 对账（按端口 join：ports.json 与 DB 都按 port 升序，仍显式建索引防顺序假设）。
  const dbByPort = new Map(rows.map((r) => [Number(r.port), r]));
  for (const entry of entries) {
    const port = Number(entry?.port);
    const db = dbByPort.get(port);
    if (!db) {
      add(`ports.json 里的端口 ${port} 在 DB port_allocations 活行里不存在（下发链路漏同步 / DB 已释放但清单没跟上）`);
      continue;
    }
    const hostname = buildHostname({ fdeName, port, baseDomain });
    const url = previewUrl(hostname, { publicBaseUrl });
    // 清单侧不再有 scope/role/exposure/state（schema 2 剃除）⇒ 只比 DB 侧的 hostname/url 与派生口径，
    // 再单独验 DB 行本身的不变式（FDE 级预分配 = scope 'fde'、role 'spare'、exposure 'private'、活状态、run_id 为 NULL）。
    const fields = [
      ['hostname', hostname, db.hostname],
      ['url', url, db.url],
    ];
    for (const [field, expected, actual] of fields) {
      if (String(actual) !== String(expected)) {
        add(`端口 ${port} 的 ${field}：ports.json/派生口径 = ${JSON.stringify(expected)}，DB 活行 = ${JSON.stringify(actual)}`);
      }
    }
    if (String(entry.hostname ?? hostname) !== String(hostname)) {
      add(`端口 ${port} 的 hostname：ports.json 内字段 ${JSON.stringify(entry.hostname)} 与派生口径 ${JSON.stringify(hostname)} 不一致`);
    }
    if (String(entry.url) !== String(url)) {
      add(`端口 ${port} 的 url：ports.json 内字段 ${JSON.stringify(entry.url)} 与派生口径 ${JSON.stringify(url)} 不一致（url 的 scheme/端口从公开入口 ${JSON.stringify(publicBaseUrl)} 派生，#57 阶段2）`);
    }
    // FDE 级行的不变式（迁移 0019 的 CHECK：`scope='run'` 才允许 run_id）：DB 侧也得验，
    // 不然只有清单侧干净会漏掉「库里写了 run 级行但物化时丢掉 run_id」这种形态。
    if (db.scope !== 'fde') add(`端口 ${port} 的 DB 行 scope 期望 'fde'（FDE 级预分配），实际 ${JSON.stringify(db.scope)}`);
    if (db.role !== 'spare') add(`端口 ${port} 的 DB 行 role 期望 'spare'，实际 ${JSON.stringify(db.role)}`);
    if (db.exposure !== 'private') add(`端口 ${port} 的 DB 行 exposure 期望 'private'，实际 ${JSON.stringify(db.exposure)}`);
    if (!PREVIEW_LIVE_STATES.has(db.state)) add(`端口 ${port} 的 DB 行 state 期望 allocated/active，实际 ${JSON.stringify(db.state)}`);
    if (db.run_id != null) add(`端口 ${port} 的 DB 行带了 run_id=${JSON.stringify(db.run_id)}（scope='fde' 的预分配行 run_id 恒 NULL，迁移 0019 CHECK）`);
  }
  for (const db of rows) {
    if (!jsonPorts.includes(Number(db.port))) add(`DB 活行端口 ${db.port} 没出现在 ports.json 清单里（materializer 落后于 DB）`);
  }

  return { problems, summary };
}
