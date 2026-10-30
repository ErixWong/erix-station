import type { LlmModel } from '../stores/admin';

/**
 * LLM 模型在**人看的**地方（下拉选项、toast）的标签。
 *
 * 为什么不用 `model_id`：它是 LiteLLM 的主键 `model_info.id`，**是 UUID**（建模型时没写
 * `model_info.id`，LiteLLM 自己生成）。所以「`model_id` — 展示名」在真实环境里渲染成
 * 「920aa0c6-f336-4085-b6b1-607660883b35 — deepseek-flash」——把内部主键摊到了管理员界面上。
 *
 * #296 定稿的两个名字才是该给人看的：
 *   * `name` = `model_info.display_name`：展示名；
 *   * `model_name` = 顶层 `model_name`：调用名（FDE 请求实际发的那个名字）。
 * 两者相同（存量模型绝大多数如此）就只显示一次，不同才补括号注明调用名——与模型表格
 * （AdminView「调用名 / 显示名」两列）同源，不引入第三套叫法。
 *
 * 提交/回填仍走主键 `id`，本函数**只管显示**。
 */
export function modelOptionLabel(model: LlmModel): string {
  const display = (model.name ?? '').trim();
  const call = (model.model_name ?? '').trim();
  if (display && call && display !== call) return `${display} (${call})`;
  return display || call || String(model.model_id ?? '');
}
