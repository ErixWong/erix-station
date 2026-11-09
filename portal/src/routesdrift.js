// issue #474 S3 一期：Traefik 动态文件的**只读**漂移监控（对账，不修复）。
//
// 为什么要有它：`routes.yml` / `llm-routes.yml` / `tls.yml` 是 portal 生成的，但**盘上是共享的**——
// 有人手改一行、运维从别的身份重写、或者把文件换成 symlink（挂载/回滚脚本），Traefik 都照单全收，
// 而 portal 完全不知道边缘上跑的不是它算出来的那份。S2 的白名单挡的是「portal 自己生成的东西越界」，
// 挡不住「盘上那份不是 portal 写的」。
//
// 一期只做**监控**（工单 §2）：
//   每 60s（+ 启动一次）用**同一份生成器**重算期望态，与盘上比字节与元数据；
//   不一致 ⇒ 只写 warn + 审计，**绝不写盘**（二期才做自动修复，另开单）。
// 「同一份生成器」是重点：期望态必须由 `renderRouteFiles()`（= S2 的两道校验）与 `renderTlsConfig()`
// 产生，监控才不会与发布面各说各话。
//
// 三态与 S2 同口径（工单 §1.5）：
//   · **合法空**（零 active binding ⇒ llm-routes.yml **应当不存在**；无证书 ⇒ tls.yml 同理）——
//     盘上却有文件 ⇒ 漂移（kind=bytes，stage=unexpected-file）；
//   · **读取/生成失败**（DB 不可用、校验被拒）⇒ **跳过本轮** + warn，**绝不当作「期望空」**。
//     否则「DB 抖一下」= 「期望三份文件都不存在」= 每次抖动都误报三次漂移。
//
// 红线（工单 §3）：日志与审计**只允许**文件名、kind、时间、sha256 前 8 位、字节数、失败阶段。
// `llm-routes.yml` 正文里是 per-FDE 虚拟 key 的明文，所以这里连「期望与实际差多少字符」都不说，
// 更不说差在哪一行——diff 一旦进日志，key 就进日志了。
//
// **记账口径 = 变化才记**（主 agent 复审补的缺陷：持续漂移会每 60s 刷一条，现网 `audit_log` 总共才两千行，
// 两天就能翻倍，真安全事件会被淹）。锁存（latch）放在 `startRouteDriftMonitor` 的**闭包**里，由它持有
// 一份 `createDriftLatch()` 并作为 `state` 传给 `runDriftRound`：
//   · 同一份漂移连跑 N 轮 ⇒ 1 条 warn + 1 行审计（签名 = `kind|stage|sha_before8|sha_after8|modeActual|ownerActual`，
//     **不含正文**）；形状变了（例如 mode 又从 644 改回 600）⇒ 再加 1 行；
//   · 上一轮有、本轮干净 ⇒ 1 条 warn + 1 行 `admin.routes_drift_cleared`（下一轮仍干净 ⇒ 零新增）；
//   · 未纳管 yml 的**集合**变了才 warn（首次一份、变了再一份、消失也报一份）；
//   · `runDriftRound` **不传** `state` ⇒ 保持「单次调用语义」（每轮都报），monitor 永远传。
// 审计动作名只有两个：`admin.routes_drift_detected` / `admin.routes_drift_cleared`。
//
// 只读的结构性保证：本模块**不 import** 任何写盘件（`atomicWriteFile` / `writeFile` / `unlink` /
// `chmod` / `chown`），并有一条源码级测试守着（`portal/test/routes-drift.test.js`）。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readTlsAssets, renderTlsConfig, tlsPaths } from './tlsassets.js';
import { generateTraefikConfig, generateLlmTraefikConfig, readRouteDesiredState } from './routes.js';
import { assertRenderedRouteText } from './routebackends.js';

/** 对账周期（工单 §2：60s；**不是** env 旋钮——一期口径写死，二期再谈旋钮）。 */
export const DRIFT_INTERVAL_MS = 60_000;

/** 三份被管文件与它们的**元数据期望**（mode 与 S2 发布面逐字同口径）。 */
export const MANAGED_MODES = {
  'routes.yml': 0o644,
  'llm-routes.yml': 0o600,
  'tls.yml': 0o644,
};

