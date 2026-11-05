// #450 A2：`GET /api/site` 的客户端状态（pinia）。**只放两个 URL**（工单红线：不在前端存任何服务端秘密）。
//
// 契约见 `docs/api/portal.md` §2.12：`{ userBaseUrl, adminBaseUrl }`，公开、零秘密、两个入口都可达。
// 本 store 的职责只有一个：给 `router.ts` 的 host 闸（`lib/hostGate.ts`）提供那两个 URL，并且
// **绝不把「拿不到」变成「导航失败」**——拿不到就是 `unavailable`，host 闸据此 fail-open（不跳）。
//
// 三条口径（工单 §2 的「三条硬要求」在 store 这一侧的落点）：
//  ① **单飞**：并发导航只发一次请求（in-flight promise 复用）。router 的 `beforeEach` 会在每次导航里
//     调一次 `ensureSite()`，重定向链一次就能进好几趟——不单飞就是一次导航打 3 个 `/api/site`。
//  ② **失败缓存 30s**：失败后不永久放弃（网络恢复后要能自愈），也不每次导航都重打（离线时每个点击
//     都多一条 5xx）。30s 是「人感知不到、又不会把后端刷爆」的刻度。
//  ③ **缺字段 ⇒ 不可用**：响应少一个键 / 值不是可解析的 http(s) URL ⇒ 按不可用处理。
//     否则 host 闸会拼出 `undefined#/admin/users` 这种死地址（跳错方向比不跳更糟）。
import { defineStore } from 'pinia';
import { markRaw } from 'vue';
import { api } from '../api';

/** 端点路径（唯一真相：测试与 store 共用它）。 */
export const SITE_PATH = '/api/site';

/** 失败后多久才允许重试（毫秒）。 */
export const SITE_FAILURE_TTL_MS = 30_000;

export interface SiteInfo {
  /** 用户面（`station.<伞域>`）的对外 base URL，`scheme://host[:port]`。 */
  userBaseUrl: string;
  /** 管理台（`admin.<伞域>:9443`）的对外 base URL，`scheme://host[:port]`。 */
  adminBaseUrl: string;
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 响应体 → `SiteInfo`；形状不对（少键 / 非 URL / 非对象）一律 `null`（= 不可用）。
 * 纯函数，单测直接调（与 store 分开，好钉「缺字段」这类边界）。
 */
export function parseSiteInfo(body: unknown): SiteInfo | null {
  if (body === null || typeof body !== 'object') return null;
  const { userBaseUrl, adminBaseUrl } = body as Record<string, unknown>;
  if (!isHttpUrl(userBaseUrl) || !isHttpUrl(adminBaseUrl)) return null;
  return { userBaseUrl: userBaseUrl.trim(), adminBaseUrl: adminBaseUrl.trim() };
}

export const useSiteStore = defineStore('site', {
  state: () => ({
    /** 两个 URL；`null` = 还没拿到 / 拿不到。 */
    info: null as SiteInfo | null,
    /** 上一次取失败（host 闸据此 fail-open）。 */
    unavailable: false,
    /** 上一次失败的时刻（`Date.now()`），用来算 30s 冷却。 */
    failedAt: 0,
    /**
     * 单飞的 in-flight promise。
     *
     * ⚠ 为什么 `markRaw`：Vue 的 `reactive()` 本来就不代理 Promise（`toRawType` = `Promise` 在
     * `targetTypeMap` 里落 `INVALID` ⇒ 原样返回，实测 `reactive({ p }).p === p`），所以**不套 markRaw
     * 也不会**出现「Promise 方法被 Proxy 吃掉」那类问题。显式 `markRaw` 是为了把「这个值不是响应式
     * 数据、别给它套 computed / 深度监听」写成代码事实——它只用于单飞复用，不参与渲染。
     */
    inflight: null as Promise<SiteInfo | null> | null,
  }),
  actions: {
    /**
     * 保证「已尝试过一次」。**永不抛**（fail-open）：拿不到就返回 `null`，导航照常继续。
     * 已有值 ⇒ 直接返回（零请求）；冷却中 ⇒ 直接返回 null（零请求）。
     */
    async ensureSite(): Promise<SiteInfo | null> {
      if (this.info) return this.info;
      if (this.unavailable && Date.now() - this.failedAt < SITE_FAILURE_TTL_MS) return null;
      if (this.inflight) return this.inflight;
      const pending = markRaw(this.fetchSite());
      this.inflight = pending;
      try {
        return await pending;
      } finally {
        // 只有「还是自己那一发」时才清位：别把后来者刚建的那一发抹掉。
        if (this.inflight === pending) this.inflight = null;
      }
    },

    /** 真正发一次请求。失败/形状不对 ⇒ 落成 unavailable（不抛）。 */
    async fetchSite(): Promise<SiteInfo | null> {
      try {
        const info = parseSiteInfo(await api<unknown>(SITE_PATH));
        if (info === null) {
          this.markUnavailable();
          return null;
        }
        this.info = info;
        this.unavailable = false;
        this.failedAt = 0;
        return info;
      } catch {
        // 网络层失败 / 5xx / 401 / 403 / 超时：一律 fail-open。**不记 error 文案**：本 store 不渲染错误，
        // 而「管理台 URL 拿不到」对用户没有可执行的动作（他能做的只是刷新）。
        this.markUnavailable();
        return null;
      }
    },

    /** 落成「不可用」并开始 30s 冷却。 */
    markUnavailable() {
      this.info = null;
      this.unavailable = true;
      this.failedAt = Date.now();
    },

    /** 测试/调试用：清干净（等价于「换了一个页面会话」）。 */
    reset() {
      this.info = null;
      this.unavailable = false;
      this.failedAt = 0;
      this.inflight = null;
    },
  },
});
