<script setup lang="ts">
// issue #370：待发送输入队列条（composer 上方）。
//
// 为什么它是「服务端快照的投影」而不是本地列表：队列的真相在 `queued_inputs` 表（不变式 3），
// SSE 的 `queue_update` 是**全量快照**、`GET /api/sessions/:id` 的 `session.queued_messages` 是
// 补齐入口。本组件只读 store，不做任何自己的排序/去重/计数逻辑——那样多标签页天然一致。
import { useI18n } from 'vue-i18n';
import { useWorkbenchStore } from '../stores/workbench';

const { t, te } = useI18n();
const store = useWorkbenchStore();

// issue #816：队列条**默认展开**——收起时只有一个计数，用户看不见自己排了什么，就会以为消息丢了。
// 手动收起仍然有效（本次会话内保持收起），但**换会话复位成展开**（与 `WorkbenchView` 的
// `foldPanelOpen` 同口径：那是「下一个会话该不该沿用上一次的视图」，答案是不该）。
// 展开后的形状：前 2 条各占一行、每条正文最多 2 行；第 3 条起整行换成**编号按钮**（不缩成「+N」——
// 「+N」把一个可点的入口压成了一个数字，用户根本不知道后面是什么）。
import { computed, ref, watch } from 'vue';
const expanded = ref(true);
// 单值：「点编号只展开那一条」，再点收起、点别的切过去。多值会让 6 条全展开 = 等于没有展开。
// ⚠ **按条目 id 记，不按下标记**（#852 评审 MED）：队列是服务端快照，投递成功后那一条会从快照里
// 消失 ⇒ 下标整体前移，按下标记会让「展开的那条」静默变成另一条消息（`aria-expanded` 也跟着错）。
const expandedId = ref<string | null>(null);
// hover 编号 = 浮层看全文。浮层是**绝对定位**的，不改布局、不推动下面的内容（否则 hover 一下
// 整块界面跳一下）。`pointer-events-none` 是必须的：浮层压在按钮上方时会抢走 hover ⇒ 抖成频闪。
const hoverId = ref<string | null>(null); // 同上：hover 也按 id 记

// 编号 = 快照顺序（`[...steering, ...follow_up]`，与后端一致，前端不重排）的 1-based 下标。
// 「跨转向/排队统一编号」是刻意的：用户心里的编号就是他发送的顺序，不是服务端的分桶。
const items = computed(() => [
  ...store.queuedInputs.steering.map((it) => ({ ...it, kind: 'steer' as const })),
  ...store.queuedInputs.follow_up.map((it) => ({ ...it, kind: 'follow_up' as const })),
]);
const rows = computed(() => items.value.slice(0, 2).map((it, i) => ({ ...it, n: i + 1 })));
const numbered = computed(() => items.value.slice(2).map((it, i) => ({ ...it, n: i + 3 })));
// 展开的那一条（编号 > 2 时它不在行里，要单独把全文摆出来）。
// 按 id 找：这一条被投递掉 ⇒ 自动 null，不会去渲染「挪到同一编号上的另一条」。
const expandedItem = computed(() => numbered.value.find((it) => it.id === expandedId.value) ?? null);
const kindLabel = (kind: 'steer' | 'follow_up') =>
  t(kind === 'steer' ? 'queued.kindSteer' : 'queued.kindFollowUp');
// 换会话 = 视图复位（`sessionId` 从 null→id、id→id 都算换）
watch(() => store.sessionId, () => {
  expanded.value = true;
  expandedId.value = null;
  hoverId.value = null;
});
const toggleIndex = (it: { id: string }) => {
  expandedId.value = expandedId.value === it.id ? null : it.id;
};

// #805：`blocked` 是服务端的**机器码**（#294：服务端只发码、前端出话），拼键之前必须先验键在不在。
// vue-i18n 缺键时回落成**键名本身**，那就把 `queued.blocked.claimed_by_other` 这种裸键直接递给用户——
// 那不是「少一句翻译」，那是把内部实现当文案。未知码（新后端 + 旧前端是 additive 兼容面）宁可整行不渲染。
const blockedKey = computed(() =>
  store.queueBlocked && te(`queued.blocked.${store.queueBlocked}`)
    ? `queued.blocked.${store.queueBlocked}`
    : null,
);
</script>

