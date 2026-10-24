// /pv/<code> 预览反代闸门（#366 P2 定稿）：浏览器永远只见 portal 源，kkFileView 主机名零暴露。
//
// 语义 = 能力 URL（capability URL）：一次签发一枚不透明短码，载荷绑
//   { 用户, fde, 项目名, 相对路径, mtime（cache-buster）, 过期时刻 }。
// - A 把链接抄给 B：码里的 user ≠ B 会话 → 403，URL 抄走没用（隔离链③）；
// - 代理验码后把载荷里的 userspace 相对路径重写成 kk 的本地文件参数（kk 只认我们拼的形态，
//   路径泄露归零）；kk 生成的子资源链接（/js /css /api…）由响应 HTML 改写保持 /pv/<码> 前缀，
//   子请求继续过同一个闸门（隔离链②：每个请求都要求 portal 会话）。
// - mtime 进载荷：文件被 agent 改写 → 旧码 403 → 前端重新签发 → kk 重新转换（陈旧性由
//   cache-buster 解决）；未改写 → 码稳 → kk 缓存命中。
// - kk 只在 docker 内网可达（compose 不发宿主端口，隔离链①）；SSRF 面 = 零（不发 URL 给 kk，
//   kk 读的是自己 ro 挂载的盘，隔离链⑤顺带：上传/管理端在 kk 配置里关）。
import crypto from 'node:crypto';

/** 短码有效期（#366 §3.2）：页面活着期间子资源/轮询都来得及，过期后点击自动重签。 */
export const PREVIEW_CODE_TTL_SECONDS = 600;

/** kkFileView 在栈内的 base URL（docker 内网名；compose 不发宿主端口，只有 portal 能触达）。 */
export const KK_INTERNAL_BASE_URL = 'http://kkfileview:8012';

/**
 * 与 compose `KK_TRUST_HOST` 必须同值的能力域名（两侧各写一次，改一处不改另一处 =
 * 全部预览 403，真机踩过）：5.0.3 TrustHostFilter 对 file://（host 空）回退到 request
 * Host 再比白名单，portal 转发时固定写这个值 → 信任判定变确定事件。
 * 非真实域名，不会外连（拨号地址另由 KK_INTERNAL_BASE_URL 决定）。
 */
export const KK_TRUST_HOST = 'station-preview.internal';

/**
 * 转发给 kk 的路径白名单（kk 预览页的真实路由面；其余一律 404，缩小反代可达面）。
 * 命名路由精确匹配（非前缀：防 `onlinePreviewXss` 这种前缀命中）；静态目录才按前缀。
 */
const KK_EXACT = new Set(['onlinePreview', 'picturesPreview', 'previewOnline', 'previewFile', 'addTask', 'task', 'deleteTask', 'fileType', 'info', 'index', 'favicon.ico']);
const KK_DIRS = ['js/', 'css/', 'images/'];

/**
 * 转换产物透传（真机实证：kk 把产物挂 web 根，模板生成 `/testdocx.pdf` 形态引用；pdf 图块
 * 是 `<name>/<page>.png` 两段）：1–2 段、每段安全字符（禁点段/反斜杠/引号），尾缀限产物集。
 * 产物名由源文件名派生⇒同租户内可枚举，接受面 = 已登录 + 持有效码（匿名探测已被闸门排除）。
 */
const KK_ARTIFACT_EXT = new Set(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'mp4', 'webm', 'mp3', 'wav', 'ogg', 'txt', 'csv', 'md']);
const KK_SEG_RE = /^[\w\u0080-\uFFFF .\-]+$/;

/** 代理转发路径决策：白名单内路径才放行（含 '/'→index 归一）；返回 null = 404。 */
export function pvForwardPath(subPath) {
  const p = String(subPath ?? '').replace(/^\/+/, '');
  const effective = p === '' ? 'index' : p;
  if (KK_EXACT.has(effective) || KK_DIRS.some((d) => effective.startsWith(d))) return `/${effective}`;
  const segs = p.split('/');
  if (segs.length <= 2 && segs.every((s) => s.length > 0 && s !== '.' && s !== '..' && KK_SEG_RE.test(s))) {
    const last = segs.at(-1);
    const dot = last.lastIndexOf('.');
    if (dot > 0 && KK_ARTIFACT_EXT.has(last.slice(dot + 1).toLowerCase())) return `/${p}`;
  }
  return null;
}

