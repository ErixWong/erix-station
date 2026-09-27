// 会话浏览 composable（issue #94）：SessionPickerModal 的数据层，与组件解耦便于单测。
// 语义（issue #94 修订：搜索待 #88 标题自动生成后再加回，当前为纯浏览）：
//   浏览（updated_at DESC，20/批 keyset）；条件（scope/cwd）变更 → 清空列表 + 重置游标 + 忽略旧请求
//   （请求序号 + AbortController 双保险）；失败保留旧列表 + 可重试（按失败现场的原游标/追加语义重放）；
//   total 就绪后由组件头部显示「共 N 个会话」。
// 后端 q/total 参数保留：#88 落地后加回搜索零后端成本。
import { computed, onScopeDispose, ref, watch, type Ref } from 'vue';
import { api, ApiError } from '../api';

/** 列表项（GET /api/sessions items 子集；title/cwd/active_run_id 供结果行渲染）。 */
export interface PickerSession {
  id: string;
  title?: string | null;
  cwd?: string | null;
  updated_at?: string;
  active_run_id?: string | null;
}

export interface UseSessionSearchOptions {
  /** 当前范围（modal 内 segmented 恒可改 → 传 Ref）。 */
  scope: Ref<'cwd' | 'all'>;
  /** scope='cwd' 时的目录绑定（相对形式 ~/projects/<name>）。 */
  cwd: Ref<string | null>;
  limit?: number; // 默认 20（与后端默认一致；每批条数）
}

export function useSessionSearch(opts: UseSessionSearchOptions) {
  const limit = opts.limit ?? 20;

  const items = ref<PickerSession[]>([]);
  const loading = ref(false); // 首屏/条件变更后的整页加载
  const loadingMore = ref(false); // 触底/按钮追加（旧列表保留展示）
  const error = ref<string | null>(null);
  const total = ref<number | null>(null);
  const nextCursor = ref<string | null>(null);

  let reqSeq = 0; // 请求序号守卫：迟到响应不得覆盖新条件的列表
  let abort: AbortController | null = null; // 条件变更即作废在途请求
  // 失败现场（retry 按原游标/原追加语义重放；追加失败后游标不动，重试不会跳页）。
  let lastRequest: { cursor: string | null; append: boolean } | null = null;

  function buildUrl(cursor: string | null): string {
    const p = new URLSearchParams();
    p.set('limit', String(limit));
    p.set('total', '1'); // 头部「共 N 个会话」依赖它
    if (opts.scope.value === 'cwd' && opts.cwd.value) p.set('cwd', opts.cwd.value);
    if (cursor) p.set('cursor', cursor);
    return `/api/sessions?${p.toString()}`;
  }

  async function fetchPage(cursor: string | null, append: boolean): Promise<void> {
    const mySeq = ++reqSeq;
    abort?.abort();
    const ac = new AbortController();
    abort = ac;
    lastRequest = { cursor, append };
    if (append) loadingMore.value = true;
    else loading.value = true;
    try {
      const data = await api<{ items: PickerSession[]; next_cursor: string | null; total?: number }>(
        buildUrl(cursor),
        { signal: ac.signal },
      );
      if (mySeq !== reqSeq) return; // 旧请求：丢弃（竞态防护）
      error.value = null;
      items.value = append ? [...items.value, ...data.items] : data.items;
      nextCursor.value = data.next_cursor ?? null;
      total.value = typeof data.total === 'number' ? data.total : null;
    } catch (e) {
      if (mySeq !== reqSeq) return;
      if (e instanceof DOMException && e.name === 'AbortError') return; // 被新请求取代：静默
      error.value = e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e);
      // 失败保留旧列表与游标：重试走 retry()。
    } finally {
      if (mySeq === reqSeq) {
        loading.value = false;
        loadingMore.value = false;
      }
    }
  }

  /** 条件变更：清空列表 + 重置游标/计数 + 立即重拉首屏。 */
  function reload(): void {
    items.value = [];
    total.value = null;
    nextCursor.value = null;
    error.value = null;
    void fetchPage(null, false);
  }

  watch([opts.scope, opts.cwd], reload);
  reload(); // 首屏立即拉取

  const hasMore = computed(() => nextCursor.value != null && !loading.value && !error.value);
  /** 三态之「无结果」（非加载、非失败、空列表）。 */
  const empty = computed(() => !loading.value && !error.value && items.value.length === 0);

  function loadMore(): void {
    if (loading.value || loadingMore.value || !nextCursor.value) return;
    void fetchPage(nextCursor.value, true);
  }

  function retry(): void {
    if (!lastRequest || loading.value || loadingMore.value) return;
    void fetchPage(lastRequest.cursor, lastRequest.append);
  }

  onScopeDispose(() => {
    abort?.abort(); // 组件卸载即在途请求作废
  });

  return { items, loading, loadingMore, error, total, nextCursor, hasMore, empty, loadMore, retry };
}
