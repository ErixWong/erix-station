<script setup lang="ts">
// issue #370：待发送输入队列条（composer 上方）。
//
// 为什么它是「服务端快照的投影」而不是本地列表：队列的真相在 `queued_inputs` 表（不变式 3），
// SSE 的 `queue_update` 是**全量快照**、`GET /api/sessions/:id` 的 `session.queued_messages` 是
// 补齐入口。本组件只读 store，不做任何自己的排序/去重/计数逻辑——那样多标签页天然一致。
import { useI18n } from 'vue-i18n';
import { useWorkbenchStore } from '../stores/workbench';

const { t } = useI18n();
const store = useWorkbenchStore();

// 折叠默认收起，展开后每条最多 3 行（line-clamp）。不做逐条删除：后端只有整队取回
//（pi `clear_queue` 的口径——单条删要和引擎的 pull 竞态，故只给「整队取回」这一个动作）。
import { ref } from 'vue';
const expanded = ref(false);
</script>

<template>
  <div
    v-if="store.queuedCount > 0 || store.queueBlocked"
    data-testid="queued-inputs-bar"
    class="border-t border-black/10 bg-amber-50/70 px-3 py-1.5 text-xs"
  >
    <!-- 暂停原因必须显式说：容器没起来时那句话可能几小时都发不出去，不说就是「消息丢了」 -->
    <div v-if="store.queueBlocked" class="flex items-center gap-1.5 text-amber-800">
      <span class="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
      <span>{{ t('queued.blocked.' + store.queueBlocked) }}</span>
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
        v-for="it in [...store.queuedInputs.steering, ...store.queuedInputs.follow_up]"
        :key="it.id"
        class="rounded border border-black/10 bg-white/70 px-2 py-1 text-black/70 line-clamp-3 whitespace-pre-wrap break-words"
      >{{ it.content }}</li>
    </ul>
  </div>
</template>