/** HMAC 短码签发。payload 只放必要字段，base64url(JSON) 明文可读（无秘密）+ 签名段。 */
export function signPreviewCode(secret, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(`pv-code:${body}`).digest('base64url');
  return `${body}.${mac}`;
}

/** 验码：常数时间比签名，解出载荷；格式/签名不对 → null（调用方 401/403）。 */
export function verifyPreviewCode(secret, code) {
  if (typeof code !== 'string' || code.length > 2000) return null;
  const dot = code.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = code.slice(0, dot);
  const mac = code.slice(dot + 1);
  const expect = crypto.createHmac('sha256', secret).update(`pv-code:${body}`).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

/**
 * 签发入口（POST /api/preview-tickets，http 层已完成牢笼解析）：
 * 载荷里的 p 是 **userspace 相对路径**（<fde>/projects/<name>/<rel>），即 kk 在它 ro 挂载
 * 的同一棵宿主盘上要读的文件；mtime 秒级取整做 cache-buster（时间戳抖动不该触发重转）。
 */
export function issuePreviewCode({ secret, userId, fdeName, project, relPath, mtimeMs, ttlSeconds = PREVIEW_CODE_TTL_SECONDS }) {
  const p = `${fdeName}/projects/${project}/${relPath.split('\\').join('/')}`;
  return signPreviewCode(secret, {
    u: userId,
    p,
    m: Math.floor(mtimeMs / 1000),
    e: Math.floor(Date.now() / 1000) + ttlSeconds,
  });
}

/**
 * kk 在线预览的 url 参数：portal 把 code 里的用户空间相对路径重写成 portal 自己拥有的
 * file:// URL（base64）递给 kk —— SSRF 防线的根：用户的 URL 永远到不了 kk。
 *
 * 格式细节（kk 源码实证 + v5.0.3 真机实测）：
 * - 必须 `file://` 前缀（isValidUrl 锚定开头，`file:/path` 被拒），且**必须带命名 authority**：
 *   `file:///abs`（三斜杠）host 为空，而 5.0.3 TrustHostFilter 对空 host 一律 403（空串检查
 *   在通配符之前，`*` 也救不了；真机 403 实证）→ 拼 `file://<KK_TRUST_HOST>/<abs>`：host 段
 *   过信任白名单，TrustDirFilter 只看 getPath()（忽略 host）做 canonical 包含比对，两边都过；
 * - kk 对 canonical 路径做 local.preview.dir（KK_LOCAL_PREVIEW_DIR）前缀比对，目录外的
 *   file:// 一律 403；portal 这层已先把路径钉死在 userspace 内，双保险；
 * - 路径逐段 URI 编码（空格/中文文件名可用；kk 侧 URLDecoder 还原）。
 *
 * @param {object} payload verifyPreviewCode 的产物
 * @param {string} userspaceRoot kk 容器内的 userspace 挂载根（compose 与 portal 同路径）
 */
export function kkOnlinePreviewQuery(payload, userspaceRoot = '/srv/erix/users') {
  const root = String(userspaceRoot).replace(/\/+$/, '');
  const encodedPath = String(payload.p ?? '').split('/').map(encodeURIComponent).join('/');
  const fileUrl = `file://${KK_TRUST_HOST}${root}/${encodedPath}`;
  return `url=${encodeURIComponent(Buffer.from(fileUrl, 'utf8').toString('base64'))}`;
}

/**
 * HTML 子资源链接改写：kk 的 Thymeleaf 模板在根路径生成 /js /css /api 链接（Spring Boot
 * server.servlet.context-path 不支持通配子路径，装不进 /pv/<码>/ 前缀）。改写策略：把模板里
 * 「根引用」与「onlinePreview 入口引用」都挂到 /pv/<码>/ 下，让 kk 页面吐出去的每一条链接
 * 都自带闸门。只改 <base>/<link>/<script>/<img> 的 src/href、form action、fetch(' /url(" 形态
 * 与带引号的模板 @{...} 展开值；JS 字符串拼接不在其中（实测 kk 预览页运行期不再现拼根路径
 * XHR；若有漏网子请求，表现为未签名 401，可观测可补表）。
 * @returns {string|null} 改写后的 HTML；无改写命中返回 null（透传原 body 即可，省一次赋值）
 */
export function rewriteKkHtml(html, code) {
  const s = String(html);
  const prefix = `/pv/${code}`;
  // 只重写 kk 已知路由/静态目录的根引用（双引号与单引号两种模板形态），防误伤正文里的普通 "/x" 字样。
  const attr = new RegExp('((?:src|href|action)=)(["\'])(/(?:js|css|images|onlinePreview|picturesPreview|previewOnline|previewFile|addTask|task|deleteTask|fileType|info|index|favicon)[^"\']*)\\2', 'g');
  const call = new RegExp('\\((["\'])(/(?:js|css|images|onlinePreview|picturesPreview|previewOnline|previewFile|addTask|task|deleteTask|fileType|info|index|favicon)[^"\']*)\\1', 'g');
  const css = new RegExp('(url\\(["\']?)(/(?:js|css|images)[^"\')]*)(["\']?\\))', 'g');
  let out = s.replace(attr, (_m, k, q, u) => `${k}${q}${prefix}${u}${q}`);
  out = out.replace(call, (_m, q, u) => `(${q}${prefix}${u}${q}`);
  out = out.replace(css, (_m, k, u, t) => `${k}${prefix}${u}${t}`);
  return out === s ? null : out;
}

/**
 * 转发时给 kk 的请求头（#366，三处都是上游源码实证的「请求整形」，不是可选优化）：
 *
 * 1. **X-Base-Url = <portal 公开 origin>/pv/<码>/**。BaseUrlFilter 优先级 1 的官方多域名钩子：
 *    kk 模板里的绝对 URL（转换产物 `/xx.pdf`、pdf 图块目录等）全部基于此生成——注入自己的
 *    origin+前缀后，产物链接天然回到闸门内（浏览器可达 + 继续验码）；rewriteKkHtml 另接
 *    根相对链接（XFP 未生效时）。公开 origin 取自本站入站头（Traefik 权威覆写的 XFH/XFP），
 *    非用户自造。
 * 2. **X-Forwarded-Prefix**：Thymeleaf `@{...}` 根链接自挂前缀（配合 kk 侧
 *    SERVER_FORWARD_HEADERS_STRATEGY=native，Boot 3 属性名）；双重保险见 rewriteKkHtml。
 * 3. **host**：意图上固定为 KK_TRUST_HOST；⚠ 经 fetch 时它是 forbidden header，undici 按
 *    拨号目标重写——所以信任判定不依赖它（判定读 url 参数自己的命名 authority，见
 *    kkOnlinePreviewQuery）；若将来改用 node:http 直发，此头仍是对的兑底。
 */
export function pvForwardHeaders(req, code, publicOrigin) {
  return {
    host: KK_TRUST_HOST,
    'x-base-url': `${publicOrigin ?? 'http://localhost'}/pv/${code}/`,
    'x-forwarded-prefix': `/pv/${code}`,
    'x-forwarded-proto': 'http',
    'cookie': req.headers.cookie ?? '',
  };
}

/**
 * kk 响应头消毒（iframe sandbox + 独立内容源的纵深）：
 * - 剥掉 kk 自己的 X-Frame-Options / CSP（我们才是安全头的所有者）；
 * - Content-Security-Policy：kk 产物页禁 frame-ancestors 白名单以外的嵌套、禁 baseURI 劫持；
 *   预览内容（转换产物）里的 <script> 保留给 kk 自带 viewer（pdf.js 等）使用——渲染隔离的
 *   最后一道是 iframe sandbox（前端挂 sandbox="allow-scripts"，无 allow-same-origin：
 *   kk 产物页里跑的脚本拿不到 portal 会话 cookie，XSS 爆炸半径 = 该次预览自己）。
 */
export function pvSanitizedHeaders(res, { htmlRewritten } = {}) {
  const out = {};
  for (const [k, v] of res.headers.entries()) {
    // set-cookie 也剥：闸门只转发内容，不给 kk 对 portal 源种 cookie 的权力（会话面归 portal 独占）。
    if (['x-frame-options', 'content-security-policy', 'transfer-encoding', 'connection', 'content-length', 'content-encoding', 'set-cookie'].includes(k)) continue;
    out[k] = v;
  }
  out['x-frame-options'] = 'SAMEORIGIN';
  out['cache-control'] = 'no-store';
  if (String(out['content-type'] ?? '').includes('text/html')) {
    out['content-security-policy'] = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: data:; frame-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'self'";
  }
  void htmlRewritten;
  return out;
}