/** 审计/warn 里出现的动作名（**只有两个**，便于 grep 与告警规则）。 */
export const AUDIT_DRIFT = 'admin.routes_drift_detected';
/** 上一轮有漂移、本轮干净 ⇒ 记这一条（没有它就只能看到「一堆 detected 后来没了」，看不出何时好的）。 */
export const AUDIT_DRIFT_CLEARED = 'admin.routes_drift_cleared';

/** sha256 前 8 位（**只**给前 8 位：足够区分「不是同一份」，又不会让人反查内容）。 */
export function sha8(buf) {
  if (buf == null) return null;
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);
}

/** 一行元数据（不含任何正文）。 */
function describeFinding({ file, kind, stage, expected, actual, bytes, ...meta }) {
  // `...meta` 只带元数据类 finding 的 mode_/owner_ 字段（字符串），同样不含正文。
  return {
    file,
    kind,
    stage,
    sha_before8: expected == null ? 'absent' : sha8(expected),
    sha_after8: actual == null ? 'absent' : sha8(actual),
    bytes: bytes == null ? 0 : bytes,
    ...meta,
  };
}

/**
 * 期望态：三份文件各自「应有的字节」或 `null`（= 应当不存在 = 合法空）。
 * 读取/生成失败 ⇒ 抛错（调用方**跳过本轮**，不得把「算不出来」当「应当不存在」）。
 *
 * @param {{pool: object, config: object, fsImpl?: typeof fs.promises, assertText?: Function}} args
 * @returns {Promise<{expected: Record<string, {bytes: Buffer|null, mode: number}>, failed: null}>}
 */
export async function computeDesiredDynamicFiles({ pool, config, fsImpl = fs.promises, assertText = assertRenderedRouteText }) {
  // 路由两份：走与发布完全相同的路径（readRouteDesiredState + 两个生成器 + 两道校验）。
  // 校验也一起跑：期望态本身过不了白名单时，比对没有意义（那种情况该响的是 S2 的拒绝，不是漂移）。
  const state = await readRouteDesiredState(pool, config);
  const text = generateTraefikConfig({
    portalHost: config.portalHost,
    portalInternalHosts: config.portalInternalHosts,
    portalBackendUrl: config.portalBackendUrl,
    entryPoint: config.traefikEntryPoint,
    secureEntryPoint: config.traefikSecureEntryPoint ?? null,
    allocations: state.allocations,
    sourceRanges: state.sourceRanges,
    adminHost: config.adminHost,
    adminEntryPoint: config.traefikAdminEntryPoint,
    adminIpAllowlist: config.adminIpAllowlist ?? [],
  });
  const llmText = generateLlmTraefikConfig({
    entryPoint: config.traefikEntryPoint,
    llmHost: config.llmHost,
    llmGatewayUrl: config.llmGatewayUrl,
    llmBindings: state.llmBindings,
  });
  // 期望态自己也得过第二道：它都过不了白名单时，「盘上与期望不一致」这句话就没有意义
  //（那种时候该响的是 S2 的拒绝，不是漂移）。
  assertText({
    text,
    llmText,
    config: {
      baseDomain: config.baseDomain,
      portalHost: config.portalHost,
      portalInternalHosts: config.portalInternalHosts,
      portalBackendUrl: config.portalBackendUrl,
      adminHost: config.adminHost,
      llmHost: config.llmHost,
      llmGatewayUrl: config.llmGatewayUrl,
    },
    file: config.traefikDynamicFile ?? 'routes.yml',
    llmFile: config.traefikLlmDynamicFile ?? 'llm-routes.yml',
  });
  const routeFileName = config.traefikDynamicFile ?? 'routes.yml';
  const llmFileName = config.traefikLlmDynamicFile ?? 'llm-routes.yml';
  const tlsName = path.basename(tlsPaths(config.traefikDynamicDir).target);
  // 元数据期望按**实际文件名**挂（自定义文件名时不能错挂到默认名上）；mode 仍取自发布面同一常量表。
  const modes = {
    [routeFileName]: MANAGED_MODES['routes.yml'],
    [llmFileName]: MANAGED_MODES['llm-routes.yml'],
    [tlsName]: MANAGED_MODES['tls.yml'],
  };
  const expected = {
    [routeFileName]: { bytes: Buffer.from(text, 'utf8'), mode: modes[routeFileName] },
    // 合法空：llmText === null ⇒ **应当不存在**（不是「应当是空文件」）。
    [llmFileName]: llmText === null
      ? { bytes: null, mode: modes[llmFileName] }
      : { bytes: Buffer.from(llmText, 'utf8'), mode: modes[llmFileName] },
  };

  // tls.yml：期望态由**同一份** `readTlsAssets` + `renderTlsConfig()` 给出（两文件齐且非空 ⇒ 有；
  // 否则应当不存在）。读证书失败不抛（tlsassets 自己的口径），所以这里天然是「期望不存在」。
  const tls = await readTlsAssets({ dynamicDir: config.traefikDynamicDir, fsImpl });
  expected[tlsName] = tls.ok
    ? {
      bytes: Buffer.from(renderTlsConfig({ certPath: tls.certPath, keyPath: tls.keyPath, fingerprint: tls.fingerprint }), 'utf8'),
      mode: modes[tlsName],
    }
    : { bytes: null, mode: modes[tlsName] };

  return { expected, failed: null };
}

