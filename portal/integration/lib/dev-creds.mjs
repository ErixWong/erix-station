// 宿主凭据路径与脚本账号登录名的**唯一来源**（issue #897）。
//
// 为什么坐标集中在这一个文件里（而不是散在 6 支集成脚本的代码行）：
//  1) 闸只扫注释行——`scripts/check-doc-portable.mjs` 的扫描面只认 trim 后以 `//`、`#`、`*`、`<!--`
//     开头的行，所以落在**代码行**的凭据路径字面（原先 8 处）它永远看不见，DENY 形同虚设；
//     把坐标收进这一处后，闸新增一条窄判据（代码行同时含 `~/.config/` 与 `mcp/creds` ⇒ 判红、
//     唯一豁免本文件）就能守住「别的地方不再长出新的凭据字面」。
//  2) 轮换凭据 / 换机器 / 改目录口径只改这一处：过去同一对回退路径在 6 支脚本里各抄一份，
//     改一次要同步 8 个位置，漏一处就悄悄指向旧口令文件。
//
// 纪律：以下候选路径与默认登录名的**字面只许出现在本文件**；顺序、`~` 前缀逐字不变，
// `~` 的展开仍由各调用方负责（本模块只返回带 `~` 的原样字符串，不碰 homedir）。
/**
 * 凭据文件候选路径（顺序即回退优先级：新路径优先、旧路径兜底，逐字与原脚本一致）。
 * @param {'script'|'admin'} kind `'script'` = FDE 脚本账号；`'admin'` = 管理员账号
 * @returns {string[]} 带 `~` 前缀的候选路径数组（未展开）
 */
export function credsFileCandidates(kind) {
  if (kind === 'admin') {
    return ['~/.config/mcp/creds/station-dev.password', '~/.config/creds/station-dev-password-file'];
  }
  return ['~/.config/mcp/creds/station-agent01.password', '~/.config/creds/station-agent01-password-file'];
}

/** FDE 脚本账号的默认登录名（原各脚本 `process.env.E2E_FDE_LOGIN || <默认账号>` 里的那个字面量）。 */
export function defaultScriptLogin() {
  return 'agent01';
}
