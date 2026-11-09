import type { Router } from 'vue-router';

/**
 * 订阅「下一次导航落地」，返回落地后的 path。**零墙钟**：不等固定时长，也不轮询。
 *
 * 为什么要有它（issue #473 family B）：原先这些用例写
 * `await vi.waitFor(() => expect(router.currentRoute.value.path).toBe(X))`，
 * 而 `vi.waitFor` 的**默认超时是 1000ms**，本质是一根墙钟轮询。路由守卫里有一跳
 * `await useSiteStore().ensureSite()`（外加 `auth.ensureMe()`），CPU 被抢时 jsdom 里
 * 一次真实导航实测要 1195ms > 1000ms ⇒ 断言超时 ⇒ **假红**（探针轨迹显示 `/login -> /`
 * 确实正常发生，只是晚于 1000ms）。把 waitFor 的 timeout 调大只是换一个墙钟预算，
 * 判据依然是「机器够快就算对」，换台机器照样翻脸。
 *
 * 用法铁律：**先订阅，再触发动作，最后 await**（顺序反了会漏掉已发生的导航）。
 *
 * 失败语义（两条都必须是显式红，不许被掩盖）：
 *  - 落地到别处 ⇒ 立刻返回**实际** path，由调用方的 `expect` 给出清晰差异
 *    （`expected '/login' to be '/'`），不是一句 timeout；
 *  - 压根没有导航 ⇒ promise 不 resolve ⇒ 用例超时变红（显式红）。
 *
 * 与守卫重定向的关系（已核对 vue-router 4.6 的 `pushWithRedirect`）：守卫 `return { path }`
 * 走的是 `NAVIGATION_GUARD_REDIRECT` 分支，它 **`return pushWithRedirect(...)` 提前返回**，
 * 中间那一跳不会触发 `triggerAfterEach` ⇒ 一条重定向链只在**最终落地**时 fire 一次 afterEach。
 * 所以「resolve 第一次落地」拿到的就是最终地址，不会停在被改写的中间目标上。
 *
 * @param router 被测代码正在用的那个 router 实例（不是新建的）。
 */
export function nextRouteLanding(router: Router): Promise<string> {
  return new Promise((resolve) => {
    const off = router.afterEach((to) => {
      off();
      resolve(to.path);
    });
  });
}