<template>
  <div
    v-if="store.queuedCount > 0 || store.queueBlocked"
    data-testid="queued-inputs-bar"
    class="border-t border-black/10 bg-amber-50/70 px-3 py-1.5 text-xs"
  >
    <!-- 暂停原因必须显式说：容器没起来时那句话可能几小时都发不出去，不说就是「消息丢了」 -->
    <div v-if="blockedKey" class="flex items-center gap-1.5 text-amber-800">
      <span class="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
      <span>{{ t(blockedKey) }}</span>
    </div>
    <div class="flex items-center gap-2">
      <span class="font-medium text-black/70">
        {{ t('queued.count', { n: store.queuedCount }) }}
      </span>
      <span v-if="store.queuedInputs.steering.length" class="text-black/45">
        {{ t('queued.steerCount', { n: store.queuedInputs.steering.length }) }}
      </span>
      <span v-if="store.queuedInputs.follow_up.length" class="text-black/45">
        {{ t('queued.followUpCount', { n: store.queuedInputs.follow_up.length }) }}
      </span>
      <button
        v-if="store.queuedCount > 0"
        class="ml-auto rounded border border-black/20 px-1.5 py-0.5 hover:bg-black/5"
        @click="expanded = !expanded"
      >{{ expanded ? t('queued.collapse') : t('queued.expand') }}</button>
      <button
        v-if="store.queuedCount > 0"
        class="rounded border border-black/20 px-1.5 py-0.5 hover:bg-black/5 disabled:opacity-50"
        :disabled="store.queueSubmitting"
        :title="t('queued.recallHint')"
        @click="store.recallQueue()"
      >{{ t('queued.recall') }}</button>
    </div>
    <ul v-if="expanded" class="mt-1 space-y-1">
      <li
        v-for="it in rows"
        :key="it.id"
        data-test="queued-row"
        :data-index="it.n"
        class="rounded border border-black/10 bg-white/70 px-2 py-1 text-black/70 whitespace-pre-wrap break-words"
        :class="expandedId === it.id ? '' : 'line-clamp-2'"
      ><span class="text-black/45">{{ it.n }} {{ kindLabel(it.kind) }}：</span>{{ it.content }}</li>
      <!-- 第 3 条起：整行是编号按钮。宽度不够就换行（`flex-wrap`），**不许**缩成「+N」 -->
      <li v-if="numbered.length" data-test="queued-index-row" class="flex flex-wrap items-center gap-1 pt-0.5">
        <span v-for="it in numbered" :key="it.id" class="relative">
          <button
            data-test="queued-index"
            :data-index="it.n"
            :aria-expanded="expandedId === it.id"
            class="rounded border border-black/20 px-1.5 py-0.5 tabular-nums hover:bg-black/5"
            @click="toggleIndex(it)"
            @mouseenter="hoverId = it.id"
            @mouseleave="hoverId = null"
          >{{ it.n }}</button>
          <!-- 浮层：绝对定位 + `pointer-events-none`，移开即收；正文是**原文**，不生成任何摘要 -->
          <span
            v-if="hoverId === it.id"
            data-test="queued-hover-tip"
            class="pointer-events-none absolute bottom-full left-0 z-10 mb-1 max-w-[28rem] max-h-[40vh] overflow-auto whitespace-pre-wrap break-words rounded border border-black/10 bg-white px-2 py-1 text-black/70 shadow"
          ><span class="text-black/45">{{ it.n }} {{ kindLabel(it.kind) }}：</span>{{ it.content }}</span>
        </span>
      </li>
      <!-- 点开的这一条（编号 > 2 ⇒ 它不在上面两行里）：全文，不截断 -->
      <li
        v-if="expandedItem"
        data-test="queued-row-full"
        :data-index="expandedItem.n"
        class="rounded border border-black/10 bg-white/70 px-2 py-1 text-black/70 whitespace-pre-wrap break-words"
      ><span class="text-black/45">{{ expandedItem.n }} {{ kindLabel(expandedItem.kind) }}：</span>{{ expandedItem.content }}</li>
    </ul>
  </div>
</template>