/**
 * 单个文件的比对：字节 + mode + 属主 + 普通文件 + symlink。
 * **不写盘**（只 lstat/readFile）。
 *
 * @param {{fsImpl, file, target, expected: {bytes: Buffer|null, mode: number}, owner: {uid: number|null, gid: number|null}}} args
 * @returns {Promise<object|null>} 一条 finding（元数据）或 null（一致）
 */
export async function inspectDynamicFile({ fsImpl, file, target, expected, owner }) {
  let st = null;
  let actual = null;
  try {
    st = await fsImpl.lstat(target);
    if (st.isFile()) actual = await fsImpl.readFile(target);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }

  // 期望不存在（合法空）：盘上有东西就是漂移。
  if (expected.bytes === null) {
    if (st == null) return null;
    return describeFinding({
      file, kind: 'bytes', stage: st.isFile() ? 'unexpected-file' : 'unexpected-entry',
      expected: null, actual, bytes: actual == null ? 0 : actual.length,
    });
  }
  if (st == null) {
    return describeFinding({ file, kind: 'bytes', stage: 'missing-file', expected: expected.bytes, actual: null, bytes: 0 });
  }
  // symlink / 非普通文件：Traefik file provider 读的是这个名字指向的东西，替换成 symlink 可以把它
  // 指到任何位置（包括别的机器同步过来的一份），必须单独报。
  if (st.isSymbolicLink()) {
    return describeFinding({ file, kind: 'metadata', stage: 'symlink', expected: expected.bytes, actual: null, bytes: 0 });
  }
  if (!st.isFile()) {
    return describeFinding({ file, kind: 'metadata', stage: 'not-regular-file', expected: expected.bytes, actual: null, bytes: 0 });
  }
  // 元数据：mode / 属主。**字节相同也要报**（0600 被改成 0644 = 明文 key 变成同组/其他人可读）。
  const mode = st.mode & 0o777;
  if (mode !== expected.mode) {
    return describeFinding({
      file, kind: 'metadata', stage: 'mode', expected: expected.bytes, actual,
      bytes: actual == null ? 0 : actual.length, modeExpected: modeToString(expected.mode), modeActual: modeToString(mode),
    });
  }
  if (owner && (owner.uid != null || owner.gid != null)) {
    if ((owner.uid != null && st.uid !== owner.uid) || (owner.gid != null && st.gid !== owner.gid)) {
      return describeFinding({
        file, kind: 'metadata', stage: 'owner', expected: expected.bytes, actual,
        bytes: actual == null ? 0 : actual.length,
        ownerExpected: `${owner.uid ?? st.uid}/${owner.gid ?? st.gid}`,
        ownerActual: `${st.uid}/${st.gid}`,
      });
    }
  }
  // 最后才是字节。
  if (actual == null || !actual.equals(expected.bytes)) {
    return describeFinding({
      file, kind: 'bytes', stage: 'bytes', expected: expected.bytes, actual,
      bytes: actual == null ? 0 : actual.length,
    });
  }
  return null;
}

function modeToString(mode) {
  return mode.toString(8);
}

/**
 * 一轮对账：算期望 → 比三份 → 列未知 `*.yml`。**全程只读**。
 *
 * @param {{pool: object, config: object, log?: object, fsImpl?: typeof fs.promises,
 *          owner?: {uid: number|null, gid: number|null}, assertText?: Function}} args
 * @returns {Promise<{skipped: boolean, findings: object[], unknown: string[], failed?: string}>}
 */
