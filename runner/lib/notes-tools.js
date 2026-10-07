// station note 工具装配（issue #46）：erix-agent 0.10.0 装配工厂形态。
// createBuiltinNotesTools 是包根公开导出（src/index.js），一次调用绑定 runId 作用域 +
// notesDir + 单一 NotesStore 实例，返回双视图（executors 位置参数 / executeTool 结构化）
// 与 lifecycle（onRunComplete=completeRun）。宿主作用域
// （runId/notesDir/notesStore）由工厂内部强制注入并覆盖任何调用方伪造的 __erix——
// 本文件零深路径 import、零手写 __erix。
// 参考：erix-llm-kit docs/host-consumer-contract.md「Tier 2 工厂用法」。
// 降级语义不变：工厂模块加载失败 → 抛错，由 worker 捕获（warn + 无 note 工具，不中断 run）。
export async function createNotesTools({ runId, notesDir }) {
  // 动态 import：加载失败要能被调用方降级处理（静态 import 失败会直接炸掉 worker 进程）。
  const { createBuiltinNotesTools } = await import('erix-agent');
  if (typeof createBuiltinNotesTools !== 'function') {
    throw new Error('erix-agent 未导出 createBuiltinNotesTools（需要 >=0.10.0）');
  }

  // notesStore 不传：工厂按 notesDir 自建单一 file store 实例，全视图共享。
  const assembler = createBuiltinNotesTools({
    runId: runId === undefined ? undefined : String(runId),
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
    // ADR-015 semantic 槽位：worker 已透传 runToolLoop 的 semanticStateProvider 参数
    // （宿主契约 docs/host-consumer-contract.md §Run state：折叠重建 run state 时回调）。
    semanticStateProvider: assembler.semanticStateProvider,
  };
}
