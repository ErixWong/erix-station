// pg 连接池（运行时唯一依赖）。
import pg from 'pg';

const { Pool } = pg;

export function createPool(connectionString, options = {}) {
  const opts = {
    connectionString,
    max: options.max ?? 20,
  };
  if (options.ssl) opts.ssl = options.ssl;
  return new Pool(opts);
}

// ---------------------------------------------------------------------------
// issue #828 P1：账号级语言偏好 `users.locale`（迁移 0048）的读写面。
// ---------------------------------------------------------------------------

/**
 * 语言偏好写侧归一化 + 白名单（DB 不锁值域、归一化全在这，理由见 0048 头注释：
 * 值域是**策略**不是结构事实，写进 DB CHECK 会让「DB 值非法 ⇒ 回落浏览器」那条判据真机进不去）。
 *
 * 返回 `{ ok: true, value: 'zh-CN'|'en'|null }` 或 `{ ok: false }`（非法）。**不抛**：
 * 抛不抛是调用方的 HTTP/AdminError 关注点（http.js 转 400、admin.js 转 AdminError），
 * 这里只把「怎么折」这一件事定死。
 *
 * 口径：
 *   * `null` ⇒ `{ok:true, value:null}`（清掉账号级记忆 = 跟随浏览器）。
 *   * 非字符串（数字/布尔/对象/数组）⇒ `{ok:false}`（不能拿 `String(3)` 当语言）。
 *   * 空串 / 纯空白 ⇒ `{ok:true, value:null}`（「清空」的另一种写法）。
 *   * 大小写不敏感、`_` 等价 `-`：`en`/`en-US`/`en_GB` ⇒ `en`；`zh`/`zh-CN`/`zh-Hans`/`zh_CN` ⇒ `zh-CN`
 *     （本服务只有这一档中文，地区/书写体后缀一律折到它）。
 *   * 其余（`fr`、`es`、`de-DE` …）⇒ `{ok:false}`。
 * @param {unknown} value
 * @returns {{ok: true, value: 'zh-CN'|'en'|null} | {ok: false}}
 */
export function normalizeUserLocale(value) {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false };
  const t = value.trim();
  if (t === '') return { ok: true, value: null };            // 空串 = 清空
  const lt = t.toLowerCase().replace(/_/g, '-');            // zh_CN→zh-cn、en_GB→en-gb
  if (lt === 'zh' || lt.startsWith('zh-')) return { ok: true, value: 'zh-CN' };
  if (lt === 'en' || lt.startsWith('en-')) return { ok: true, value: 'en' };
  return { ok: false };
}

/**
 * 写用户表的语言偏好（本人 `PATCH /api/me/locale` 用；**不动会话、不写审计**，
 * 与管理台 `updateUser` 分家：后者会销会话 + 记台账，改自己语言不应触发那两件事）。
 * @param {{query: Function}} pool
 * @param {string} userId
 * @param {'zh-CN'|'en'|null} value 已归一化的值
 */
export async function setUserLocale(pool, userId, value) {
  const res = await pool.query(
    `UPDATE users SET locale = $2 WHERE id = $1 RETURNING locale`,
    [userId, value],
  );
  return res.rows?.[0]?.locale ?? null;
}