export async function checkDynamicFileDrift({ pool, config, log = console, fsImpl = fs.promises, owner, assertText }) {
  const dynamicDir = config.traefikDynamicDir;
  const effectiveOwner = owner ?? (typeof process.getuid === 'function'
    ? { uid: process.getuid(), gid: process.getgid() }
    : { uid: null, gid: null });

  let desired;
  const items = [];
  try {
    desired = await computeDesiredDynamicFiles({ pool, config, fsImpl, assertText });
  } catch (err) {
    // 三态里的第三态：**跳过本轮**，绝不当「期望空」。warn 只有阶段与 code（没有正文、没有 key）。
    const text = `[routes-drift] 期望态不可用（stage=read_desired_state reason=${err.code ?? 'unknown'}）⇒ 跳过本轮对账（不视为期望空）`;
    log.warn?.(text);
    return {
      skipped: true,
      findings: [],
      unknown: [],
      failed: err.code ?? 'desired_state_unavailable',
      items: [{ kind: 'skip', signature: `skip|read_desired_state|${err.code ?? 'unknown'}`, text }],
    };
  }

  const findings = [];
  for (const [file, exp] of Object.entries(desired.expected)) {
    const finding = await inspectDynamicFile({ fsImpl, file, target: path.join(dynamicDir, file), expected: exp, owner: effectiveOwner });
    if (finding) {
      findings.push(finding);
      log.warn?.(`[routes-drift] ${formatFinding(finding)}`);
    }
  }
  // `items` 是给 `runDriftRound` 锁存用的「本轮想说的话」，带签名。**不影响本函数自己的行为**：
  // 不传 state 的调用方看到的仍是「每轮都报」。

  // 未知 `*.yml`（如 `routes-lan.yml`）：**只列出来，不删**（它归运维/别的写入者，一期不动）。
  let unknown = [];
  try {
    const names = await fsImpl.readdir(dynamicDir);
    unknown = names.filter((n) => n.endsWith('.yml') && !(n in desired.expected)).sort();
  } catch (err) {
    const text = `[routes-drift] 动态目录不可读（stage=list_dir reason=${err.code ?? 'unknown'}）`;
    log.warn?.(text);
    return {
      skipped: true,
      findings,
      unknown: [],
      failed: err.code ?? 'dynamic_dir_unreadable',
      items: [
        ...findings.map((f) => ({ kind: 'drift', file: f.file, signature: driftSignature(f), text: `[routes-drift] ${formatFinding(f)}` })),
        { kind: 'skip', signature: `skip|list_dir|${err.code ?? 'unknown'}`, text },
      ],
    };
  }
  const unknownText = unknown.length > 0
    ? `[routes-drift] 动态目录里有未纳管的 yml（不改动）：${unknown.join(', ')}`
    : null;
  if (unknownText !== null) log.warn?.(unknownText);
  return {
    skipped: false,
    findings,
    unknown,
    items: [
      ...findings.map((f) => ({ kind: 'drift', file: f.file, signature: driftSignature(f), text: `[routes-drift] ${formatFinding(f)}` })),
      ...(unknownText === null ? [] : [{ kind: 'unknown', signature: `unknown|${unknown.join(',')}`, text: unknownText }]),
    ],
  };
}

/**
 * 漂移的**签名**（锁存的键）：字段固定，**绝不含正文**（含正文就等于把虚拟 key 写进内存里的键，
 * 也等于「同一形状但内容变了」会被当成同一条）。
 */
export function driftSignature(f) {
  return [
    f.kind ?? '',
    f.stage ?? '',
    f.sha_before8 ?? '',
    f.sha_after8 ?? '',
    f.modeActual ?? '',
    f.ownerActual ?? '',
  ].join('|');
}

/**
 * 一把空的锁存（`runDriftRound` 的 `state`）。
 * 由**调用方持有**（monitor 在自己的闭包里 new 一把），所以 `checkDynamicFileDrift` 仍是纯函数。
 */
export function createDriftLatch() {
  return {
    /** @type {Map<string, {signature: string, kind: string, sha_after8: string|null}>} 上一轮每个文件的漂移形状 */
    drifts: new Map(),
    /** @type {Set<string>} 已经说过的 skip / unknown 类 notice 签名 */
    notices: new Set(),
  };
}

