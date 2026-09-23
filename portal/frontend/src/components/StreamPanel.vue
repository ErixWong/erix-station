<script setup lang="ts">
// 消息流（旧 #stream 的渲染语义平移）：addMessage 三分（user/assistant/synthetic）、
// 助手终稿 markdown（v-html，渲染器本身先转义后格式化，XSS 安全）、工具卡片、
// roundsep/syserr 分隔行、流式增量气泡。自动跟随/「↓ 最新」由父级持有（scroll 容器也在父级）。
import { useWorkbenchStore, type StreamEntry } from '../stores/workbench';

const store = useWorkbenchStore();

function entryKey(en: StreamEntry, i: number): string {
  switch (en.kind) {
    case 'msg': return 'm' + en.id;
    case 'tool': return 't' + en.callId;
    case 'delta': return 'd' + i;
    default: return 's' + i;
  }
}

function msgClass(en: Extract<StreamEntry, { kind: 'msg' }>): string {
  // 旧 div.className = `msg ${m.role}${m.synthetic ? ' synthetic' : ''}`（+ .md 仅助手终稿）
  let cls = 'msg ' + en.role;
  if (en.synthetic) cls += ' synthetic';
  if (en.html) cls += ' md';
  return cls;
}
</script>

<template>
  <!-- 空态：旧版「选择或新建会话」默认文案（平台管理员进管理台引导） -->
  <div v-if="store.entries.length === 0">
    <p v-if="store.noProject && store.isPlatformAdmin" class="muted">
      平台管理员：请到管理台创建 FDE 用户与分配资源<br><router-link to="/admin" class="underline">进入管理台</router-link>
    </p>
    <p v-else class="muted">选择或新建会话</p>
  </div>

  <template v-for="(en, i) in store.entries" :key="entryKey(en, i)">
    <!-- 消息气泡：终稿 markdown 走 v-html；其余纯文本（{{ }} 插值等价 textContent） -->
    <div v-if="en.kind === 'msg'" :class="msgClass(en)">
      <div v-if="en.html" v-html="en.html"></div>
      <template v-else>{{ en.text }}</template>
    </div>
    <!-- 流式增量气泡（旧 S.deltaBuf 的 textContent 追加） -->
    <div v-else-if="en.kind === 'delta'" class="msg assistant">{{ en.text }}</div>
    <!-- roundsep / 系统分隔行 -->
    <div v-else-if="en.kind === 'sep'" class="roundsep">{{ en.text }}</div>
    <!-- issue #42：红色系统错误行 -->
    <div v-else-if="en.kind === 'syserr'" class="syserr">{{ en.text }}</div>
    <!-- 工具卡片（状态取 es.toolCards[callId]；ok/err 左边框分级） -->
    <div
      v-else-if="en.kind === 'tool' && store.es.toolCards.get(en.callId)"
      class="my-1.5 max-w-[46rem] rounded-md border border-black/10 border-l-4 bg-black/[0.03] px-3 py-1.5 text-sm"
      :class="store.es.toolCards.get(en.callId)!.ok === true ? 'border-l-green-600'
        : store.es.toolCards.get(en.callId)!.ok === false ? 'border-l-red-600' : 'border-l-neutral-500'"
    >
      <div class="font-semibold">🔧 {{ store.es.toolCards.get(en.callId)!.name }}
        <span class="text-black/50 font-normal truncate">{{ store.es.toolCards.get(en.callId)!.dig }}</span>
      </div>
      <div class="text-black/50">{{ store.es.toolCards.get(en.callId)!.out }}</div>
    </div>
  </template>
</template>
