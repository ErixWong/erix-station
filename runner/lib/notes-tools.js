// station 自带 note 工具（note_take/note_read/note_list/note_forget）。
// erix-agent 0.8.0 退役 recall 工具后，档案取回统一走 note 工作流（note-first：
// note_list 发现 → note_read 精确读取，见 host-consumer-contract.md「Retrieval and request-view folding」）。
// note 工具实现**直接复用上游随包发布的 notes 技能模块**（skills/notes/skill.mjs，CLI 同一份
// 参考实现），宿主侧只负责：① NotesStore 装配（erix-agent 导出的 createFileNotesStore，
//    落盘路径必须在 run worktree 内）；② 与 CLI（bin/skills.js）相同的 __erix 宿主作用域注入。
// 注意：skills/ 不在 package exports 白名单（exports 只有 ./tools 与 ./contract-tests），
// 这里经 import.meta.resolve('erix-agent') 定位包内路径——包 files 含 skills/，npm 发布内容稳定。
// 加载失败不中断 run：降级为无 note 工具（模型失去档案取回能力，但 runToolLoop 照常）。
import { assertNotesStore, createFileNotesStore } from 'erix-agent';

const NOTE_TOOL_NAMES = ['note_take', 'note_read', 'note_list', 'note_forget'];

/** 定位 erix-agent 包内 notes 技能模块的 file URL。 */
function notesSkillUrl() {
  return new URL('../skills/notes/skill.mjs', import.meta.resolve('erix-agent'));
}

/**
 * 创建 run 作用域的 note 工具集（{schemas, executors}，与 createFileTools 返回结构对齐）。
 * @param {{runId:string, notesDir:string}} options notesDir 必须在 run worktree 内
 * @returns {Promise<{schemas:object[], executors:Record<string, Function>, notesStore:object}>}
 * @throws {Error} 技能模块加载失败或 NotesStore 断言失败（调用方决定降级还是 fail）
 */
export async function createNotesTools({ runId, notesDir }) {
  const skillModule = await import(notesSkillUrl());
  const definition = typeof skillModule.getSkillDefinition === 'function'
    ? skillModule.getSkillDefinition()
    : null;
  const schemas = (definition?.tools ?? []).filter((tool) => NOTE_TOOL_NAMES.includes(tool?.name));
  const missing = NOTE_TOOL_NAMES.filter((name) => typeof skillModule[name] !== 'function');
  if (schemas.length === 0 || missing.length > 0) {
    throw new Error(`notes skill 模块缺少工具执行函数：${missing.join('、') || '(无 schema)'}`);
  }

  const notesStore = assertNotesStore(createFileNotesStore({ dir: notesDir }));
  // 与 CLI（bin/skills.js buildSkillTools）同一注入形态：__erix = {runId, notesDir, notesStore}。
  const hostScope = { runId: String(runId), notesDir: String(notesDir), notesStore };

  const executors = {};
  for (const tool of schemas) {
    executors[tool.name] = (input) => {
      const allowed = new Set(Object.keys(tool.inputSchema?.properties ?? {}));
      const filteredInput = input && typeof input === 'object' && !Array.isArray(input)
        ? Object.fromEntries(
            Object.entries(input).filter(([key]) => key !== '__erix' && allowed.has(key)),
          )
        : {};
      return skillModule[tool.name]({ ...filteredInput, __erix: hostScope });
    };
  }

  return { schemas, executors, notesStore };
}