/** warn/审计用的单行摘要：**只有**元数据字段（工单 §3 的白名单）。 */
export function formatFinding(f) {
  const parts = [
    `[routes-drift] ${f.file}`,
    `kind=${f.kind}`,
    `stage=${f.stage}`,
    `sha_expected=${f.sha_before8}`,
    `sha_actual=${f.sha_after8}`,
    `bytes=${f.bytes}`,
  ];
  if (f.modeExpected) parts.push(`mode_expected=${f.modeExpected}`, `mode_actual=${f.modeActual}`);
  if (f.ownerExpected) parts.push(`owner_expected=${f.ownerExpected}`, `owner_actual=${f.ownerActual}`);
  return parts.join(' ');
}

/** finding ⇒ 审计 details（字段集合固定，绝不塞正文）。 */
export function driftAuditDetails(f) {
  const d = {
    file: f.file,
    kind: f.kind,
    stage: f.stage,
    sha_before8: f.sha_before8,
    sha_after8: f.sha_after8,
    bytes: f.bytes,
  };
  if (f.modeExpected) {
    d.mode_expected = f.modeExpected;
    d.mode_actual = f.modeActual;
  }
  if (f.ownerExpected) {
    d.owner_expected = f.ownerExpected;
    d.owner_actual = f.ownerActual;
  }
  return d;
}

/** best-effort 审计（失败不反串主流程）。 */
async function auditDrift(pool, details, action = AUDIT_DRIFT) {
  try {
    await pool.query(
      `INSERT INTO audit_log (actor_id, action, target, details) VALUES ($1, $2, $3, $4)`,
      [null, action, details.file, JSON.stringify(details)],
    );
  } catch {
    // 审计面不可用：本轮已经 warn 过，不重复告警。
  }
}

/** 只吃不牌的 logger：`runDriftRound` 拿着锁存自己决定哪条往外送。 */
const SILENT_LOG = { log() {}, info() {}, warn() {}, error() {} };

/**
 * 一轮对账 + 写审计（只读盘：不写、不覆盖、不删除任何动态文件）。
 *
 * `state`（可选，`createDriftLatch()` 的产物）= **记账锁存**，由**调用方持有**：
 *   · 不传 ⇒ **单次调用语义**：每轮都 warn + 都写审计（monitor 以外的调用方、以及所有现有用例走这条路）；
 *   · 传 ⇒ **只在签名变化时** warn + 审计；上一轮有、本轮干净 ⇒ 一条 `AUDIT_DRIFT_CLEARED`。
 *     持续一份漂移不再每 60s 刷一行（现网 `audit_log` 才两千行，1440 行/天会莫掉真事件）。
 * 锁存不放进 `checkDynamicFileDrift`：那个函数保持纯（同样输入同一输出，不携带跨轮记忆）。
 */
