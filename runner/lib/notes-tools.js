// station note 工具装配（issue #46）：erix-agent 0.10.0 装配工厂形态。
// createBuiltinNotesTools 是包根公开导出（src/index.js），一次调用绑定 runId 作用域 +
// notesDir + 单一 NotesStore 实例，返回双视图（executors 位置参数 / executeTool 结构化）
// 与 lifecycle（onRunComplete=completeRun）。宿主作用域
// （runId/notesDir/notesStore）由工厂内部强制注入并覆盖任何调用方伪造的 __erix——
// 本文件零深路径 import、零手写 __erix。
// 参考：erix-llm-kit docs/host-consumer-contract.md「Tier 2 工厂用法」。
// 降级语义不变：工厂模块加载失败 → 抛错，由 worker 捕获（warn + 无 note 工具，不中断 run）。
//
// issue #392（B 片）：**会话作用域**。`scopeRef` 传 sessionId 时，notes 不再绑单个 run。
// 为什么必需：本站“一条用户消息 = 一个 run”，而 run 作用域下笔记的 scopeRef = runId
// ⇒ 下一个 run 的 `note_list` 里上一个 run 写的东西**一行都不在**（真机 195 轮 / 12 run
// 只产出 3 条笔记，且跨 run 不可见）——本站主使用形态下笔记天然无效。
// 引擎侧零改动：`scopeRef` 与 `runId` 本就是并列入参，file store 按 scopeRef 分目录
// （`src/store/notes.js:115 scopeDirectory(root, scopeRef) = <root>/run/<scopeRef>`）。
export async function createNotesTools({ runId, notesDir, scopeRef } = {}) {
  // 动态 import：加载失败要能被调用方降级处理（静态 import 失败会直接炸掉 worker 进程）。
  const { createBuiltinNotesTools } = await import('erix-agent');
  if (typeof createBuiltinNotesTools !== 'function') {
    throw new Error('erix-agent 未导出 createBuiltinNotesTools（需要 >=0.10.0）');
  }

  // 会话作用域：scopeRef 非空串 ⇒ 绑会话；缺省 ⇒ 保持旧的 run 作用域（行为逐字不变）。
  const boundScopeRef = typeof scopeRef === 'string' && scopeRef.trim() !== ''
    ? scopeRef.trim()
    : undefined;

  // notesStore 不传：工厂按 notesDir 自建单一 file store 实例，全视图共享。
  const assembler = createBuiltinNotesTools({
    // ⚠ **引擎的优先级是 `runId` 赢**（erix-agent 0.25.0 `src/tools/notes.js:628-630`：
    // `boundScopeRef = opts.runId !== undefined ? String(opts.runId) : opts.scopeRef …`）
    // ⇒ 会话作用域必须**不传 `runId`**。两个都传 = `scopeRef` 是一根没人读的旋钮
    //（#331 前例）⇒ 笔记依旧按 run 分片，而界面上看不出来。判据：notes-session-scope.test.js。
    ...(boundScopeRef === undefined
      ? { runId: runId === undefined ? undefined : String(runId) }
      : { scopeRef: boundScopeRef }),
    notesDir: notesDir === undefined ? undefined : String(notesDir),
  });
  if (!assembler || typeof assembler.executeTool !== 'function'
      || typeof assembler.lifecycle?.onRunComplete !== 'function'
      || !Array.isArray(assembler.definitions)) {
    throw new Error('createBuiltinNotesTools 返回值缺 executeTool/lifecycle.onRunComplete/definitions');
  }

  return {
    // 工具 schemas（registry/runToolLoop 注册用；definitions 与 tools 同引用，别名一并透出）。
    schemas: assembler.definitions,
    definitions: assembler.definitions,
    tools: assembler.tools,
    // ToolProvider 形态（将来接入 composite provider 聚合用）。
    provider: assembler.provider,
    listTools: assembler.listTools,
    resolveTools: assembler.resolveTools,
    // 双执行视图：executors(name, input, context) 位置参数；executeTool({id,name,input,context})
    // 结构化（runToolLoop/checkpoint-executor 调用约定，也兼容位置参数形态）。
    executors: assembler.executors,
    executeTool: assembler.executeTool,
    // 生命周期仅有 onRunComplete（completeRun）；收尾错误收集在 errors[]（不覆盖主错误）。
    lifecycle: assembler.lifecycle,
    // issue #392（B 片）：会话作用域下**不得**在 run 收尾调 `completeRun`——它按 scopeRef
    // 批量把 active 笔记改成 done（`notes.js:94 complete({scopeRef})`），而会话作用域下
    // scopeRef = sessionId ⇒ 每个 run 结束都会把**整个会话**的笔记刷成 done，下一个 run
    // 的目录/`note_list` 又空了——正好把本片的收益抵消。worker 按此标志位分支。
    completesRunNotes: boundScopeRef === undefined,
    // ADR-015 semantic 槽位：worker 已透传 runToolLoop 的 semanticStateProvider 参数
    // （宿主契约 docs/host-consumer-contract.md §Run state：折叠重建 run state 时回调）。
    semanticStateProvider: assembler.semanticStateProvider,
  };
}
