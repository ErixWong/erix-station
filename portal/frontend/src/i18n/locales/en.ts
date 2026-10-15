// English messages（issue #101 P1；P2 补工作台全量对译，P3 补管理台对译）。键集必须与 locales/zh-CN.ts 完全一致：
// `satisfies MessageSchema` 会在漏译（缺键）或多译（多余键）时编译报错。
// 语言名保持母语自名（中文 / English），不随当前 locale 翻译。
// 注：插值片段（stream.event.dash / paren、errors.runInProgress）在 en 侧用半角括号——
// 它们是直接拼接的可选后缀，`runInProgress` 因此前置一个空格。

import type { MessageSchema } from './zh-CN';

export const en = {
  common: {
    copy: 'Copy',
    copied: 'Copied',
    close: 'Close',
    loading: 'Loading…',
    retry: 'Retry',
    cancel: 'Cancel',
    create: 'Create',
    unnamedSession: 'Untitled session',
    runningBadge: '● Running',
    emptyDir: '(empty directory)',
    noDir: '(no directory)',
    createFirstDir: 'Create a directory first',
    adminConsole: 'Admin console',
    logout: 'Sign out',
    platformAdminHint: 'Platform admin: create FDE users and assign resources in the admin console',
    goToAdmin: 'Go to admin console',
  },
  locale: {
    label: 'Language',
    zhCN: '中文',
    en: 'English',
  },
  login: {
    title: 'Sign in to FDE Station',
    loginName: 'Login name',
    password: 'Password',
    next: 'Next',
    totpHint: 'Enter the 6-digit code from your authenticator app (two-step sign-in for local accounts).',
    totpLabel: 'TOTP',
    totpSubmit: 'Verify & sign in',
    backToLogin: '← Back to login',
  },
  // #255 forced first-login password change (views/ForcePasswordChangeView.vue). Restricted session
  // escape hatch (portal.md §2.11a). No hard-coded port/host; no promise about a minimum length
  // rule the backend (§2.9.4) does not enforce yet.
  forcePassword: {
    title: 'Change your initial password first',
    intro:
      'An administrator set your password, so it has never passed through your own hands. Platform features stay locked until you set a new password.',
    currentLabel: 'Current password',
    newPasswordLabel: 'New password',
    confirmPasswordLabel: 'Confirm new password',
    submit: 'Change password',
    submitting: 'Changing…',
    mismatch: 'The two new passwords do not match',
    incomplete: 'Enter your current password and a new password',
    // The #255 ① stopgap `serverError` / `genericError` keys (which just echoed code/message) are
    // replaced wholesale by the `errors.*` table below — no second path left for later readers to find.
    // Session semantics (§2.6a): self-service change keeps the current session and revokes the
    // others ⇒ never say "you have to sign in again".
    sessionHint: 'This sign-in stays valid; your sessions elsewhere are revoked.',
    logout: 'Use another account / sign out',
    // #255 frontend ②: **error code → actionable copy** table (portal.md §1.2 / §2.6a / §2.11 / §2.11a).
    // Each entry says what to do next; the raw server evidence is appended via `detail` (server
    // error.message is never translated on the client). Key names = server `error.code`;
    // `unknown_code` / `*_no_retry` / `no_*` are client-side fallback keys with no server counterpart.
    errors: {
      // 401 invalid_credentials: §2.6a says it is deliberately the *same* code as a failed login ⇒
      // only `code` can tell it apart from 401 unauthorized. A status-based mapping must never win
      // over the code mapping, or a wrong old password would be read as an expired session.
      invalid_credentials: 'That current password is wrong. Re-enter the password you are using right now (not the new one you want), or use the sign-out button below and ask an administrator to set a fresh one.',
      validation_failed: 'The “{field}” field did not pass validation. Fix that field as described and submit again.',
      // 401 unauthorized: no live session left ⇒ the only way out is signing in again (action=relogin).
      unauthorized: 'This sign-in has expired, and changing a password needs a live session. Use the sign-out button below to return to the sign-in page and sign in again.',
      forbidden: 'This account is not allowed to perform the change. Check the account state with an administrator and try again.',
      // 403 cross_origin_forbidden (#234 same-origin defence, §2.11): “not entitled to send this
      // request”, not “not allowed to do this”.
      cross_origin_forbidden: 'The browser marked this submission as cross-site and the same-origin defence rejected it. Open this page directly from the address bar and retry there instead of changing the password from a window embedded in another site.',
      // 405: §211a deliberately allows any method on this endpoint so it is *not* rewritten to 403 ⇒
      // seeing 405 means something in between changed the method.
      method_not_allowed: 'This endpoint only accepts POST: something (a proxy or a cache) most likely rewrote the method. Hard-refresh the page and retry; if it keeps failing, hand the error code below to an administrator.',
      // 429 / 503 both carry Retry-After (§2.6a): the seconds come from {seconds}; when the header is
      // absent fall back to the *_no_retry keys.
      rate_limited: 'Too many password-change attempts, so you are rate limited for {seconds} seconds. Wait it out — clicking again only extends it.',
      rate_limited_no_retry: 'Too many password-change attempts, so you are rate limited. Wait a little while before submitting again — clicking again only extends it.',
      kdf_busy: 'The server is busy (its password-derivation gate is full — one change runs scrypt twice). Your password is not the problem; try again in {seconds} seconds.',
      kdf_busy_no_retry: 'The server is busy (its password-derivation gate is full). Your password is not the problem; try again in a moment.',
      internal: 'The server failed and this change was not applied. Retry once; if it still fails, hand the error code below to an administrator verbatim.',
      // 409 `llm_model_not_found` (#289 slice B2, §1.2 / §4.3): the bound `model_info.id` is gone from the
      // gateway (model deleted/recreated ⇒ the id changed). Unlike `forbidden` this is not a permission
      // problem — the thing you were bound to no longer exists. Param-free (resolveErrorCode injects none).
      llm_model_not_found: 'The model you are bound to was deleted or recreated in the LLM gateway: re-select the model for that slot in the admin console at /admin, then retry (contact your administrator if you lack access).',
      // Unknown-code fallback: **never silently degrade to a generic error** — carry the code and the
      // HTTP status verbatim so the failure can be reported.
      unknown_code: 'Unrecognised error (HTTP {status}, code {code}). Retry once; if it still fails, hand that status and error code verbatim to an administrator.',
      // Raw evidence appended to every message (server message passed through untranslated).
      detail: 'Server said: {message} (code {code})',
      // After a 401 bounces the user to the sign-in page, that page has to explain why (the wording
      // no longer points at a button on the change-password screen).
      sessionExpiredNotice: 'Your sign-in expired, so the password was not changed. Sign in again and change it once more.',
      no_message: 'the server returned no message',
      no_code: 'no error code',
      field: {
        current_password: 'current password',
        new_password: 'new password',
        confirm_password: 'confirm new password',
        // The contract only promises a field name; carry anything else through verbatim and say so.
        other: '{field} (unrecognised field name)',
        // No `field` in details (or an empty one): never render an empty quote pair.
        missing: 'an unspecified field',
      },
    },
  },
  workbench: {
    nav: '☰ Navigation',
    openNavigation: 'Open navigation',
    who: '{login} ({role} / {fde})',
    whoNoFde: '{login} ({role})',
    cwdCopyTitle: '{cwd} (click to copy)',
    toLatest: '↓ Latest',
    resizeSidebar: 'Resize sidebar',
    inputPlaceholder: 'Type a task, Enter to send (Shift+Enter for a newline)',
    systemInjection: '[system] {content}',
    stopRequested: 'Stop requested…',
    notifyFailed: 'Run failed: {code} — {message}',
    notifyEnded: 'Run ended: {reason}',
    notifyDone: 'Run finished',
  },
  sidebar: {
    dirLabel: 'Directory',
    newDirOption: '＋ New directory',
    refreshTitle: 'Refresh directory list and tree',
    newDirTitle: 'New directory',
    newDirLabel: 'Directory name (lowercase letters / digits / hyphens)',
    newDirPlaceholder: 'e.g. my-project',
    newSession: '＋ New session',
    browse: 'Browse sessions',
    browseTitle: 'Browse sessions (Ctrl/⌘+K)',
    noSessions: 'No sessions',
    // issue #107：inline rename entry（pencil button title/aria-label + edit input placeholder；#112 SVG icon）
    rename: 'Rename session',
    renamePlaceholder: 'Session name',
    // issue #114：AI rename entry (one LLM call on click) + inline loading hint
    aiRename: 'AI rename',
    aiRenaming: 'Naming with AI…',
    // issue #197: per-session message count in the sidebar list sub-line (same counting rule as the session header stats line: all message rows incl. synthetic)
    messageCount: '{count} messages',
  },
  tree: {
    title: 'Directory tree',
    selectDirFirst: 'Select a directory first',
  },
  stream: {
    chooseOrNewSession: 'Select or create a session',
    argsPending: '(generating arguments…)',
    argsStreaming: '(arguments streaming…)',
    reasoning: 'Reasoning',
    // issue #189：compaction banner (standalone separator look, summary collapsed by default, read-only lazy load)
    folded: {
      range: 'Compressed {count} messages (rounds {from}–{to})',
      countOnly: 'Compressed {count} messages',
      bare: 'Compressed',
      viewOriginal: 'View original',
      originalEmpty: '(no text content)',
      originalMissing: 'Original text unavailable (upstream did not retain the folded payload)',
      originalError: 'Failed to load the original text: {message}',
    },
    // issue #189 (addendum): session header stats line "N messages · compacted M times" + restrained hint (M≥1 only)
    sessionStats: '{count} messages',
    sessionStatsCompacted: 'compacted {count}×',
    sessionCompactionHint: 'Context compaction has started; open a new session if you need to keep full details',
    event: {
      resync: 'Event stream needs resync ({why}); reconnecting to catch up…',
      resyncBufferOverflow: 'server buffer overflow',
      attempt: 'round {round} · attempt {attempt}/{max}',
      // issue #288 (defect B): the worker was killed by the host and re-queued. Before this the user
      // only saw the same tool card light up 3 times and then a reason-less "attempts exhausted".
      // Payload is synthesized by portal in the release-requeue branch (docs/api/portal.md §5.3):
      // {attempt, max_attempts, reason, killed_by, silent_ms?}. {silent} is an OPTIONAL suffix the
      // caller passes as an empty string when there is no duration (same convention as dash/paren),
      // so this message must not assume {silent} is non-empty.
      attemptKilled: 'attempt {attempt}/{max} was killed ({cause}), re-queued and waiting for a retry{silent}',
      // killed_by accepts exactly these two values (docs/api/portal.md §5.3); keys are the raw
      // reported values, not camelCase.
      attemptKilledCause: {
        watchdog: 'execution went silent and the watchdog terminated it',
        crash: 'the worker exited unexpectedly',
      },
      // Silent-duration suffix: the unit comes from lib/toolSummary.formatDuration together with the
      // number, so the text must not hard-code `ms`.
      attemptKilledSilent: ' (silent {dur})',
      // killed_by is an additive field: fallback text for unknown/missing values (never [object Object]
      // or "undefined").
      attemptKilledUnknown: 'cause unknown',
      // issue #288 (defect C): on crash recovery the engine no longer auto-replays a tool left with a
      // `tool_use` and no `tool_result` (runner now passes `replayPolicy: 'per-tool-declaration'`);
      // retrying is handed back to the model. Neutral wording on purpose: not replaying is not a failure
      // (the paired tool_result already marks the card failed), so this is a grey separator, not an error.
      // {tool} is an OPTIONAL suffix (same convention as attemptKilledSilent): the caller passes an empty
      // string when the tool name is not trustworthy, so this message must not assume it is non-empty.
      toolReplaySkipped: 'tool execution was interrupted and has not been replayed; the model decides whether to retry{tool}',
      // Tool-name suffix: the name comes from the payload (engine pass-through = foreign data); dirty
      // values are already blocked by a typeof guard at the call site.
      toolReplayTool: ' ({name})',
      recovering: 'Retrying ({attempt}/{max})',
      recovered: 'Retry succeeded',
      judgePassThrough: 'judge: pass through ({mode})',
      judgeExtend: 'judge: extend rounds{dash}{paren}',
      judgeNoExtend: 'judge: no extension{dash}',
      judgeAction: 'judge: {action}{dash}',
      compaction: 'Context compaction (round {round}): {folded} rounds folded, {before} → {after} tokens',
      finalGuard: 'final guard: {action}{dash}',
      forcedFinal: 'forced final (round {round}): {reason}',
      runEnd: 'run ended: {reason}{usage}',
      runEndNormal: 'completed normally',
      missedRunEnd: 'This run ended while the connection was interrupted (see run history)',
      runFailed: 'run failed: {code} — {message}',
      // issue #212: user-readable labels for the newly surfaced fail reasons (keys are the raw
      // engine reason strings, not camelCase, so they line up 1:1 with EXPLAINED_FAIL_REASONS in
      // lib/terminationReasons.ts). Existing failed / aborted / max_rounds_cap keep passing the
      // raw enum through — unchanged baseline.
      runEndReason: {
        // the run snapshot never reached the store → crash recovery may replay tool side effects
        persistence_failed: 'run snapshot not persisted (side effects may repeat on resume)',
        // the final answer never passed the final guard → the user must review it
        final_guard_unverified: 'final answer not verified',
      },
      // issue #212: persistence detail forwarded from the engine termination
      // (operation/phase/sideEffect) — the workbench must show the phase
      runEndPersistence: 'persistence detail {operation}/{phase}/{sideEffect}',
      // issue #283: the duration is passed pre-formatted (`12ms` / `4.3s` / `1m 5s`) by
      // `formatDuration(ms)` — the text must not hard-code the `ms` unit any more.
      toolResult: '{mark} {digest} ({dur})',
      // same line without a duration (issue #283: never fake a missing duration as `0ms`,
      // and never leave empty parentheses)
      toolResultNoDur: '{mark} {digest}',
      dash: ' — {value}',
      paren: ' ({value})',
    },
  },
  composer: {
    send: 'Send',
    stop: '■ Stop',
    // issue #261B：上一条发送以失败终局收场时的一键重发（中英双语同口径）。
    retry: 'Retry last',
  },
  picker: {
    title: 'Browse sessions',
    scopeLabel: 'Session scope',
    currentDir: 'Current directory: {name}',
    currentDirTitle: 'Current directory: {cwd}',
    noDirSelected: 'No directory selected',
    allDirs: 'All directories',
    listLabel: 'Session list',
    empty: 'No sessions in this scope',
    staleListKept: '(previous list kept)',
  },
  preview: {
    title: 'Preview {path}',
  },
  // Preview port panels (issue #246 delivery ②, ticket B: workbench section + admin FDE pane).
  // Contract red line (portal.md §4.7a): `active` only means “the first credential was admitted” ⇒
  // state wording never claims healthy/running; server error.message passes through verbatim.
  previewPorts: {
    title: 'Preview ports',
    adminTitle: 'Preview ports of {fde}',
    // workbench disclosure bar (collapsed state must still convey something useful)
    toggle: 'Preview ports',
    toggleCount: 'Preview ports ({count})',
    toggleFailed: 'Preview ports (failed to load)',
    colPort: 'Port',
    colHostname: 'Preview host',
    colState: 'State',
    colActions: 'Actions',
    openAction: 'Open preview',
    signing: 'Issuing ticket…',
    hostnameCopyTitle: '{url} (click to copy the full URL)',
    copiedUrl: 'Preview URL copied to clipboard.',
    copyFailed: 'Copy failed: ',
    state: {
      // allocated = assigned but never admitted; active = first credential was admitted once
      allocated: 'Allocated · not opened yet',
      active: 'Admitted once (first admission only)',
    },
    stateUnknown: 'Unknown state ({state})',
    stateHint: '“Admitted once” only means the first credential was admitted; it does not mean an app is listening in the container.',
    emptySelf: 'You have no preview ports yet (the platform has not assigned a block, or all of them were released).',
    emptyFde: 'This FDE has no live preview ports (not onboarded yet, or already offboarded).',
    loadFailed: 'Failed to load preview ports ({code}): {message}',
    ticketFailed: 'Failed to issue the preview ticket ({code}): {message}',
    popupBlocked: 'The browser blocked the new tab;',
    popupBlockedLink: 'open the preview here',
    noFdeName: 'This user has no fde_name, so there are no preview ports.',
    // admin block-move (relocation) card (components/FdePreviewPortsPane.vue)
    admin: {
      moveTitle: 'Move block (relocate the preview port block)',
      moveAction: 'Move block…',
      moving: 'Relocating…',
      blockStartLabel: 'New block start',
      blockStartPlaceholder: 'e.g. 22010',
      blockHint: 'Pool 22000–29999, 10 ports per block, the start must be 10-aligned; moving a block relocates the whole block, it does not add a second one.',
      alignHint: 'This start is outside the pool or not 10-aligned: the server will reject it (invalid block_start).',
      currentBlock: 'Current block: {block} ({count} live ports)',
      currentBlockNone: 'No live preview port block right now.',
      notInteger: 'block_start must be an integer (for example 22010).',
      confirmTitle: 'Confirm the preview port block move',
      confirmBody: 'Move {fde} from block {oldBlock} to {newBlock} ({count} live ports).',
      confirmBodyNoBlock: 'Create preview block {newBlock} for {fde}.',
      confirmWarning: 'The old block’s preview hosts stop working immediately (measured: plain 404), links the FDE already holds break, and this cannot be undone.',
      confirmOk: 'Confirm relocation',
      moved: 'Relocation done: {oldBlock} → {newBlock}; released {released} old allocations, revoked {revoked} preview grants, inserted {inserted} new ones.',
      movedNoop: 'Target block {block} is already this FDE’s live block: zero writes, nothing changed.',
      movedPorts: 'New block ports: {ports}',
      fieldErrorBlockStart: 'Field block_start is invalid: {message}',
      moveFailed: 'Block move failed ({code}): {message}',
      blockTakenHint: 'That block is taken (the server never silently picks another one): choose a fully free aligned start and retry.',
    },
  },
  admin: {
    title: 'FDE Station Admin Console',
    backToWorkbench: '← Back to workbench',
    errorPrefix: 'Error: ',
    enabled: 'Enabled',
    disabled: 'Disabled',
    delete: 'Delete',
    edit: 'Edit',
    save: 'Save',
    confirmDeleteTitle: 'Confirm deletion',
    expand: 'Expand',
    collapse: 'Collapse',
    tabs: {
      label: 'Admin sections',
      users: 'User management',
      llm: 'LLM management',
      repos: 'Repository management',
    },
    llm: {
      sectionTitle: 'LLM providers',
      emptyProviders: 'No providers yet; add one below.',
      modelsCount: 'Models ({count})',
      collapseModels: 'Hide models',
      emptyModels: 'No models under this provider yet',
      colCallName: 'Call name (what FDE requests actually send)',
      colDisplayName: 'Display name',
      editCallNameHint: 'The data-plane name: it is what FDE requests send, and what `fde_llm_bindings.*_model_name` and the virtual key allow-list store. Renaming propagates immediately to those FDE bindings and allow-lists (old and new names both stay, in-flight requests keep working).',
      editDisplayNameHint: 'Changes only the label shown in the admin console and pickers; it does not change what FDE requests send.',
      callNameRequired: 'Call name cannot be empty: it is the name FDE requests actually send.',
      duplicateCallName: 'Duplicate call name',
      duplicateCallNameHint: 'Several models share this call name: the gateway selects deployments by name, so requests round-robin between them while the model list shows only one.',
      confirmCallNameTitle: 'Confirm call-name change',
      confirmCallNameBody: 'Rename the call name from {from} to {to}: what FDE requests send changes with it, and running tasks switch to the new name immediately.',
      confirmCallNameWarning: 'The old name disappears from routing (the allow-list keeps it, so it no longer masquerades as an auth error); requests still sending the old name will fail.',
      confirmCallNameAction: 'Rename',
      colType: 'Type',
      colContextWindow: 'Context window',
      colMaxOutput: 'Max output tokens',
      colPricing: 'Pricing',
      inputCostLabel: 'Input price (USD / 1M tokens)',
      outputCostLabel: 'Output price (USD / 1M tokens)',
      pricingMissing: 'No pricing set',
      pricingHintAdd: 'Optional. Leaving it blank means no pricing → usage for this model records 0 (LiteLLM bills per token, so both input and output are required).',
      pricingHintEdit: 'Leave blank to keep the current value; entering a rate switches this model to an explicit price.',
      pricingFromCostMap: 'Pricing currently comes from the LiteLLM built-in cost map (not set explicitly).',
      pricingClear: 'Clear pricing (mark as unpriced)',
      upstreamModelId: 'Upstream model id',
      colStatus: 'Status',
      addModel: '＋ Add model',
      addModelTitle: 'Add model',
      providerName: 'Provider name',
      addProvider: '＋ Add provider',
      addProviderTitle: 'Add provider',
      editProviderTitle: 'Edit provider {name}',
      providerApiKeyLabel: 'Upstream API key',
      providerApiKeyAddHint: 'Optional; leave blank for mock models, or enter the key for a real upstream.',
      providerApiKeyEditHint: 'Leave blank to keep the current value; saved keys are never shown.',
      editModelTitle: 'Edit model {model}',
      editContextWindowHint: 'Leave blank to keep the current value; the API cannot clear it.',
      editMaxOutputHint: 'Leave blank to keep the current value.',
      editUpstreamModelHint: 'Enter the full model id used by LiteLLM (for example, openai/gpt-4o); leave blank to keep the current value.',
      confirmDeleteProvider: 'Delete provider {name}? Its models will be deleted as well.',
      confirmDeleteModel: 'Delete model {model}?',
      loadingPane: 'Loading LLM config…',
      activeRunWarn:
        '⚠️ Active run: changing the provider or API key will be rejected by the server (it would affect the in-flight run); model-only changes are unaffected.',
      providerLabel: 'Provider',
      virtualKeyLabel: 'Current virtual key:',
      mainModelLabel: 'Main model',
      mainModelCapabilities: 'text · tool_calling',
      embeddingLabel: 'Embedding (optional)',
      visionLabel: 'Vision (optional)',
      notConfigured: '(not configured)',
      save: 'Save LLM config',
      saved: 'Saved: main model {model}',
      provision: 'Provision container',
      provisionDone: 'Provisioned: {container} ({network} {subnet})',
      conflictPrefix: 'Rejected (409): ',
      forceSave: 'No impact — force save',
    },
    fde: {
      sectionTitle: 'FDE users',
      emptyUsers: 'No users yet.',
      noFdeName: 'no fde_name',
      noFdeNameHint: 'This user has no fde_name configured; no LLM config needed.',
      searchPlaceholder: 'Search login, display name, or FDE name',
      searchEmpty: 'No users match your search.',
      loadingUsers: 'Loading users',
      createUser: '＋ Create user',
      colLogin: 'Login',
      colDisplayName: 'Display name',
      colRole: 'Role',
      colFde: 'FDE',
      colMfa: 'MFA',
      colStatus: 'Status',
      colOnboarding: 'Onboarding',
      colLifecycle: 'Provisioning / offboarding',
      colActions: 'Actions',
      roleFde: 'FDE',
      roleAdmin: 'Admin',
      statusActive: 'Active',
      statusDisabled: 'Disabled',
      statusAwaitingCredential: 'Awaiting credential',
      retryOnboarding: 'Retry',
      onboardingRetryQueued: 'Onboarding has been queued again.',
      userReactivated: 'Existing FDE account reactivated; history and audit records were retained, and onboarding was queued again.',
      llmBindingFailed: 'LLM binding failed',
      offboardingQueued: 'Offboarding started; the account is disabled while resources are being removed.',
      retryOffboarding: 'Retry offboarding',
      offboardingRetryQueued: 'Offboarding has been queued again.',
      offboardingTitle: 'Offboarding',
      workspacePurgeAfter: 'Workspace directory cleanup after {date}',
      onboarding: {
        pending: 'Provisioning',
        running: 'Provisioning',
        awaiting_credential: 'Awaiting credential',
        done: 'Ready',
        failed: 'Failed',
      },
      offboarding: {
        pending: 'Offboarding',
        running: 'Offboarding',
        done: 'Offline; retaining workspace',
        failed: 'Offboarding failed',
      },
      offboardingSteps: {
        'disable-user': 'Disable account and stop runs',
        'stop-container': 'Stop FDE container',
        'revoke-runner-token': 'Revoke runner token',
        'revoke-llm-key': 'Revoke LLM key',
        'delete-git-credential': 'Remove Git credentials',
        'revoke-git-account-access': 'Revoke upstream Git account access',
        'release-network-routes': 'Release network and routes',
        'schedule-workspace-purge': 'Schedule workspace purge',
      },
      mfaEnabled: 'Enabled',
      mfaDisabled: 'Not enabled',
      editAction: 'Edit',
      enableUser: 'Enable',
      disableUser: 'Disable',
      editUserTitle: 'Edit user profile',
      editTabProfile: 'Profile',
      editTabSecurity: 'Security',
      editTabLlm: 'LLM & Repository',
      editTabPorts: 'Preview ports',
      editTabDanger: 'Danger zone',
      basicProfileSection: 'Basic profile',
      llmSection: 'LLM binding',
      dangerSection: 'Danger zone',
      totpSection: 'TOTP settings',
      totpSectionHint: 'Manage this user’s TOTP registration; re-enrolling immediately invalidates the old secret.',
      lastLogin: 'Last login',
      neverLoggedIn: 'Never',
      updateProfile: 'Save profile',
      profileUpdated: 'Profile updated.',
      statusUpdated: 'User status updated.',
      resetPasswordTitle: 'Reset user password',
      resetPasswordHint: 'The user will need to sign in again with the new password.',
      newPassword: 'New password',
      submitPasswordReset: 'Confirm password reset',
      passwordResetDone: 'Password reset; the user must sign in again.',
      resetTotpHint: 'This clears the current TOTP binding and revokes the user’s login sessions.',
      confirmTotpReset: 'Confirm TOTP reset',
      totpResetDone: 'TOTP reset; the user must sign in again.',
      enrollTotp: 'Bind TOTP',
      reenrollTotp: 'Rebind TOTP (invalidate old code)',
      enrollTotpHint: 'A new TOTP secret will be generated and all of this account’s login sessions will be revoked. The new secret is shown only once.',
      reenrollTotpHint: 'The old secret will be invalidated immediately and all of the user’s login sessions will be revoked. The new secret is shown only once.',
      totpEnrollDone: 'TOTP bound or rebound; the user must sign in again.',
      deleteUser: 'Disable user',
      deleteUserTitle: 'Disable user and offboard',
      deleteUserHint: 'This immediately disables the account and starts FDE offboarding. The user record is retained permanently; workspace cleanup is off by default. Type the login {login} to confirm.',
      deleteLoginLabel: 'Type login to confirm',
      deleteLoginPlaceholder: 'Enter login name',
      confirmDeleteUser: 'Disable account and start offboarding',
      randomPassword: 'Generate random',
      copyFailed: 'Copy failed: ',
      createPasswordPlaceholder: 'Enter or generate a password',
      totpSaved: 'I have saved it',
      copiedFeedback: 'Copied to clipboard.',
      addUserTitle: 'Add FDE user',
      loginLabel: 'Login name',
      displayNameLabel: 'Display name',
      passwordLabel: 'Password',
      fdeNameLabel: 'fde_name',
      emailLabel: 'Email',
      gitHostLabel: 'Git host',
      selectGitHost: 'Select a Git host',
      noOnboardableGitHosts: 'No available Git hosts. Add and enable a non-Azure host first.',
      llmModelSection: 'LLM models (required)',
      llmCatalogError: 'The LiteLLM model catalog could not be loaded. Enable or repair the optional LiteLLM profile before creating a user. {error}',
      retryLlmCatalog: 'Retry catalog',
      loadingLlmCatalog: 'Loading the LiteLLM model catalog…',
      noOnboardableLlmModels: 'No enabled text model with tool-calling support is available. Add or enable one in LLM management.',
      llmProviderLabel: 'Provider',
      selectLlmProvider: 'Select a provider',
      llmMainModelLabel: 'Main model (required)',
      selectLlmMainModel: 'Select a main model',
      llmEmbeddingModelLabel: 'Embedding model (optional)',
      llmVisionModelLabel: 'Vision model (optional)',
      llmModelNotConfigured: '(not configured)',
      totpEnabledOpt: 'Enable TOTP',
      totpEnabledHint: 'Off by default. If enabled, scan the QR code with an authenticator app to bind it.',
      addUser: 'Create user',
      totpTitle: 'User created · TOTP setup',
      totpReactivatedTitle: 'User reactivated · TOTP setup',
      totpEnrollTitle: 'TOTP bound · one-time secret',
      qrAlt: 'TOTP authenticator QR code',
      totpCreated: 'User {login} created. Enroll the otpauth URI below or the seed in an authenticator app ({onlyOnce}):',
      totpReactivated: 'User {login} reactivated and the old TOTP was replaced. Enroll this otpauth URI or seed in an authenticator app ({onlyOnce}):',
      totpEnrolled: 'TOTP for {login} has been bound or rebound. Enroll this new secret ({onlyOnce}; the old secret is invalid):',
      totpOnlyOnce: 'shown only once',
      otpauthUri: 'otpauth URI: ',
      totpSecret: 'TOTP seed: ',
      nextStep: 'Securely save and share the TOTP information. Close this prompt only after saving the secret.',
    },
    repos: {
      title: 'Repository management',
      empty: 'No Git hosts yet; add one below.',
      add: '＋ Add Git host',
      addTitle: 'Add Git host',
      editTitle: 'Edit Git host',
      name: 'Name',
      provider: 'Provider',
      baseUrl: 'Base URL',
      adminKey: 'Platform admin key (optional)',
      adminKeyPlaceholder: 'Gitea / GitLab administrator credential',
      adminKeyKeep: 'Leave blank to keep unchanged',
      adminKeyConfigured: 'Key configured: {key}',
      clearAdminKey: 'Clear configured key (use per-FDE credentials)',
      modeAuto: 'Mode is derived from provider and admin key. GitHub and hosts without an admin key require each FDE to provide credentials.',
      githubHint: 'The platform cannot mint GitHub credentials: do not configure an admin key, the host mode is always “Credential required”. Each FDE must submit its own PAT via the portal (gh CLI reads ~/.config/gh/hosts.yml inside the container).',
      modeMinted: 'Platform-minted',
      modeCredential: 'Credential required',
      confirmDelete: 'Delete Git host “{name}”? A host assigned to an FDE cannot be deleted.',
      selectHost: 'Git host',
      noHost: 'No Git host',
      credentialTitle: 'Enter the FDE Git credential',
      credentialHint: 'This host requires the FDE’s own credential. The token is written only to that FDE’s credential file, not the database.',
      credentialUsername: 'Git username',
      credentialToken: 'Personal access token',
      saveCredential: 'Save credential',
      credentialSaved: 'Credential saved; the FDE account is active.',
    },
  },
  errors: {
    requestFailed: 'Request failed (HTTP {status})',
    sessionLoadFailed: 'Failed to load the session; refresh to retry',
    createSessionFailed: 'Failed to create session: {message}',
    stopFailed: 'Failed to stop: {message}',
    dirNameInvalid:
      'Directory name must be lowercase letters / digits / hyphens, and must not start or end with a hyphen (max 63 characters)',
    sendFailed: 'Send failed: {message}',
    sendFailedLlmNotConfigured:
      'Send failed: this FDE has no LLM upstream configured. Set it up in the admin console at /admin (contact your administrator if you lack access)',
    sendFailedLlmModelNotFound:
      'Send failed: the model this FDE is bound to no longer exists in the LLM gateway (slot {slot}, model id {model_id}). Re-select the model in the admin console at /admin and send again (contact your administrator if you lack access)',
    runInProgress: ' (a run is already in progress)',
    treeLoadFailed: 'Failed to load the directory tree: {message}',
    // issue #107：inline rename — blank title blocked locally / hint when the PATCH fails (old title restored)
    renameEmpty: 'Session title cannot be empty',
    renameFailed: 'Rename failed: {message}',
    // issue #114：AI rename failure (message comes from the server: 409 no LLM configured / 502 upstream)
    aiRenameFailed: 'AI rename failed: {message}',
  },
} as const satisfies MessageSchema;