export async function runDriftRound({ pool, config, log = console, fsImpl = fs.promises, owner, assertText, state = null }) {
  if (state === null || state === undefined) {
    const out = await checkDynamicFileDrift({ pool, config, log, fsImpl, owner, assertText });
    for (const f of out.findings) {
      await auditDrift(pool, driftAuditDetails(f));
    }
    return out;
  }

  const out = await checkDynamicFileDrift({ pool, config, log: SILENT_LOG, fsImpl, owner, assertText });

  if (out.skipped) {
    // skip 轮：不写审计（与既有判据一致），notice 只在签名变化时说；
    // ⚠ **漂移锁存原样保留**：skip 不等于「干净」。否则 DB 抖一下就会把正在报警的漂移记成 recovered。
    for (const it of out.items ?? []) {
      if (state.notices.has(it.signature)) continue;
      log.warn?.(it.text);
      state.notices.add(it.signature);
    }
    return out;
  }
  // 能走到这里 = 期望态拿到了 ⇒ 之前的 skip 告警可以重新武装（下次再 skip 要再说一次）。
  for (const key of [...state.notices]) {
    if (key.startsWith('skip|')) state.notices.delete(key);
  }

  const seen = new Set();
  for (const f of out.findings) {
    const signature = driftSignature(f);
    seen.add(f.file);
    const before = state.drifts.get(f.file);
    if (!before || before.signature !== signature) {
      log.warn?.(`[routes-drift] ${formatFinding(f)}`);
      await auditDrift(pool, driftAuditDetails(f), AUDIT_DRIFT);
    }
    state.drifts.set(f.file, { signature, kind: f.kind, sha_after8: f.sha_after8 });
  }

  // 上一轮有、本轮没有 ⇒ 恢复。只说一次（下一轮仍干净 ⇒ `state.drifts` 里已经没它了，零新增）。
  for (const [file, before] of [...state.drifts]) {
    if (seen.has(file)) continue;
    state.drifts.delete(file);
    log.warn?.(`[routes-drift] ${file} 漂移已消失（上一轮 kind=${before.kind} sha_actual=${before.sha_after8}）`);
    await auditDrift(pool, {
      file,
      stage: 'recovered',
      previous: { kind: before.kind, sha_after8: before.sha_after8 },
    }, AUDIT_DRIFT_CLEARED);
  }

  // 未纳管的 yml：**集合**变了才说（首次一份、变了再一份、消失也报一份）。
  const unknownSig = `unknown|${out.unknown.join(',')}`;
  if (out.unknown.length > 0) {
    const had = [...state.notices].filter((k) => k.startsWith('unknown|') && k !== unknownSig);
    for (const key of had) state.notices.delete(key);
    if (!state.notices.has(unknownSig)) {
      log.warn?.(`[routes-drift] 动态目录里有未纳管的 yml（不改动）：${out.unknown.join(', ')}`);
      state.notices.add(unknownSig);
    }
  } else {
    const had = [...state.notices].some((k) => k.startsWith('unknown|'));
    for (const key of [...state.notices]) {
      if (key.startsWith('unknown|')) state.notices.delete(key);
    }
    if (had) log.warn?.('[routes-drift] 未纳管的 yml 已全部消失（仍不改盘）');
  }

  return out;
}

/**
 * 启动漂移监控：启动即跑一次，此后每 `DRIFT_INTERVAL_MS` 一次。
 * 与 `startRoutesLoop` 同一形状（返回 `{stop}`），由 `cli.js` 的 shutdown 停——
 * **不是**一个没人清的裸 setInterval。
 *
 * @returns {{stop: () => void, tick: () => Promise<object>}}
 */
export function startRouteDriftMonitor(pool, config, { log = console, fsImpl = fs.promises, intervalMs = DRIFT_INTERVAL_MS, owner, now } = {}) {
  let stopped = false;
  /** @type {Promise<object>|null} 正在进行的那一轮（去重靠它，不是靠「静默丢掉这一拍」）。 */
  let inflight = null;
  // 锁存在**本闭包**里：monitor 自己持有，`checkDynamicFileDrift` 仍是纯函数。
  // 不共享到模块级 ⇒ 两个 monitor（测试里常见）不会互相抹掉对方的锁存。
  const driftLatch = createDriftLatch();

  const tick = async () => {
    if (stopped) return { skipped: true, findings: [], unknown: [], failed: 'stopped' };
    // 重入时**等同一轮**（而不是静默跳过）：静默跳过会一个 warn 都不留，
    // 「启动那一拍还没跑完」就会被当成「对账无事发生」，人看了以为盘上是对的。
    if (inflight) return inflight;
    const round = (async () => {
      try {
        return await runDriftRound({ pool, config, log, fsImpl, owner, state: driftLatch });
      } catch (err) {
        // 对账面自己的意外异常也不能把循环打死：只 warn，下一轮继续。
        log.warn?.(`[routes-drift] 对账轮异常（stage=round reason=${err.code ?? 'unknown'}）`);
        return { skipped: true, findings: [], unknown: [], failed: 'round-error' };
      }
    })();
    inflight = round;
    try {
      return await round;
    } finally {
      if (inflight === round) inflight = null;
    }
  };

  // 启动一次（不等 60s：portal 重启后最可能就是这个时刻盘上被人动过）。
  void tick();
  const timer = setInterval(() => { void tick(); }, intervalMs);
  // 定时器**不许**拖住进程退出（与其余 reconciler 一致：shutdown 里 stop，但兜底 unref）。
  if (typeof timer.unref === 'function') timer.unref();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    tick,
    now: now ?? (() => Date.now()),
  };
}
