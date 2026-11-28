// @ts-check
// #932：把「`E2E_UI_SOFT=1` 该不该把一次失败降级成 skip」与「`--host-resolver-rules` 怎么拼」
// 这两件此前各脚本各写一份的事收成一份。之前同一个策略有两份实现（admin-locale 有 message
// 参数并做分类、admin-nav-cols 没有 ⇒ 不分类），同一个坐标变量有两个名字（其余脚本用
// `E2E_RESOLVE`、admin-nav-cols 独用 `E2E_HOST_MAP`）。本模块是**唯一来源**，纯函数、无副作用。
//
// 只允许降级**环境探测阶段**（`phase==='probe'`：还没碰过真浏览器/页面）；运行阶段
// （`phase==='run'`：真浏览器已开、已在导航/点击/断言）里炸出的错一律判红——若被软降级静默
// 吃掉，真回归就没了。`message` 只是给人看的上下文，不参与阶段判定。

/**
 * #878/#932：`E2E_UI_SOFT=1` 到底该不该把一次失败降级成 skip——纯函数，**只认调用点显式传来的
 * `phase`，绝不从 message 猜**。
 *
 * 只允许在**环境探测阶段**（`phase==='probe'`：口令/凭据读取、docker 可用性、playwright 容器在不在、
 * playwright 模块能不能加载、`--host-resolver-rules` 能不能生效——都是「真浏览器跑起来之前」的探测）
 * 降级。`phase==='run'`（真浏览器已经开起来、已经在导航/点击/断言）里炸出的 `net::` 一律判红：
 * 那多半是用例中段页面自身的问题，若被 `E2E_UI_SOFT=1` 降级成 skip，真回归就被静默吃掉了。
 * `soft` 为假（没点名软降级）时一律不降级——点名要跑就判红，与哨兵同口径。`message` 只是给人看的上下文，
 * 不参与阶段判定。
 *
 * （此实现自 `admin-locale-e2e.mjs` 的规范版**逐字搬来**，行为不变。）
 */
export function shouldSoftSkip({ soft = false, phase, message = '' } = {}) {
  if (!soft) return false;
  if (phase !== 'probe') return false;
  void message;
  return true;
}

/**
 * #932：把 `E2E_UI_SOFT=1` 的判定收成一份（此前每支脚本各写 `process.env.E2E_UI_SOFT === '1'`）。
 */
export function uiSoft(env = process.env) {
  return env.E2E_UI_SOFT === '1';
}

// 缺省映射：把管理台与用户面两个 host 都映到本机（与各活栈脚本现有默认值一致）。
// 用逗号分隔——chromium 的 `--host-resolver-rules` 多条规则**必须逗号分隔**，空格分隔会
// `ERR_NAME_NOT_RESOLVED`（已实测）。坐标只写形态，值即本机回环。
const DEFAULT_RESOLVE = 'admin.fde.erix.vip=127.0.0.1,station.fde.erix.vip=127.0.0.1';

/** 把 `host=ip,host=ip` 解析成 `[{host, ip}]`；没有 `=` 或 host/ip 为空的条目丢弃。 */
function parseResolveEntries(raw) {
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf('=');
      if (i < 0) return null;
      const host = pair.slice(0, i).trim();
      const ip = pair.slice(i + 1).trim();
      if (!host || !ip) return null;
      return { host, ip };
    })
    .filter(Boolean);
}

/**
 * #932：拼 `--host-resolver-rules` 串（唯一来源）。
 *
 * 取值优先级：`E2E_RESOLVE` →（没有才）`E2E_HOST_MAP`（旧名，仅兼容一个世代）→ 缺省串。
 * 若两个变量**同时存在且不同**：只用 `E2E_RESOLVE`，并在返回结构里给一条 `warning`
 * （旧名已忽略的提示）——纯函数、不写 stdout、不在模块加载时打印，由调用方决定要不要提示。
 *
 * 返回 `{ rules, entries, warning }`：
 *  - `rules`  给 chromium 的 `--host-resolver-rules` 串，形如 `MAP a 1.2.3.4,MAP b 5.6.7.8`（逗号连接）；
 *  - `entries` 解析后的 `[{host, ip}]`（供宿主 HTTP 腿按 host 找映射 IP、以及给人看的诊断复用）；
 *  - `warning` 旧名被忽略的提示串，否则 `null`。
 */
export function hostResolverRules(env = process.env) {
  const resolve = env.E2E_RESOLVE;
  const legacy = env.E2E_HOST_MAP;
  const hasResolve = resolve !== undefined && resolve !== '';
  const hasLegacy = legacy !== undefined && legacy !== '';

  let raw;
  let warning = null;
  if (hasResolve) {
    raw = resolve;
    if (hasLegacy && legacy !== resolve) {
      warning = 'E2E_HOST_MAP（旧名）已忽略：改用 E2E_RESOLVE';
    }
  } else if (hasLegacy) {
    raw = legacy;
  } else {
    raw = DEFAULT_RESOLVE;
  }

  const entries = parseResolveEntries(raw);
  const rules = entries.map((h) => `MAP ${h.host} ${h.ip}`).join(',');
  return { rules, entries, warning };
}
