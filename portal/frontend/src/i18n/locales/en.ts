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
    // issue #332：`platformAdminHint` / `goToAdmin` 与 zh-CN 同步删除（无工位平台管理员已被路由守卫
    // 送去管理台，这两句在工作台上不可达；键集对齐由 localeParity.spec + `satisfies MessageSchema` 钉）。
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
    newDirLabel: 'Directory name (lowercase letters, digits, underscores, hyphens; must not start or end with a hyphen or underscore; max 63 characters)',
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
      range: 'Compressed rounds {from}–{to}',
      countOnly: 'Compressed {count} messages',
      bare: 'Compressed',
      // D 片（issue #392）：visibility line. The title answers "what was compressed"; this line answers
      // "who can no longer see it". `hasSummary` key absent (old DTO) ⇒ the whole line is not rendered
      // (same "absent key = unknown" discipline as #390-A). Round count only from `foldedRoundRange`.
      visibility: '{n} rounds of original text are no longer visible to the model; the summary below is all that remains.',
      visibilityNoSummary: '{n} rounds of original text are no longer visible to the model, and this fold produced no summary — use “View original” to read them.',
      visibilityBare: 'This original text is no longer visible to the model; the summary below is all that remains.',
      visibilityNoSummaryBare: 'This original text is no longer visible to the model, and this fold produced no summary — use “View original” to read them.',
      viewOriginal: 'View original',
      // #388: the original block's own collapse entry (hides only, never clears the cache; re-expanding does not refetch)
      collapseOriginal: 'Collapse original',
      originalEmpty: '(no text content)',
      // #384: a ledger turn carries four kinds of content (`text` / `reasoning` / `toolCalls[]` / being the
      // user). The old renderer drew only `text`, so the turns that actually *did something* (reasoning plus
      // tool calls, no prose) all collapsed into the placeholder above — 40 of 112 turns on the real session.
      // All four are rendered now; the placeholder means "this turn truly has nothing".
      originalRoleUser: 'user',
      originalTool: '🔧 {name} | {args}',
      originalToolFailed: ' (failed)',
      originalMissing: 'No text to show for this span (the ledger has none either)',
      originalTruncated: 'This archive was clipped ({count} more messages were not archived separately); the text below is rebuilt from the ledger by round',
      originalError: 'Failed to load the original text: {message}',
    },
    // issue #189 (addendum): session header stats line "N messages · compacted M times" + restrained hint (M≥1 only)
    sessionStats: '{count} messages',
    sessionStatsCompacted: 'compacted {count}×',
    sessionCompactionHint: 'Context compaction has started; open a new session if you need to keep full details',
    // Trial log #10: older-message pagination entry (backend always paginated; the frontend just never fetched older pages).
    loadOlder: 'Load older messages',
    loadOlderLoading: 'Loading…',
    // issue #300: an aborted/failed run has ZERO assistant anchors, so its body area used to render
    // blank; the history endpoint aggregates its assistant_delta into one synthetic item. NEUTRAL
    // wording on purpose: not "completed" (it never finished) and not an "error" (a half-written body
    // is not a fault) -- the paired zh label reads exactly "已中止 · 部分输出".
    partialOutput: {
      label: 'Aborted · partial output',
      truncated: 'Output was not finished before the run stopped (truncated)',
    },
    // Mermaid diagram blocks (see pi-web MermaidBlock): preview/source toggle & render-failure note
    mermaid: {
      preview: 'Preview',
      source: 'Source',
      error: 'Diagram failed to render (syntax error); source shown above',
    },
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
      // issue #371-A: engine `persistence_error{fatal:false}` — a storage failure that does NOT end the
      // run (the stripped part is the fold archive; originals stay readable in the ledger rows, #375).
      // Neutral separator, never red; fatal ones are rendered by `run_end` / `persistence_failed`.
      persistenceDegraded: 'persistence degraded: the {operation} record was not stored (this run is unaffected)',
      // issue #421: four diagnostic event types the engine promises but this host used not to subscribe
      // to. All four render as neutral separator lines — they report "config didn't take effect /
      // capability missing / this batch was never ledgered", not "this round failed".
      strategyFallback: 'compaction is not using the configured strategy: the engine fallback "sliding-window" drops whole head rounds without summarising (from round {round})',
      metadataMissing: 'model context metadata missing: compaction and the aggregate output budget are disabled for this run',
      capabilityDegraded: 'store lacks the {method} capability: that persistence is skipped for this run (no mid-run crash resume)',
      resumeJournalSkipped: '{count} tool result(s) from the crash round (round {round}) were not written to the ledger; the next resume relies on the snapshot',
      resumeJournalSome: 'some',
      recovering: 'Retrying ({attempt}/{max})',
      recovered: 'Retry succeeded',
      // issue #321 (erix-station): the judge is forever only an **opinion**, never an acceptance — shown on
      // independent axes (tool audit / goal verdict / direction / extension can all be non-empty at once;
      // NOT three mutually exclusive states). "Completed" comes solely from the run terminal separator
      // (run_end); this station's runner never passes finalGuard ⇒ verification is always "skipped", so no
      // string below may promise "verified". The caller joins axes with " · ".
      judgeAxes: 'judge: {axes}',
      // Axis 1 · tool audit: `executed` means "this tool call was released", not task completion
      // (the amplifier of ISSUES.md item 4).
      judgeAuditExecuted: 'tool audit: released (not task completion)',
      judgeAuditPassThrough: 'tool audit: released ({mode}; not task completion)',
      judgeAuditBlocked: 'tool audit: blocked (this tool call did not run)',
      // extend / extend+redirect / decline_extend are extension dispositions, not audit verdicts (observed
      // events exist with kind=intercept yet action=extend+redirect whose real audit was a block) ⇒ never
      // infer "tool executed" from such actions; the tool card is the source of truth for execution.
      judgeAuditUndecided: 'tool audit: outcome unknown ({action}); see the tool card for execution',
      // Axis 2 · goal verdict: done=true is fixed to "judge thinks the goal is met (not independently
      // verified)" plus the model-decides-the-wrap-up disclaimer — "main work done, chores remain" is a
      // legal state and must not read as "completed". confidence only shown when a finite number.
      judgeGoalDoneTrue: 'goal considered met (not independently verified; the model itself decides whether to wrap up)',
      judgeGoalDoneFalse: 'goal considered not met yet',
      judgeConfidence: ' (confidence {confidence})',
      judgeReason: 'reason: {value}',
      // Axis 3 · direction: on_track is the norm and stays quiet; uncertain / off_track must not be
      // hidden by the passThrough / extend branches.
      judgeDirectionOffTrack: 'direction: may have drifted',
      judgeDirectionUncertain: 'direction: uncertain',
      // Axis 4 · extension opinion (from decision.extend; no invented tier, no cost estimate — that is #282).
      judgeExtendSuggest: 'suggests extending rounds',
      judgeExtendDecline: 'suggests no extension',
      // Neutral degradation: a failed judge call (degraded) and unknown actions newly added by the engine —
      // grey judge-panel line, no red, no interpretation.
      judgeDegraded: 'judge degraded ({error}); no verdict this round',
      judgeUnknownAction: 'judge action: {action}',
      judgeNoDetail: 'judge event (no interpretable details)',
      compaction: 'Context compaction (round {round}, strategy {strategy}): {folded} rounds folded, {before} → {after} tokens{degrade}',
      compactionStrategyUnknown: 'unknown',
      compactionDegradeNote: ' (⚠ {body})',
      compactionDegraded: 'summary degraded: {kind}',
      compactionBudgetExhausted: 'summary budget exhausted (no self-heal retry)',
      compactionInputClipped: 'summary input clipped ({rounds} rounds / {messages} messages dropped; written from incomplete material)',
      compactionTruncated: 'summary truncated at the output budget',
      finalGuard: 'final guard: {action}{dash}',
      forcedFinal: 'forced final (round {round}): {reason}',
      runEnd: 'run ended: {reason}{usage}',
      runEndNormal: 'completed normally',
      missedRunEnd: 'This run ended while the connection was interrupted (see run history)',
      runFailed: 'run failed: {code} — {message}',
      // issue #212: user-readable labels for the surfaced fail reasons (keys are the raw
      // engine reason strings, not camelCase, so they line up 1:1 with RUN_END_LABEL_REASONS in
      // lib/terminationReasons.ts). issue #236: **every reason except `end_turn`** has a label
      // (`end_turn` keeps `runEndNormal`); #212's "existing failed / aborted / max_rounds_cap keep
      // passing the raw enum through" is superseded by #236 (a stopped run must read as native
      // language, and the termination separator is now projected into history for every reason).
      // Unknown/future engine reasons stay out of this table ⇒ the raw reason is shown (§5.3).
      runEndReason: {
        // the run snapshot never reached the store → crash recovery may replay tool side effects
        persistence_failed: 'run snapshot not persisted (side effects may repeat on resume)',
        // the final answer never passed the final guard → the user must review it
        final_guard_unverified: 'final answer not verified',
        // issue #236: user pressed stop (previously rendered as the bare English `aborted`)
        aborted: 'stopped by user',
        // engine reported a failure (`termination.errorCode` appends `(code=…)` when present)
        failed: 'run failed',
        // hit the round cap (finishes, but it is an abnormal truncation)
        max_rounds_cap: 'round cap reached',
        // the model stopped calling tools (a normal terminal reason)
        no_tool: 'model made no further tool calls',
        // the round judge decided the goal was met (an opinion, not an independent check)
        judge_done: 'judge decided done',
        // several rounds produced no new output
        stall: 'stalled (no new output)',
        // the continuation budget ran out
        continuation_exhausted: 'continuation budget exhausted',
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
  // Session-page momentum bar + message timestamps (issue #282, blocks A/B). Same key set as zh-CN
  // (localeParity.spec.ts pins it). `~` marks the rate as an estimate; tokens only ever show real
  // run_end.usage values (no 0 fabrication), and unknown durations render nothing.
  runStatus: {
    aria: 'Run status',
    running: 'running',
    idle: 'idle',
    round: 'round {round}',
    output: '↑ {size}',
    rate: '~{rate} tok/s',
    rateHint: 'Rate is a front-end estimate derived from character counts, not an upstream measurement',
    tokens: 'tokens ↑{input} ↓{output}',
    tokensInput: 'tokens ↑{input}',
    tokensOutput: 'tokens ↓{output}',
    runElapsed: 'this run {dur}',
    lastRunElapsed: 'last run {dur}',
    tools: '{count} tool calls',
    toolsAvg: ' (avg {dur})',
    frozen: 'nothing new for {sec}s',
    refreshBoundary: 'After a hard refresh the live rate and elapsed time are lost (run_end is not replayed from history); last run\u2019s tokens and the context window stay visible (they come from replayed round_end usage)',
    runningElapsed: 'running for {dur}',
    runningHint: 'This run is still executing; numbers refresh every second',
    messageTimeTitle: 'Message time',
    // ---- issue #425: phase + tokens (the bar must always be able to say what it is waiting on) ----
    // `{tool}` is the upstream tool identifier (an English token by nature, not translated here).
    phaseAwaiting: 'waiting for the model {sec}s',
    phaseAwaitingHint: 'The request is out and the model has not started answering yet. With a large context this silence can legitimately last tens of seconds; it is not a failure',
    phaseTool: 'running {tool} ({sec}s)',
    phaseToolNoName: 'running a tool ({sec}s)',
    phaseToolHint: 'The tool is really executing inside your container (build / tests / dev server); this duration does not depend on the model',
    phaseStreaming: 'generating',
    phaseSilent: 'nothing new for {sec}s',
    context: 'context {pct}% ({used}/{window})',
    contextHint: 'Context sent to the model on the current round: {used} tokens of a {window}-token window (older rounds get compacted automatically as it fills up)',
    roundTokens: 'this round \u2191{input} \u2193{output}',
    roundTokensInput: 'this round \u2191{input}',
    roundTokensOutput: 'this round \u2193{output}',
    roundTokensHint: 'Real usage for this round (upstream usage payload); \u2191 is the context sent to the model, not the cost',
    runTokens: 'total {tokens}',
  },
  composer: {
    send: 'Send',
    stop: '■ Stop',
    // issue #261B：上一条发送以失败终局收场时的一键重发（中英双语同口径）。
    retry: 'Retry last',
    // issue #370: two ways to speak while a run is in flight.
    placeholderRunning: 'Type while it runs — Enter steers, Option/Alt+Enter queues',
    steer: 'Steer',
    steerHint: 'Finish the current round, then continue with this message (in-flight tool calls complete first) · Enter',
    followUp: 'Queue',
    followUpHint: 'Send this after the current task finishes normally, in order · Alt+Enter',
    hintEnterSend: 'send',
    hintEnterSteer: 'steer',
    hintAltFollowUp: 'queue',
    hintShiftNewline: 'newline',
    hintSlash: 'commands',
    hintAt: 'mention file',
  },
  // issue #370: pending-input queue bar (components/QueuedInputsBar.vue)
  queued: {
    count: '{n} pending',
    steerCount: '{n} steer',
    followUpCount: '{n} queued',
    expand: 'Expand',
    collapse: 'Collapse',
    recall: 'Recall all',
    recallHint: 'Put every queued message back into the input box (recalled text first, existing draft after)',
    // Keys are the server's machine codes, referenced as `queued.blocked.<code>`:
    // the server sends codes, the client owns the wording (#294).
    blocked: {
      container_not_running: 'Container not running — queue paused (resumes automatically)',
      deliver_failed: 'Last delivery failed — queue paused, recall and resend',
    },
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
    download: 'Download',
    downloadInstead: 'Download this file',
    notPreviewable: 'This format cannot be previewed online',
    pdfUnsupported: 'This browser cannot display the embedded PDF; download it and open locally',
  },
  // Preview port panels (issue #246 delivery ②, ticket B: workbench section + admin FDE pane).
  // Contract red line (portal.md §4.7a): `active` only means “the first credential was admitted” ⇒
  // state wording never claims healthy/running; server error.message passes through verbatim.
  previewPorts: {
    title: 'Preview ports',
    adminTitle: 'Preview ports of {fde}',
    // workbench disclosure bar (issue #308: now at the bottom of the left sidebar, an independent
    // toggle next to the directory tree; the collapsed state must still convey something useful)
    // 双面板拆分（用户裁定）：端口池=地址维度、进程监听=事实维度，各自按项目分组。
    poolToggle: 'Port pool',
    poolToggleCount: 'Port pool ({count})',
    poolToggleFailed: 'Port pool (failed to load)',
    procToggle: 'Process listeners',
    procToggleCount: 'Listeners ({count})',
    procEmpty: 'No project processes are listening.',
    spareGroup: 'Spare ({count})',
    currentBadge: 'Current',
    colPort: 'Port',
    colHostname: 'Preview host',
    colState: 'State',
    colActions: 'Actions',
    openAction: 'Open preview',
    signing: 'Issuing ticket…',
    // issue #247: open the whole group at once (one click = sign + open; no confirmation dialog,
    // because tickets expire in 60 seconds)
    // issue #256 delivery 2: when 429/503 carries Retry-After, say how many seconds to wait
    // issue #286: human-facing cookie notice (the edge stripping Cookie is by design, not a bug;
    // agents inside the workspace are told by rule 7 in the container's ~/AGENTS.md, humans are told here)
    hostnameCopyTitle: '{url} (click to copy the full URL)',
    copiedUrl: 'Preview URL copied to clipboard.',
    copyFailed: 'Copy failed: ',
    state: {
      // allocated = assigned but never admitted; active = first credential was admitted once
      allocated: 'Allocated · not opened yet',
      active: 'Admitted once (first admission only)',
    },
    stateUnknown: 'Unknown state ({state})',
    // issue #308: short labels for the compact sidebar variant (variant='list', ~163px wide);
    // the full wording stays in state.* and is reachable via the same element's title/aria-label.
    stateShort: {
      allocated: 'Not opened',
      active: 'Admitted',
    },
    stateShortUnknown: 'Unknown',
    // 人侧文案面向不懂技术的业务用户：不出现端口/进程/监听这类词（口径与 zh-CN 一致）。
    // 观测层 MVP（迁移 0022）：真实运行注解；无注解的行不渲染任何反向文案（null ≠ 空闲）。
    observedTitle: 'Program using this address',
    observedUptime: 'up {ago}',
    duplicateWarn: '⚠ {cwd} is open on both {ports} at the same time — likely two versions coexisting. Check which one you want (leftovers from ended tasks do not close themselves).',
    unroutedNote: 'This app cannot be opened at a preview address yet — ask your assistant to move it to an assigned port.',
    stateHint: '“Admitted once” only means the first credential was admitted; it does not mean an app is listening in the container.',
    emptySelf: 'You have no preview ports yet (the platform has not assigned a block, or all of them were released).',
    emptyFde: 'This FDE has no live preview ports (not onboarded yet, or already offboarded).',
    loadFailed: 'Failed to load preview ports ({code}): {message}',
    ticketFailed: 'Failed to issue the preview ticket ({code}): {message}',
    // issue #256 delivery 2: same for the single-ticket 429
    ticketFailedRetry: 'Failed to issue the preview ticket ({code}): {message} (retry in about {seconds}s)',
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
      // issue #350: the block-move card links to the pool usage overview (reference only: this panel
      // never pre-fills the input or auto-submits just because a block looks free)
      usageRefHint: 'Check the pool usage overview before picking a block: which blocks are taken and by whom, and which are completely free.',
      usageRefLink: 'Open the pool usage overview',
      occupancyTitle: 'This block in the latest snapshot:',
      occupancyOccupied: 'in use (held by: {names}; {count} live ports) — the server rejects the move (409), pick another block.',
      occupancyOccupiedNoCount: 'in use (held by: {names}) — the server rejects the move (409), pick another block.',
      occupancyOccupiedNoNames: 'in use (holder not given; {count} live ports) — the server rejects the move (409), pick another block.',
      occupancyOccupiedBare: 'in use (holder and live port count not given) — the server rejects the move (409), pick another block.',
      occupancyFree: 'completely free (it is in the latest snapshot’s free list).',
      occupancyUnknown: 'unknown whether this block is free: it is not in the latest snapshot’s free list (that list is truncated), so the server check decides.',
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
      previewPool: 'Pool usage',
    },
    // issue #350: preview port pool usage overview (views/PreviewPoolUsageView.vue). Read-only:
    // no write action, no "use this block" button, and it never touches the block-move input.
    previewPool: {
      title: 'Preview port pool usage',
      intro: 'Read-only snapshot: which blocks are taken and by whom, and which blocks are completely free. Check here before picking a block for an FDE instead of trial and error.',
      loading: 'Loading pool usage…',
      notLoaded: 'Pool usage not loaded yet (no request has been made).',
      poolRange: 'Pool {start}–{end}: {size} ports per block, {total} blocks in total.',
      poolMissing: 'The server did not return the pool bounds (pool is missing): this page only shows the numbers it did return and never infers block boundaries.',
      summaryTitle: 'Summary (counted in blocks)',
      summaryTotal: 'Total blocks',
      summaryFree: 'Fully free',
      summaryPartial: 'Partially used',
      summaryOccupied: 'Fully taken',
      unknownValue: '—',
      occupiedTitle: 'Blocks in use ({count})',
      occupiedEmpty: 'The server reports no block in use.',
      occupiedMissing: 'The server did not return the list of blocks in use (occupied_blocks is missing).',
      occupiedCount: '{count} live ports',
      occupiedCountUnknown: 'live port count not given',
      occupiedBy: 'Held by: {names}',
      occupiedByUnknown: 'holder not given',
      freeTitle: 'Fully free blocks ({count} listed)',
      freeEmpty: 'The server reports no fully free block.',
      freeMissing: 'The server did not return the free block list (free_blocks is missing).',
      freeMore: 'Only the first {shown} blocks are listed and there are more (server limit={limit}): do not assume these are all the free blocks left.',
      freeMoreNoLimit: 'Only the first {shown} blocks are listed and there are more: do not assume these are all the free blocks left.',
      partialTitle: 'Careful: {count} blocks are partially used — avoid them when picking a block',
      partialBody: 'These blocks already hold between 1 and “ports per block − 1” live ports, so they are not free (and are not listed as free). Pick another block when relocating, otherwise the server returns 409.',
      inconsistent: 'The numbers returned by the server contradict each other ({issues}): this page shows them as-is, do not pick a block from them.',
      issueSep: '; ',
      issue: {
        total: 'total blocks ≠ free + partial + fully taken',
        occupiedList: 'the block-in-use list is longer than the occupied count',
        freeList: 'the free block list is longer than the free count',
        hasMore: 'has_more=true but the free count is not greater than the number of listed items',
      },
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
      colMaxTokens: 'Max output tokens',
      // #309: these keys serve exactly one field, `max_output_tokens` (one spelling on our side).
      // The list column shows the **effective** value the backend computed (1/4 of the window when unset).
      colMaxOutputTokens: 'Output budget cap (tokens)',
      // #314: "blank = no change" has to be spelled out, together with the create/edit asymmetry
      // (create sends an explicit `null`, edit omits the field) — that asymmetry is the confusion source.
      maxOutputTokensHint: 'The engine uses this as the output budget cap for a single response. Cap = 1/4 of the context window (validated by the server; anything above is rejected). On create, leaving it blank means the field is not sent at all (not "no change" — there is nothing to keep yet); the backend then assumes 1/4 of the window and ships that as the effective value.',
      editMaxOutputTokensHint: 'Blank = no change (the edit form sends a PATCH, so a blank field is simply omitted). Cap = 1/4 of the context window; the server rejects anything above it. The list always shows the effective value (1/4 of the window when nothing was configured).',
      maxOutputReset: 'Reset to 1/4 of the window',
      maxOutputResetHint: 'Fills the box above with "1/4 of the current window". It only fills the value — it does not save (the real gateway cannot clear this field, #314; to stop overriding, reset and then save).',
      maxOutputResetNeedsWindow: 'No window entered, so 1/4 cannot be computed — fill the context window first.',
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
      editMaxTokensHint: 'Leave blank to keep the current value.',
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
    // issue #281：与 zh-CN 成对（localeParity 钉住两份键集一致）。
    workspaceLoadFailed: 'Failed to initialize the workspace: {message} (refresh to retry; contact your admin if it keeps failing)',
    createSessionFailed: 'Failed to create session: {message}',
    stopFailed: 'Failed to stop: {message}',
    dirNameInvalid:
      'Directory names may only use lowercase letters, digits, underscores and hyphens; they must not start or end with a hyphen or underscore; max 63 characters. Directories that already exist in the container (even with other characters) can be selected directly from the directory dropdown.',
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
  gitLight: {
    loading: 'Checking…',
    partialBadge: 'partial',
    panelAria: 'Git wrap-up light details',
    noRepos: 'No git repository found in this directory.',
    label: { red: 'Not saved', yellow: 'Not pushed', green: 'Wrapped up', grey: 'Unchecked' },
    reason: {
      uncommitted: 'There are changes that are not committed',
      untracked: 'There are files git does not know about yet (untracked)',
      no_commits: 'The directory has content but not a single commit',
      unpushed_or_diverged: 'Commits are not pushed (or the branch diverged)',
      no_remote: 'No remote configured: the commits exist only on this machine',
      no_upstream: 'The current branch has no remote-tracking branch',
      never_fetched: 'A remote exists but was never fetched, so pushed-ness is unknown',
      detached: 'Detached HEAD (not on any branch)',
      synced: 'Committed and matching the remote as your machine knows it',
      no_repo: 'This directory is not a git repository (nothing is protected)',
      covered_by_outer_repo: 'No standalone repository found (an outer repository owns the work tree)',
      empty: 'The directory is empty',
      unchecked_partial: 'The check is not finished',
      unchecked_failed: 'Some repositories were not judged',
      busy: 'A repository is busy (its git index is held)',
      unreadable: 'A repository could not be read',
      git_unavailable: 'The server has no git, so uncommitted and untracked cannot be judged',
      shell: 'The root is only a shell; the real repositories live inside it',
      unknown: 'Unknown (the server reported a state this UI does not know)',
    },
    tip: {
      partial: 'This result is incomplete: anything unchecked counts as unknown, not as wrapped up.',
      truncatedRepos: 'Too many repositories: {count} more directories were not checked.',
      gitUnavailable: 'The server has no git, so uncommitted and untracked cannot be judged.',
      greenHonest: 'Green means matching the remote as your machine knows it; pushes your colleagues made that you have not fetched stay invisible here.',
      error: 'This check failed (HTTP {status} / {code}); showing the previous result.',
      checkedAgo: 'Checked {ago} ago.',
    },
    row: {
      shellNote: 'Shell directory: the real repositories live inside it.',
      counts: '{tracked} changed / {untracked} untracked files.',
      truncated: 'Too many changes; only the first 50 entries were counted.',
    },
    action: {
      finish: 'Let the AI wrap up',
      ask: 'Ask the AI',
      refresh: 'Check again',
      finishHint: 'This only fills the composer, it does not send for you (sending starts a run).',
    },
    prefill: {
      thisDir: 'this directory',
      moreSuffix: ' (and {count} more not listed)',
      finish: '[Wrap up] Please get these repositories committed and pushed: {repos}{more}. Include untracked files in git add (do not skip them); when a directory holds several repositories, commit each one separately (the parent repository does not contain the child ones); push wherever a remote exists, and ask me before inventing a remote or upstream.',
      ask: '[Wrap-up check] The git light for this directory reports "{state}: {reason}" (cwd: {cwd}). Please go repository by repository: what is not yet protected by git, what that costs, and the exact steps to wrap up (commit / push / set up a remote).',
    },
  },
} as const satisfies MessageSchema;
