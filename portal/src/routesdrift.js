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

/** 审计/warn 里出现的动作名（固定两个，便于 grep 与告警规则）。 */
export const AUDIT_DRIFT = 'admin.routes_drift_detected';

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
  try {
    desired = await computeDesiredDynamicFiles({ pool, config, fsImpl, assertText });
  } catch (err) {
    // 三态里的第三态：**跳过本轮**，绝不当「期望空」。warn 只有阶段与 code（没有正文、没有 key）。
    log.warn?.(`[routes-drift] 期望态不可用（stage=read_desired_state reason=${err.code ?? 'unknown'}）⇒ 跳过本轮对账（不视为期望空）`);
    return { skipped: true, findings: [], unknown: [], failed: err.code ?? 'desired_state_unavailable' };
  }

  const findings = [];
  for (const [file, exp] of Object.entries(desired.expected)) {
    const finding = await inspectDynamicFile({ fsImpl, file, target: path.join(dynamicDir, file), expected: exp, owner: effectiveOwner });
    if (finding) {
      findings.push(finding);
      log.warn?.(`[routes-drift] ${formatFinding(finding)}`);
    }
  }

  // 未知 `*.yml`（如 `routes-lan.yml`）：**只列出来，不删**（它归运维/别的写入者，一期不动）。
  let unknown = [];
  try {
    const names = await fsImpl.readdir(dynamicDir);
    unknown = names.filter((n) => n.endsWith('.yml') && !(n in desired.expected)).sort();
  } catch (err) {
    log.warn?.(`[routes-drift] 动态目录不可读（stage=list_dir reason=${err.code ?? 'unknown'}）`);
    return { skipped: true, findings, unknown: [], failed: err.code ?? 'dynamic_dir_unreadable' };
  }
  if (unknown.length > 0) {
    log.warn?.(`[routes-drift] 动态目录里有未纳管的 yml（不改动）：${unknown.join(', ')}`);
  }
  return { skipped: false, findings, unknown };
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
async function auditDrift(pool, details) {
  try {
    await pool.query(
      `INSERT INTO audit_log (actor_id, action, target, details) VALUES ($1, $2, $3, $4)`,
      [null, AUDIT_DRIFT, details.file, JSON.stringify(details)],
    );
  } catch {
    // 审计面不可用：本轮已经 warn 过，不重复告警。
  }
}

/**
 * 一轮对账 + 写审计（只读盘：不写、不覆盖、不删除任何动态文件）。
 */
export async function runDriftRound({ pool, config, log = console, fsImpl = fs.promises, owner, assertText }) {
  const out = await checkDynamicFileDrift({ pool, config, log, fsImpl, owner, assertText });
  for (const f of out.findings) {
    await auditDrift(pool, driftAuditDetails(f));
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

  const tick = async () => {
    if (stopped) return { skipped: true, findings: [], unknown: [], failed: 'stopped' };
    // 重入时**等同一轮**（而不是静默跳过）：静默跳过会一个 warn 都不留，
    // 「启动那一拍还没跑完」就会被当成「对账无事发生」，人看了以为盘上是对的。
    if (inflight) return inflight;
    const round = (async () => {
      try {
        return await runDriftRound({ pool, config, log, fsImpl, owner });
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
