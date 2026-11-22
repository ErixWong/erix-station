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
    workbenchEntrySeatlessAdmin: 'This is a platform administrator without a workstation — the workbench has nothing for it. Please sign in at the admin console.',
    goToAdminConsole: 'Go to the admin console →',
    adminEntryFdeOnly: 'This account is not an administrator and cannot sign in here. Use the workbench link above.',
    adminEntryNotice: 'This is the admin console entry (administrators only). Sign-in state is not shared between the two entries (by design), so each entry needs its own sign-in.',
    adminEntryWorkbench: 'Go to the FDE workbench →',
    title: 'Sign in to FDE Station',
    loginName: 'Login name',
    password: 'Password',
    next: 'Next',
    totpHint: 'Enter the 6-digit code from your authenticator app (two-step sign-in for local accounts).',
    totpLabel: 'TOTP',
    totpSubmit: 'Verify & sign in',
    backToLogin: '← Back to login',
    // issue #449: the other second-factor channel — email verification code (portal.md §2.2/§2.3a/§2.3b).
    // Wording: only “second factor (email code)”; never claim “strong two-factor” or “phishing-resistant”.
    emailStepTitle: 'Enter your email code',
    emailStepHint: 'A code was sent to {email} (second factor). If it does not arrive, you can resend it.',
    emailCodeLabel: 'Verification code',
    // 2026-11-10: the validity window is shown on the login page; the number comes from the server
    // (`email_code_ttl_seconds`, overridable via `EMAIL_CODE_TTL_SECONDS`) — never hard-code 10 here.
    emailCodeTtl: 'The code is valid for {minutes} minutes.',
    emailCodeSubmit: 'Verify & sign in',
    emailResend: 'Resend code',
    emailResendIn: 'Resend in {seconds}s',
    emailResendFailed: 'Send again',
    emailBackToPassword: '← Back to the previous step',
    // issue #449 second-factor choice (`second_factor_choice`): the switch, and the notice shown when the
    // email channel is down. feat-261110-01 dropped the two inline links (`useEmailCode` / `useTotp`) in
    // favour of a real two-option switch. Wording: name the channel only (no strength claims), and reuse
    // `emailStepHint` for “a code was sent” rather than inventing a near-duplicate key.
    factorSwitchLabel: 'Second factor method',
    factorTotp: 'Authenticator app',
    factorEmail: 'Email code',
    // Lazy send (feat-261110-01): the first code goes out only when this tab is picked, so say what the wait is.
    emailSending: 'Sending a code…',
    emailChannelUnavailable: 'Email is unavailable right now — please use your authenticator app.',
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
    // issue #595: header entry to the capability market (views/MarketView.vue, route #/market).
    marketEntry: 'Market',
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
    // issue #488: hide a session. **D1: the UI only ever says "hide" — no "delete" wording** (button
    // tooltip, aria-label, confirm copy and the key names all count): the backend DELETE
    // /api/sessions/:id only sets status='archived' and no ledger row is touched, so "delete" would lie.
    hide: 'Hide',
    hideBusy: 'Hiding…',
    hideConfirm: 'Hide this session?',
    hideConfirmOk: 'Confirm hide',
    // **D2: this is the only recovery hint, not decoration** — there is no unarchive endpoint in the
    // whole repo and listSessions has no include_archived, so a hidden session cannot be brought back
    // from the UI. That consequence has to be readable before the request goes out.
    hideConfirmNote: 'Once hidden it stops showing up in this list and cannot be brought back here; contact your administrator to restore it.',
  },
  tree: {
    title: 'Directory tree',
    selectDirFirst: 'Select a directory first',
    // issue #472: upload (`POST /api/files/upload`). Same eight entries as zh-CN (locale parity is a test).
    upload: {
      button: 'Upload',
      hint: 'Upload files into the current directory (an admin must enable “File upload” for this account)',
      busy: 'Uploading…',
      success: 'Uploaded {count} file(s)',
      allSkipped: 'Nothing uploaded (declined to overwrite {count} existing file(s))',
      overwriteConfirm: '“{name}” already exists. Overwrite it with the uploaded version? (Overwriting discards what is on disk)',
      errDisabled: 'This account may not upload files: ask an admin to enable “File upload” in the user editor.',
      errTooLarge: 'The file exceeds the per-file size limit (FILE_UPLOAD_MAX_BYTES).',
      errInterrupted: 'The upload was interrupted (network or tab switched). Just retry.',
      errNoDir: 'The target directory is gone: refresh the directory tree first.',
      errGeneric: 'Upload failed (HTTP {status}).',
    },
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
      // issue #440: the first two of the **three states** (data comes from the ledger's `foldedFacts`, not
      // from `hasSummary`). The first state must say "LLM semantic summary" out loud: `fold-llm` writes the
      // literal `"missing"` into `record.summary`, so the old copy claimed "this fold produced no summary"
      // while the ledger held a 2048 B semantic summary — that is exactly the #440 symptom.
      visibilityLlm: '{n} rounds of original text are no longer visible to the model; what remains is an LLM semantic summary (fold-llm) — use “View original” for the full detail.',
      visibilityLlmBare: 'This original text is no longer visible to the model; what remains is an LLM semantic summary (fold-llm) — use “View original” for the full detail.',
      // Second state: mechanical substitute only (fold-statistical). Say plainly that there is no LLM
      // semantic summary; do not dress the mechanical substitute up as one.
      visibilityMechanical: '{n} rounds of original text are no longer visible to the model; only a mechanical substitute (fold-statistical) remains — no LLM semantic summary. Use “View original” for the detail.',
      visibilityMechanicalBare: 'This original text is no longer visible to the model; only a mechanical substitute (fold-statistical) remains — no LLM semantic summary. Use “View original” for the detail.',
      // The "summary was clamped" marker (ledger `truncated:true`) rides on the same line: no new UI.
      summaryTruncated: ' (the summary was too long and has been clamped; use “View original” for the full text.)',
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
    // #451 (compactionStats observability): the session-header CUMULATIVE compaction line.
    // Separate from the line above on purpose: that `folded` counts DTO messages carrying a `folded`
    // field, this counts the engine's per-round layer stats — different denominators, so they must
    // not be glued into one number. Wording pins two things: it is cumulative for THIS SESSION (not
    // this run), and compaction is normal work, not a failure (no red, no warning).
    sessionCompactionSummary: 'Session compaction: {parts}',
    sessionCompactionLayer: '{layer} ×{count}',
    sessionCompactionLayerSaved: '{segment} (saved {saved} tokens)',
    sessionCompactionHintTitle: 'Aggregated over {rounds} rounds; last one at round {last}',
    sessionCompactionHintTitleNoRound: 'Aggregated over {rounds} rounds',
    sessionCompactionLayers: {
      ttl: 'TTL',
      slidingWindow: 'window',
      foldStatistical: 'statistical',
      foldLlm: 'strategy',
      anchors: 'anchors',
      enforceSize: 'size cap',
    },
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
      // issue #502 form M (#278 floor): this run kept **no text at all** (no assistant anchor, both
      // `round_end.final_text` and `run_end.partial_text` empty) ⇒ the history projection emits a
      // placeholder item and the UI shows one **neutral** line instead of an empty bubble.
      placeholder: 'The text of this output was not retained (not persisted when the run stopped); the terminal state follows below.',
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
      // issue #502 form M: the key `partialOutputLost` here was **deleted on purpose**. The SSE
      // snapshot frame no longer carries placeholders (the backend emits no frame at all when the
      // buffer is empty), so that separator row could never fire again; the "text was not retained"
      // line now comes from the history projection → `stream.partialOutput.placeholder`.
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
      resumeJournalSkipped: '{count} tool result(s) from the crash round (round {round}) were not written to the ledger; the next resume relies on the ledger (run snapshots were retired in #640)',
      resumeJournalSome: 'some',
      // issue #438 slice B (erix-agent 0.29.0): the two display-class diagnostics the LoopEvent union
      // grew. Missing numbers are already normalised to "?" by the caller (#283); foreign identifiers
      // go through the shape gate (#261). This text must not invent a number.
      compactionDeferred: 'compaction deferred this round: the request tail is an assistant tool_use without its tool_result (round {round}, {reason}); the next round folds it',
      budgetBelowWorkingSet: 'still over budget after folding: working set {workingSet} tokens > budget {budget} tokens ({attempts} consecutive attempts), so this run ends early; the engine suggests budget >= {suggested}',
      // issue #442 (erix-agent 0.30.0): the only new LoopEvent type this host puts on the timeline. It is
      // the sole attribution signal for the upstream 400 that may follow, so it renders as a neutral
      // separator (not an error line: "the request was sent unchanged" is not "this round failed").
      userTurnGuardUnrecoverable: 'the request view still has no user turn (every fallback failed, round {round}, {channel}/{reason}): the request was sent unchanged and the upstream may reject it',
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
      // issue #442 (erix-agent 0.30.0): `compactionDegraded` ("summary degraded: {kind}") is **gone** —
      // the engine no longer produces `foldSummary.degradeKind` (a failing summarizer is now a terminal
      // error, see `runErrorCode.summarizerFailed` below).
      compactionBudgetExhausted: 'summary budget exhausted (no self-heal retry)',
      compactionInputClipped: 'summary input clipped ({rounds} rounds / {messages} messages dropped; written from incomplete material)',
      compactionTruncated: 'summary truncated at the output budget',
      finalGuard: 'final guard: {action}{dash}',
      forcedFinal: 'forced final (round {round}): {reason}',
      // issue #442 (erix-agent 0.30.0 / upstream #476): neutral marker for "the final text is the
      // engine's own fallback, not model output" (`termination.finalTextFallback === true`).
      // Deliberately neutral (never the red `.syserr` face): it is not a failure.
      finalTextFallback: '(no final text was produced: the text above is the engine fallback, not model output)',
      // issue #243 (step 3): the final text is a **textualized tool call** (the model emitted the
      // tool call into `content`, the engine took it as the final answer ⇒ the run finished fine but
      // the deliverable never landed). Wording is a **status word, not an alarm**: no "warning /
      // failed / error", and it renders on the neutral `.roundsep` line, never in red.
      // `{dash}` is the matched feature fragment (`stream.event.dash`) — **empty when absent**, so the
      // sentence has to stand on its own.
      toolCallTextualized: 'the model wrote the tool call into its answer text; that call never actually ran{dash}',
      runEnd: 'run ended: {reason}{usage}',
      runEndNormal: 'completed normally',
      missedRunEnd: 'This run ended while the connection was interrupted (see run history)',
      runFailed: 'run failed: {code} — {message}',
      // issue #442 (erix-agent 0.30.0 / upstream #661): run-level error code → plain language. The code
      // table lives in `lib/terminationReasons.ts#RUN_ERROR_CODE_LABELS` (same file as
      // `RUN_RETRYABLE_ERROR_CODES`, single source); this block only holds the copy.
      runErrorCode: {
        summarizerFailed: 'the compaction summarizer failed, so this run failed (this is not a degraded summary: the context was not compacted; retry)',
      },
      // issue #212: user-readable labels for the surfaced fail reasons (keys are the raw
      // engine reason strings, not camelCase, so they line up 1:1 with RUN_END_LABEL_REASONS in
      // lib/terminationReasons.ts). issue #236: **every reason except `end_turn`** has a label
      // (`end_turn` keeps `runEndNormal`); #212's "existing failed / aborted / max_rounds_cap keep
      // passing the raw enum through" is superseded by #236 (a stopped run must read as native
      // language, and the termination separator is now projected into history for every reason).
      // Unknown/future engine reasons stay out of this table ⇒ the raw reason is shown (§5.3).
      runEndReason: {
        // the ledger never reached the store (transcript round / run-state write failed) ⇒ crash
        // recovery may replay tool side effects. Wording updated with issue #640 (there is no run
        // snapshot since erix-agent 0.33.0); the reason enum and its red severity are unchanged.
        persistence_failed: 'run ledger not persisted (side effects may repeat on resume)',
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
  // Sub-run (delegation) read-only drawer + tool card (issue #delegate P3).
  // Key set = the 7 `DELEGATE_ROSTER_STATES` values + `unknown` (missing/dirty state);
  // badge grading lives in `delegateBadgeKind`, this file only holds copy. `viewerTitle` takes `{id}`.
  delegate: {
    openViewer: 'View sub-task',
    closeViewer: 'Close sub-task',
    viewerTitle: 'Sub-task {id}',
    refresh: 'Refresh',
    polling: 'Running, refreshing automatically',
    truncated: 'Only the most recent entries are loaded; older records are not included',
    viewer: {
      starting: 'The sub-task is starting, no output yet',
      empty: 'This sub-task left no output',
      error: 'Failed to load the sub-task output',
      // issue #602: the parent run has ended while the roster still says live (a background child dies
      // with the parent process, so `finishRun` never runs). That means "status unknown" — it is **not**
      // a failure (same rule as `activity.staleParentEnded`), so this line carries no ⚠ and no red.
      parentEnded: 'The parent run has ended, so the sub-task status is no longer updated (actual state unknown)',
    },
    state: {
      queued: 'Queued',
      running: 'Running',
      completed: 'Completed',
      failed: 'Failed',
      aborted: 'Aborted',
      timeout: 'Timed out',
      interrupted: 'Interrupted',
      unknown: 'Unknown state',
    },
    // issue #592: live sub-task badge (tail of RunStatusBar) + expanded panel (below it).
    // State wording is **reused** from `state.*` above; `{count}` here is the number of **live**
    // children (same ruler as `lib/delegate.ts#DELEGATE_LIVE_STATES`; terminal ones don't count).
    activity: {
      title: 'Sub-tasks {count}',
      // "cannot read" and "there are none" need different wording (badge degraded state;
      // design §4.2 last paragraph + the D9 rule).
      titleUnknown: 'Sub-tasks ?',
      toggleUnknown: 'Show or hide the sub-task panel (status temporarily unavailable)',
      panelTitle: 'Sub-tasks {count}',
      toggle: 'Show or hide the sub-task panel ({count} running)',
      hint: 'Refreshes every 2s; shows only sub-tasks dispatched by the current run',
      collapse: 'Collapse',
      // 行里前面已经有一个状态词（`delegate.state.running` = "Running"），所以这里**不许**再说
      // "running"（真机上渲染成 `Running running 20.0s`）；中文那份是 `已跑 {dur}`，无此问题。
      elapsed: 'for {dur}',
      view: 'View',
      viewAria: 'View sub-task {id}',
      unreadable: 'Sub-task status is temporarily unavailable',
      // The roster still says live while the parent run already ended (a background child dies with the
      // parent process, so `finishRun` never runs). It means "status unknown" — not failed, not running.
      staleParentEnded: 'Parent run has ended; status unknown',
    },
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
    // #468 addendum A: the port-pool panel is retired (the user only wants pool size / idle count on the
    // listener toggle), so poolToggle / poolToggleCount / poolToggleFailed are gone with it.
    procToggle: 'Process listeners',
    procToggleCount: 'Listeners ({count})',
    // #468 D8: pool usage on the disclosure bar — pool size first, idle second (user's example `10/8`).
    // Not rendered while unloaded or on error, so there is deliberately no "failed" variant here.
    poolUsage: 'Port pool {total}/{idle}',
    poolUsageTitle: '{total} ports in the pool, {idle} of them idle (nothing is listening)',
    procEmpty: 'No processes are listening in the current project.',
    spareGroup: 'Spare ({count})',
    // #468 D2: observations whose project root cannot be derived (cwd in ~ // /tmp, or unreadable across uids)
    // get their own group instead of being dropped.
    unknownGroup: 'Unknown project ({count})',
    // #468: full wording behind the amber "!" on each row of the unknown-project group.
    unknownMarkTitle: 'This process does not belong to the current project',
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
    // #468 D7: no CAP_SYS_PTRACE + Yama ⇒ pid/cwd/cmd/branch are all unreadable across uids;
    // the row says this instead of rendering blank.
    observedOpaque: 'Process details unreadable (cross-user)',
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
  // Capability market, user side (views/MarketView.vue, issue #595;
  // contract docs/design/capability-market.md §8). Copy rule (§8): no red/yellow/green --
  // "installed but disabled" is neutral grey text, not a warning.
  market: {
    title: 'Capability market',
    backToWorkbench: '← Back to workbench',
    reload: 'Reload',
    loading: 'Loading the market catalogue…',
    empty: 'No published entries yet (skill packages or MCP servers).',
    intro: 'Published skill packages and MCP servers. Install one into your FDE workspace; ' +
      'only enabled ones reach the model tool surface.',
    budgetHint: 'Every enabled skill ships all of its tools into every single turn:' +
      ' one FDE can enable at most {max} at a time.',
    footnote: 'Uninstalling or disabling never re-downloads (disabling only flips a flag);' +
      ' if you edited files in the package, "Reinstall" writes them back.',
    version: 'version {version}',
    tools: 'tools: {count}',
    securityScore: 'security score: {score}',
    scanHints: '{count} static scan hints',
    // #608 §8.3: kind / admission reason / MCP-specific display copy (shared by user side + admin).
    kind: {
      skill: 'Skill package',
      mcp: 'MCP server',
      unknown: 'Unknown kind',
    },
    reasonLabel: 'admission reason: {reason}',
    reason: {
      stateful: 'Stateful: the connection or session spans turns, so it cannot be a one-shot function',
      tool_surface_gt_12: 'Tool surface above 12: flattening it into context eats a whole budget slice',
      shared_quota: 'Shared quota: upstream rate limits/billing are shared team-wide and must be held platform-side',
      credential_boundary: 'Credential boundary: the secret must never reach skill code, only platform injection',
      unknown: 'an admission reason not on our list',
    },
    mcp: {
      // §8.2: required slots missing -> enable disabled, with the reason on the card (users cannot set values).
      secretsPending: 'Waiting for an admin to set the credentials',
      exposureLabel: 'exposure: {exposure}',
      exposure: {
        direct: 'expanded directly (the model calls each tool)',
        deferred: 'through the gateway (search first, then call; default)',
        hidden: 'hidden (installed but inert)',
        unknown: 'unknown exposure',
      },
      toolsUnknown: 'tool count unknown (no FDE has reached this server yet)',
    },
    driftHint: 'Installed {installed}, market version {version}: reinstall to overwrite.',
    installed: {
      notInstalled: 'Not installed',
      installedDisabled: 'Installed · disabled',
      installedEnabled: 'Installed · enabled',
    },
    install: 'Install',
    reinstall: 'Reinstall',
    uninstall: 'Uninstall',
    enable: 'Enable',
    disable: 'Disable',
    busy: 'Working…',
    state: {
      draft: 'Draft',
      published: 'Published',
      retired: 'Retired',
      unknown: 'Unknown state',
    },
    result: {
      installed: 'Installed {name}; it is usable from the next run once enabled.',
      reinstalled: 'Reinstalled {name}.',
      uninstalled: 'Uninstalled {name} (package directory removed).',
      enabled: 'Enabled {name}; effective from the next run.',
      disabled: 'Disabled {name}; files stay, re-enabling needs no download.',
    },
    detail: {
      open: 'Details',
      close: 'Close',
      loading: 'Loading details…',
      whenToUse: 'When to use',
      tools: 'Tools',
      toolsUnknown: 'No tool list supplied by the server.',
      params: 'parameters: {params}',
      readme: 'SKILL.md body',
      readmeMissing: 'This package ships no SKILL.md.',
      files: 'File list',
    },
    errors: {
      notFound: 'This entry is no longer in the market (possibly retired): reload the list.',
      notPublished: 'This entry is not published right now, so it cannot be installed' +
        ' -- an admin has to publish it first.',
      budgetExceeded: 'Enable limit reached: one FDE can enable at most {max} skills at a time.' +
        ' Disable one before enabling this one.',
      kindUnsupported: 'MCP entries are not supported in P0 (no MCP client on the runner side)' +
        ' -- browse only, no install.',
      installFailed: 'Install failed: {reason}',
      reasonUnknown: 'no reason given',
      validationFailed: 'Invalid input: the server named the field {field}.',
      validationGeneric: 'Invalid input: the server did not name a field.',
      // The five new codes of #608 §7.3 (none left unmapped).
      reasonRequired: 'Admission reason missing: an MCP entry has to say why it needs the MCP channel.',
      slotInvalid: 'Invalid slot combination: {combo} is not in the matrix (stdio only takes env, http only takes header).',
      secretMissing: 'Cannot enable: these slots have no value set yet ({slots}).',
      packageShape: 'The skill package matches a forbidden shape: {shape} (resident-style shapes are not accepted in P1).',
      generic: 'Request failed (HTTP {status}): {message}',
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
      mail: 'Mail channel',
      tls: 'Certificates',
      previewPool: 'Pool usage',
      // issue #485 slice A: upload limit (views/AdminUploadView.vue, contract docs/api/portal.md §4.15).
      // Sits after certs and before the read-only pool view: it is platform configuration.
      upload: 'Upload limit',
      // issue #596 片 B: platform prompts page (views/AdminPromptsView.vue, contract
      // docs/api/portal.md §4.19). Order upload → prompts: both are platform settings that used
      // to require rebuilding station-portal.
      prompts: 'Prompts',
      // issue #677 P2b: runtime settings list (views/AdminRuntimeSettingsView.vue, contract §4.21).
      // Right after prompts: upload / prompts / runtime are all platform settings that used to
      // require rebuilding station-portal.
      runtime: 'Runtime settings',
      // issue #595 M2: capability market console (views/AdminMarketView.vue, contract §7 admin API).
      // After the upload limit and before the read-only pool view: it is platform configuration.
      market: 'Capability market',
      // issue #586: About (the three version cells, read-only); views/AdminAboutView.vue.
      about: 'About',
      // issue #650: "System" (host CPU / memory / disk / container counts, read-only); views/AdminSystemView.vue.
      // After the capability market and before the pool usage view: both are read-only host snapshots (issue §tab order).
      system: 'System',
      // issue #528 (event platform W5): admin tabs for macro templates / macro runs (`07` §21.1 key table).
      macros: 'Macro templates',
      macroRuns: 'Macro runs',
    },
    // Capability market, admin console (views/AdminMarketView.vue, issue #595 M2;
    // contract §7 admin API + §8 admin UI).
    market: {
      title: 'Capability market',
      intro: 'Publish and maintain skill packages: metadata plus a multi-file bundle.' +
        ' Whether the bundle is legal is decided by the server.',
      footnote: 'The static scan is advisory, not a gate (§3): a low score blocks neither publishing' +
        ' nor installing. Hard path/byte/count checks live in the server (validateBundle);' +
        ' this page only blocks obviously wrong paths.',
      loading: 'Loading entries…',
      empty: 'No entries yet: use "Publish new entry".',
      reload: 'Reload',
      filterLabel: 'State',
      filterAll: 'All',
      colState: 'state',
      colSlug: 'slug',
      colVersion: 'version',
      colInstalls: 'installs',
      colScore: 'score',
      colActions: 'actions',
      publish: 'Publish',
      retire: 'Retire',
      edit: 'Edit',
      detail: 'Details',
      close: 'Close',
      detailLoading: 'Loading details…',
      files: 'File list',
      filesUnknown: 'No file list supplied by the server.',
      scanScore: 'static scan: {score}',
      scanClean: 'The scan reported nothing.',
      scanHintCount: '{count} hints',
      createTitle: 'Publish new entry',
      editTitle: 'Edit entry',
      submitCreate: 'Publish',
      submitSave: 'Save',
      cancel: 'Cancel',
      fKind: 'entry kind *',
      kindHint: 'A skill package is a one-shot function call (it ships a bundle); an MCP entry is stateful (declaration + slots only, no bundle).',
      toolsCacheTitle: 'Tool list (filled by the runner)',
      toolsCacheEmpty: 'No FDE has reached this server yet: the list appears after the first "mcp list" fills the cache.',
      toolsCacheAt: 'cache filled at: {at}',
      // #608 §8.1: the credentials block of the detail panel. Write-only (§3.1) -- no "show value" copy exists.
      secrets: {
        title: 'Credentials',
        hint: 'Write-only: this block shows whether a value exists; the platform never reads it back to you.',
        loading: 'Reading the slot declarations…',
        noSlots: 'This entry declares no configuration slots.',
        set: 'Set',
        setTitle: 'Set credential: {name}',
        setHint: 'The field always starts empty (the old value cannot be read back); saving only tells you "set".',
        valueLabel: 'new value',
        valueHint: 'Submitting it empty deletes the slot value (§7.2: null = delete), it does not store an empty string.',
        scopeLabel: 'scope',
        scopeGlobal: 'global (shared by every FDE)',
        scopeFde: 'one FDE',
        fdeLabel: 'FDE id (uuid)',
        save: 'Write',
        hasValue: 'Set',
        missing: 'Not set',
        setResult: '{name} is set (the value is not echoed back).',
        cleared: 'The value of {name} was deleted.',
        kind: {
          config: 'config (not secret)',
          secret: 'secret (encrypted at rest)',
        },
      },
      // The MCP field group of §8.1 (only rendered when kind='mcp').
      form: {
        mcp: {
          title: 'MCP connection declaration',
          transport: 'transport',
          transportHint: 'stdio spawns a child process inside the FDE; http connects to a remote MCP endpoint. It also locks the slots\u2019 inject value.',
          command: 'command (stdio executable)',
          commandHint: 'Program name only (e.g. npx); every argument goes into the box below (the server rejects a command containing spaces).',
          args: 'args (one per line)',
          argsHint: "e.g. -y and {'@'}modelcontextprotocol/server-github on separate lines (spaces inside a line are kept).",
          url: 'url (http endpoint)',
          urlHint: 'e.g. https://srch.erix.vip/mcp; the scheme and reachability are the server\u2019s call (portal never connects itself).',
          exposure: 'exposure',
          exposureHint: {
            direct: 'direct: tools are expanded into standalone tools the model can call right away (saves one search round-trip), but each costs ~200 tokens per turn and the direct budget holds at most 8.',
            deferred: 'deferred (default): only the gateway tool appears; the model must search for the schema before calling; zero context cost.',
            hidden: 'hidden: the entry is not materialized at all (P1 has no approval channel, so dangerous tools can only be marked this way -- installing equals disabling).',
          },
          lifecycle: 'lifecycle',
          lifecycleHint: 'In P1 both values behave the same (lazy start inside the run, stopped when it ends); run-keep-alive is a field reserved for P2.',
          timeout: 'timeout_ms',
          timeoutHint: 'Empty uses the server default; the cap is 300000 ms (§10-8).',
          reason: 'reason (admission reason)',
          reasonPick: 'pick an admission reason (required for MCP)',
          reasonHint: 'Required: if you cannot say why this needs the MCP channel, it should not be one (the server answers 400 without it).',
          slots: 'slots (configuration)',
          slotAdd: 'Add slot',
          slotRemove: 'Remove row',
          slotName: 'slot name (e.g. GITHUB_TOKEN)',
          slotDescription: 'description (required by the server; it reaches the model-visible list)',
          slotRequired: 'required',
          slotsNone: 'No slots: this server needs no credential or configuration at all.',
          injectLocked: 'inject is locked by the transport: {transport} => {inject} (§4.2 matrix; to change it change the transport).',
          issueReason: 'no admission reason picked (required for MCP)',
          issueCommand: 'stdio needs a command',
          issueUrl: 'http needs a url',
          issueTimeout: 'timeout_ms must be a whole number of milliseconds between 1 and 300000',
          issueSlotName: 'a slot has no name',
          issueSlotDuplicate: 'duplicate slot name',
        },
      },
      formIntro: 'Fields marked * are required by the server; this form does not enforce that itself.',
      fSlug: 'slug *',
      slugHint: 'Directory name: lowercase letters, digits, hyphens.' +
        ' The server also requires the package\'s `skill.id` to equal it.',
      fName: 'name *',
      fSummary: 'one-line summary *',
      fWhenToUse: 'when to use *',
      whenToUseHint: 'This text is injected into the system prompt as the routing signal' +
        ' (server limits it to 8..500 characters).',
      fVersion: 'version *',
      fAuthor: 'author',
      fTags: 'tags',
      tagsHint: 'Comma separated (e.g. pdf,docs).',
      fLicense: 'license',
      fDescription: 'detail body (markdown)',
      filesLabel: 'Package files (multiple)',
      bundleHint: 'The root must contain `skill.mjs`. Paths come from the relative directory' +
        ' (file name only when no folder was picked); file count, byte limits, a missing entrypoint' +
        ' and an id mismatch are all reported by the server.',
      noFilesPicked: 'No files picked: required when creating, optional when editing' +
        ' (nothing picked = metadata only).',
      pickedSummary: '{count} files picked, {bytes} total',
      detailMissingHint: 'Could not read this entry\u2019s details: the "when to use" field and' +
        ' the body may be empty -- fill them in before submitting, or you may clear the originals.',
      pathIssue: {
        empty: 'the path is empty',
        absolute: 'absolute path (not allowed)',
        separator: 'the path contains a backslash',
        parentRef: 'the path contains `..`',
        tooLong: 'the path is too long (over 200 bytes)',
      },
      resultCreated: 'Published {slug}.',
      resultUpdated: 'Updated {slug}.',
      resultPublished: 'Published {slug} (state moved to published).',
      resultRetired: 'Retired {slug} (existing installs keep working).',
    },
    macros: {
      title: 'Macro templates',
      intro: 'Configure automation templates: pick a kind first, then fill the form. The kind cannot be changed after creation.',
      loading: 'Loading templates…',
      loadFailed: 'Failed to load templates',
      retry: 'Retry',
      empty: 'No templates yet.',
      includeDeleted: 'Include deleted',
      colName: 'Name',
      colKind: 'Kind',
      colVisible: 'Visible',
      colStatus: 'Status',
      colSubscribers: 'Subscribers',
      colActions: 'Actions',
      subscriberUnknown: '—',
      audienceAll: 'Everyone',
      audienceAdmin: 'Admins only',
      deletedLabel: 'Deleted',
      deletedSuffix: ' (deleted)',
      enable: 'Enable',
      disable: 'Disable',
      del: 'Delete',
      createTitle: 'New template',
      pickKindFirst: 'Pick a kind first, then fill the form below.',
      kindLocked: 'The kind cannot be changed once created.',
      name: 'Name',
      audience: 'Visibility',
      paramsTitle: 'Parameters',
      fixedByCode: 'Fixed by code',
      fixedHint: 'These criteria and the tool surface are hard-coded, not configured here.',
      fixedScope: 'Scope: {scope}',
      scopeSession: 'session',
      scopeUser: 'user',
      cancel: 'Cancel',
      submitCreate: 'Create',
      createdTitle: 'Created · user view',
      userPreview: 'What a user sees in the subscription list:',
      triggerCost: 'Estimated cost per trigger: {estimate}',
      triggerCostUnknown: 'Estimated cost per trigger: not available',
      deleteHint: 'After deleting, the platform decides from the data: if none of the three references exist it is hard-deleted; as long as there are runs or notifications it can only be soft-deleted (history kept).',
      deleteConfirm: 'Delete this template?',
      resultDeleted: 'Hard-deleted.',
      resultDeletedWithAssignments: 'Hard-deleted and cascade-removed {count} subscription(s).',
      resultSoft: 'Soft-deleted (history kept): {runs} run(s), {notifications} notification(s).',
    },
    macroRuns: {
      title: 'Macro run history',
      intro: 'Filter by template / status / verdict / time / user; paging uses a cursor (keyset).',
      loading: 'Loading run history…',
      loadFailed: 'Failed to load run history',
      retry: 'Retry',
      empty: 'No matching records.',
      loadMore: 'Load more',
      noMore: 'No more',
      colTime: 'Started',
      colTemplate: 'Template',
      colUser: 'User',
      colStatus: 'Status',
      colVerdict: 'Verdict',
      colCriterion: 'Criterion',
      colDuration: 'Duration',
      colUsage: 'Cost',
      usageUnknown: '—',
      deletedSuffix: ' (deleted)',
      summaryTitle: 'Summary (follows filters)',
      sumTriggered: 'Triggered',
      sumDone: 'Done',
      sumSkipped: 'Skipped',
      sumFailed: 'Failed',
      sumSkippedHint: 'A high skip rate usually means misconfigured parameters, not normal operation.',
      verdictRatio: 'Verdict breakdown (denominator = done)',
      ratioNote: 'Percentages use “done” as the denominator, not “triggered” — skipped runs have no verdict.',
      ratioValue: '{label}: {count} ({pct}%)',
      ratioNoDone: 'No completed runs, so verdict percentages cannot be computed.',
    },
    // issue #485 slice A: per-file upload limit (`upload_settings` single-row table, migration 0035).
    // The page exists for one reason: changing a number should not require rebuilding a container. That is
    // why the copy centres on “current effective value + its source” rather than “saved” — after a save an
    // operator still needs to know which knob the platform is actually listening to.
    upload: {
      title: 'Per-file upload limit',
      intro: 'How large a single file may be when uploaded from the workbench. Changing it here needs **no portal restart and no container rebuild**: the limit is read per request, so the very next upload uses the new value.',
      loading: 'Loading the upload limit…',
      notLoaded: 'The upload limit has not been loaded yet (no request made).',
      unknown: 'unknown',
      statusEffective: 'Current effective value',
      statusSource: 'Source',
      statusUpdatedAt: 'Last changed',
      updatedAtNever: 'Never changed (nobody has saved this value in the admin console)',
      updatedAtUnknown: 'Unparseable timestamp: {value}',
      limits: 'Allowed range: {min} – {max}',
      field: 'New limit (bytes)',
      fieldHint: 'The server is the gate: any integer you enter is sent as-is (out of range ⇒ an error and this box turns red); the UI does not pre-empt it. Only integers are accepted, so `1.5` / `1e7` do not count.',
      draftIs: 'You entered: {value}',
      draftNotInteger: 'Not an integer yet (empty, a decimal or scientific notation all count as not) — no request is sent while so.',
      hintBelow: 'Below the allowed range ({min} – {max}); the server will reject the save.',
      hintAbove: 'Above the allowed range ({min} – {max}); the server will reject the save.',
      save: 'Save',
      reload: 'Reload',
      saved: 'Saved — **effective from the next upload** (the number shown is the one the server read back after writing).',
      sourceDb: 'Admin console (upload_settings in the database)',
      sourceEnv: 'Environment variable FILE_UPLOAD_MAX_BYTES',
      sourceDefault: 'Built-in default (32 MiB)',
      reasonNoRow: 'Nothing has been saved in the admin console yet, so the environment variable (or the default) is in force. Saving a value here overrides it.',
      reasonInvalid: 'The value stored in the database is unusable (out of range or the wrong shape), so we fell back to the environment/default — the number below is not what the admin console stored.',
      reasonReadFailed: 'upload_settings could not be read (missing table or database hiccup); we fell back to the environment/default. Uploads themselves are unaffected.',
      reasonReadTimeout: 'Reading upload_settings timed out (the database did not answer within UPLOAD_SETTINGS_READ_TIMEOUT_MS); we fell back to the environment/default. Uploads themselves are unaffected.',
      srcDb: 'Database value (when usable)',
      srcEnv: 'Environment variable',
      srcDefault: 'Built-in default',
      envNotSet: 'the environment variable is not explicitly set',
      footnote: 'This is a **per-file** limit, not a disk quota (total size is #485 slice B, not implemented). It is a different knob from MAX_BODY_BYTES (the JSON request-body limit, 64 KiB by default): uploads never go through the latter.',
    },
    // issue #596 slice B: admin prompts panel (views/AdminPromptsView.vue, docs/api/portal.md §4.19).
    // The three effective moments differ, so they are three separate keys on purpose — one
    // shared sentence would make the page lie (acceptance criterion F7). The readonly.* entries
    // say where each prompt lives and what changing it costs, never its text: the portal image
    // does not contain runner/, so showing the text here would be an unfounded promise.
    // ⚠ Every string below is rendered as plain text (this page has no markdown renderer and is
    //   not getting one): a pair of asterisks in a value shows up as junk characters, not as
    //   emphasis. Use a CSS class for emphasis; the gate lives in localeParity.spec.ts.
    prompts: {
      title: 'Platform prompts',
      intro: 'The three prompts the platform feeds the model that portal controls. Saving needs no portal restart and no image rebuild: materialization and renaming read that database row every time. An empty string means "follow the built-in text".',
      loading: 'Loading prompts…',
      notLoaded: 'Prompts not loaded yet (no request sent).',
      unknown: 'unknown',
      never: '—',
      updatedAt: 'Last saved',
      updatedBy: 'Saved by',
      updatedAtNever: 'Never saved (nobody has saved a value in the admin console yet)',
      updatedAtUnparsable: 'Unparsable timestamp: {value}',
      reasonNoRow: 'Nothing has ever been saved here, so the built-in prompts are what goes out; saving a value in this page overrides it.',
      reasonReadFailed: 'platform_prompts could not be read (missing table or database hiccup), so the built-in prompts are in force; materialization and renaming keep working (this is never a 500).',
      reasonReadTimeout: 'Reading platform_prompts timed out (the database did not answer within PLATFORM_PROMPTS_READ_TIMEOUT_MS), so the built-in prompts are in force. This does not mean "nobody configured it" — the real fault is the connection.',
      reasonUnknown: 'The server reported a fallback reason this page does not know (a new backend reason?), so the built-in prompts are in force; check the server log for the actual cause.',
      source: 'Current source',
      sourceDb: 'database override',
      sourceBuiltin: 'built-in',
      sourceDbNote: '(this field is the value saved in the admin console, not the one in the code)',
      bytesOf: 'currently {bytes} / limit {max}',
      draftBytes: 'draft: {bytes}',
      overLimit: 'The draft is {bytes}, above the {max} limit: the server will reject the save with 400. Nothing is blocked here on purpose — the server is the gate.',
      cardAddendum: 'Platform addendum (appended as a section at the end of ~/AGENTS.md)',
      addendumLabel: 'Addendum body',
      addendumHint: 'The section heading and lead-in are written by the platform; your body is copied byte for byte, rewritten by nobody. Clearing it removes that section.',
      timingAddendum: 'Effective when: save ⇒ re-materialization is queued ⇒ this seat picks the section up on its next run (not immediately, not on the next portal restart).',
      cardAgentsMd: 'Whole-section override (replaces the body of ~/AGENTS.md)',
      agentsMdLabel: 'Override body',
      agentsMdHint: 'Your text replaces the body of the built-in template; the trailing seat identity line is still appended by code, always last, never editable.',
      timingAgentsMd: 'Effective when: it shares the materialization notification with the addendum ⇒ next run of that seat; if queueing failed, convergence waits for the full rebuild on the next portal restart.',
      cardTitlePrompt: 'Session title prompt (the system message behind AI retitling)',
      titlePromptLabel: 'Title prompt',
      titlePromptHint: 'It only decides how a session gets named: it never enters ~/AGENTS.md and never participates in materialization. The prompt is not a guard — titles are still sanitized before being stored.',
      timingTitlePrompt: 'Effective when: the next rename (manual "AI retitle" and automatic renaming share one resolution path; read fresh every time, no cache, no run and no materialization needed).',
      deviated: 'Deviated from the built-in template: the body that goes out is the one you wrote.',
      followsTemplate: 'Following the built-in template: no override, the text in the code is what goes out.',
      renderBudget: 'Whole ~/AGENTS.md: effective {effective} / injection limit {limit} (the built-in template renders to {template})',
      renderBudgetNote: 'This figure is a preview rendered with the fixed example seat name "example" (zero timestamps, so it is comparable), not the size of any real seat file. The save-time render gate budgets the LONGEST legal seat name, so with a longer real name the real file can be slightly bigger than what is shown here.',
      viewEffective: 'View the effective full text',
      hideEffective: 'Hide the effective full text',
      copy: 'Copy',
      copied: 'Copied.',
      copyFailed: 'Copy failed (the browser gave no clipboard), select the text manually.',
      restoreBuiltin: 'Restore built-in',
      titlePromptDefaultBytes: 'Built-in default (what actually goes out while following the default): {bytes}',
      save: 'Save',
      reload: 'Reload',
      saved: 'Saved (what this page now shows is the value the server read back after writing, not what you typed).',
      savedEnqueued: 'Re-materialization was queued for {count} active seat(s) ⇒ each takes it on its next run.',
      savedButNotNotified: 'Saved, but materialization was not notified (the full rebuild after a portal restart will converge).',
      savedNoticeCountUnknown: 'Saved, but the server did not return materializeEnqueued ⇒ this page treats it as not notified and never claims "already in effect".',
      readonlyTitle: 'The four prompts that live in the image (read-only here)',
      readonlyIntro: 'These four are not editable online in the first phase. Below: where each one lives and what changing it costs.',
      readonlyNoFullText: 'This page does not show their text: the portal image has no runner/ directory (the Dockerfile only copies portal/), so the backend cannot read those prompts at runtime and sends only the keys. Showing text here would be an unfounded promise — read the source for the full text.',
      readonlyUnknown: 'The server also listed entries this page has no copy for: {keys} (their meaning is not guessed).',
      readonly: {
        runnerSystemPrompt: {
          where: 'Lives in runner/worker.js as SYSTEM_PROMPT: the system message of every main run, prepended before the ~/AGENTS.md injection.',
          cost: 'Changing it means: edit code + rebuild and push the FDE image + recreate every fde-* container (not station-portal), i.e. a platform-wide release; the database has no column for it.',
        },
        childSystemPrompt: {
          where: 'Lives in runner/lib/delegation.js as CHILD_SYSTEM_PROMPT: the system message of a delegated child run (it states that the child has no delegate tool).',
          cost: 'Same as above: edit code, rebuild the FDE image, recreate containers. Slice 1 does not open online editing (issue #596 ranks it after the three portal-side prompts).',
        },
        toolDescriptions: {
          where: 'Lives in the description field of every tool schema in runner/lib/file-tools.js, shell-tools.js, notes-tools.js and friends.',
          cost: 'One sentence still costs an FDE image rebuild. Tool descriptions decide how the model calls them, so the regression surface is every run on every seat — far dearer than rewording a prompt.',
        },
        engineNotices: {
          where: 'Lives in runner/lib/engine-notices.js: the layer that turns engine diagnostics into human-readable LOG (the half the UI never shows).',
          cost: 'Edit code + rebuild the FDE image, and it is reconciled key by key against run_events (runner/test/engine-notices.test.js) — you cannot change the wording without the criteria.',
        },
      },
      errNotText: 'This draft is not text, so not even its length can be computed — no request was sent.',
      footnote: 'Beyond these three, the platform has four more prompts living in the runner image (see the read-only card above). Slice 1 has no per-FDE override and no version history: to see who changed what, read the audit action admin.platform_prompts_updated (the audit stores digests only; the text lives in that configuration row).',
    },
    // issue #677 slice P2b: admin "Runtime settings" list (views/AdminRuntimeSettingsView.vue,
    // contract docs/api/portal.md §4.21). Same family as admin.upload but a *list* (issue P3 keeps
    // adding knobs to the registry), so the copy must never hard-code "this one knob" or a concrete
    // range — the range is the server registry's truth, not something i18n copies here.
    // ⚠ Values render as plain text (no markdown renderer on this page): no asterisk pairs for emphasis.
    runtime: {
      title: 'Runtime settings',
      intro: 'The admin console entry for the platform knobs. Every row shows the value together '
        + 'with its source and how it takes effect: a bare number leaves operators guessing whether '
        + 'the knob they changed is even listened to. Values saved here go into the database and take '
        + 'precedence over the environment variable and the built-in default, with no image rebuild.',
      loading: 'Loading runtime settings…',
      loadError: 'The list could not be read, so nothing below is presented as the current state '
        + '(the message is the server’s own):',
      notLoaded: 'Runtime settings not loaded yet (no request has been made).',
      empty: 'The server listed no manageable settings (the registry has no writable knob yet).',
      colKey: 'Setting',
      colValue: 'Current value',
      colSource: 'Source',
      colApplyMode: 'Takes effect',
      colUpdatedAt: 'Updated at',
      colChange: 'Change this value',
      unknown: 'unknown',
      never: 'never (the admin console never saved this one)',
      sourceDb: 'Admin console (database)',
      sourceEnv: 'Environment variable',
      sourceDefault: 'Built-in default',
      applyHot: 'takes effect immediately',
      applyRestart: 'needs a restart',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved (the number below is the one the server read back after writing), {apply}',
      reload: 'Reload',
      errNotInteger: 'Not an integer (empty, a decimal or scientific notation all count as not) '
        + '⇒ no request was sent.',
      errNoItem: 'The server returned no setting (the response has no item) ⇒ this row was not '
        + 'refreshed and is not treated as saved.',
      fieldKey: 'the setting name',
      fieldValue: 'New value',
      fieldBody: 'the request body',
      fieldPointed: ' (the server says the fault is in: {field})',
      footnote: 'The UI does not police ranges: any parsed integer is sent as-is (out of range ⇒ the '
        + 'server rejects it and writes nothing, §4.21). A row whose “Takes effect” column says '
        + 'it needs a restart only applies after station-portal restarts — “Saved” here never '
        + 'means “in effect”. And “takes effect immediately” does not cross processes: in a '
        + 'multi-replica deployment the other station-portal processes see the new value after at '
        + 'most 5 seconds.',
    },
    // issue #449 admin slice: mail channel settings (views/AdminMailView.vue, contract docs/api/portal.md §4.12).
    // This page is the only switch for the email-code second factor; the password is write-only
    // (the server only ever reports hasPassword). Server error messages are never translated.
    mail: {
      title: 'Mail channel (SMTP)',
      intro: 'The only switch for the “email verification code” second factor: once transport is smtp and saved, accounts without TOTP get a code by mail at login; disabled falls back to password only. The password is write-only — the server reports “set / not set” and never returns the plaintext.',
      loading: 'Loading mail settings…',
      notLoaded: 'Mail settings not loaded yet (no request has been made).',
      unknownValue: '—',
      statusTransport: 'Current transport',
      statusPassword: 'Password',
      statusUpdatedAt: 'Last changed',
      updatedAtNever: 'Never changed (the server returned the default DTO)',
      updatedAtUnknown: 'Unparsable timestamp: {value}',
      passwordSet: 'set',
      passwordUnset: 'not set',
      transport: 'Transport',
      transportDisabled: 'disabled (no mail is sent)',
      transportSmtp: 'smtp (sends for real)',
      transportHint: 'With disabled neither host nor sender is required (the server does not validate them either), yet the form stays editable: turn it off first and configure at leisure.',
      host: 'SMTP host',
      hostHint: 'Just the hostname of the relay (no scheme prefix); required when transport=smtp.',
      port: 'Port',
      secure: 'Use implicit TLS (the 465 shape)',
      secureHint: 'Checked = implicit TLS (usually 465); unchecked = STARTTLS (usually 587).',
      user: 'Auth user',
      userHint: 'Optional: internal relays often allow by source IP and need no auth.',
      password: 'SMTP password',
      passwordKeep: 'Already set — leave empty to keep it',
      passwordPlaceholder: 'Not set (leave empty to keep it unset)',
      passwordHint: 'The password is never filled back in, never enters page state, never reaches logs or the address bar: it lives in the input only and travels in the request body when you save.',
      clearPassword: 'Clear the saved password',
      from: 'Sender address',
      fromHint: 'The From of verification mails; required when transport=smtp and must be a valid email address.',
      advanced: 'Advanced: timeouts (ms)',
      timeoutConnection: 'Connection timeout',
      timeoutGreeting: 'Greeting timeout',
      timeoutSocket: 'Socket timeout',
      timeoutHint: 'Positive integers (at most 600000); leave empty to use the server defaults.',
      save: 'Save settings',
      saving: 'Saving…',
      saveOk: 'Saved: the server dropped its cache, so the change takes effect immediately.',
      testTitle: 'Send a test mail',
      testIntro: 'Sends a real probe mail with the saved settings (not with the unsaved draft in the form). At most 5 per admin per hour.',
      testTo: 'Recipient',
      testToPlaceholder: "ops{'@'}example.com",
      testSend: 'Send a test mail',
      testing: 'Sending…',
      testDisabledHint: 'The current transport is not smtp (disabled): nothing can be sent. Switch the transport to smtp and save first.',
      testFormUnsaved: 'The transport in the form differs from the saved one: the test mail uses the saved settings.',
      testOk: 'Test mail sent to {to} ({at})',
      testOkNoTime: 'the server gave no timestamp',
      testNotConfiguredPrefix: 'Mail channel is not enabled (409 mail_not_configured): ',
      testFailedPrefix: 'Sending failed (502 email_send_failed): ',
      testRateLimited: 'Too many test mails (429 rate_limited): at most 5 per admin per hour, retry in {seconds} seconds.',
      testRateLimitedNoRetry: 'Too many test mails (429 rate_limited): at most 5 per admin per hour, retry later.',
      testReason: 'Server reason: {reason}',
    },
    // issue #456 M2: admin “Certificates” page (views/AdminTlsView.vue, contract docs/api/portal.md §4.13).
    // Server error messages are never translated; `warnings` are machine codes rendered here.
    tls: {
      title: 'Admin certificate',
      intro: 'The certificate behind the admin entry (admin.<domain>): inspect it, verify it against the live edge, upload a new one, roll back. The files on disk are the single source of truth; the database is only a ledger.',
      loading: 'Loading certificate status…',
      notLoaded: 'Certificate status not loaded yet (no request has been made).',
      unknownValue: '—',
      statusTitle: 'Current certificate',
      configured: 'configured',
      notConfigured: 'not configured',
      notConfiguredHint: 'The admin entry currently uses the built-in Traefik self-signed certificate, so browsers will warn. Install a real certificate with the form below.',
      subjectCN: 'Subject CN',
      sans: 'SAN (names the certificate covers)',
      sansEmpty: 'This certificate has no DNS SAN (coverage falls back to the CN)',
      issuerCN: 'Issuer CN',
      validFrom: 'Valid from',
      validTo: 'Valid until',
      fingerprint: 'SHA-256 fingerprint',
      copy: 'Copy',
      copied: 'Copied',
      coverageOk: 'Covers the admin host {host}',
      coverageBad: 'This certificate does not cover {host}: browsers will report a certificate error',
      expirySoon: 'The certificate expires in {days} days ({date})',
      expiryToday: 'The certificate expires today ({date})',
      expiryExpired: 'The certificate has expired ({date})',
      liveTitle: 'Live check',
      liveIntro: 'Connects to the admin entry once and compares the fingerprint of the served certificate with the one on disk. A failed probe does not block upload or rollback.',
      liveCheck: 'Check the live certificate',
      liveChecking: 'Checking…',
      liveNever: 'Not checked yet',
      liveCheckedAt: 'Checked at: {at}',
      liveLive: 'The live handshake serves exactly this certificate (fingerprints match)',
      liveMismatch: 'The live edge serves a different certificate',
      liveMismatchChainIncomplete: 'The live fingerprint matches this certificate, but the server sent only 1 certificate (chain depth {depth}): clients may fail chain verification (unable to verify the first certificate). Re-upload with the intermediate certificate appended to the PEM (leaf first).',
      liveUnreachable: 'The admin entry is unreachable',
      liveExpected: 'Fingerprint on disk',
      liveActual: 'Fingerprint on the wire',
      liveError: 'Raw error: {error}',
      uploadTitle: 'Upload / update certificate',
      uploadIntro: 'Step one “inspect” is read-only: paste the full chain and the private key, and the domains are extracted from the certificate. Step two installs it for real.',
      certLabel: 'Certificate PEM (a whole fullchain is fine, leaf first)',
      certHint: 'At most 64 KiB. Nothing takes effect until you inspect and then install.',
      keyLabel: 'Private key PEM',
      keyHint: 'At most 64 KiB. It lives in this page’s inputs only and is cleared right after submitting; it never reaches browser storage, logs or the address bar.',
      inspect: 'Inspect certificate',
      inspecting: 'Inspecting…',
      inspectEmpty: 'The server returned no certificate information (no cert in the response).',
      inspectTitle: 'Inspection result',
      keyMatchesOk: 'The private key matches the certificate',
      keyMismatchBad: 'The private key does not match this certificate: installing it would break the admin entry handshake, so it cannot be installed',
      keyNotProvided: 'No private key provided, so matching cannot be checked',
      domainsTitle: 'Names this certificate should cover',
      domainsIntro: 'Pre-filled from the certificate SANs (CN when there are none). Edit, remove or add rows; you cannot add a name the certificate does not cover (the server rejects it).',
      domainsAdminTag: 'admin host (must be included)',
      domainAdd: 'Add a row',
      domainRemove: 'Remove',
      domainsEmpty: 'No names left: keep at least the admin host.',
      domainsMustInclude: 'Must include {host}: the server rejects a certificate that does not cover it.',
      coverageBlocksInstall: 'This certificate does not cover {host}, so the server would reject it.',
      install: 'Confirm and install',
      installing: 'Installing…',
      installOk: 'Installed: the live certificate is updated and the status card is refreshed.',
      installNeedsKey: 'A private key is required to install (the server checks the pairing).',
      warnExpired: 'This certificate has expired: browsers will reject it outright.',
      warnNotYetValid: 'This certificate is not valid yet (notBefore is in the future).',
      warnNoSans: 'This certificate has no DNS SAN: coverage falls back to the CN, which modern browsers no longer look at.',
      warnNotCovered: 'This certificate does not cover the admin host.',
      warnLeafOnly: 'This certificate is a single leaf: Traefik can load it, but strict client verification may fail (unable to verify the first certificate). Appending the intermediate certificate to the PEM (leaf first) is recommended; installing is still allowed.',
      warnChainOrderSuspect: 'The certificate order may be reversed: the first block looks like an intermediate, not your domain certificate. Traefik refuses to load a certificate in this shape (it falls back to its built-in self-signed one), so put the leaf certificate first.',
      warnChainBroken: 'The chain does not link up (the bundled certificate did not issue your leaf): clients will fail chain verification. Check the intermediate certificate.',
      rollbackTitle: 'Rollback',
      rollbackIntro: 'Puts the previous generation back on the wire (only one generation is kept; rollback does not overwrite the backup, so it can be repeated).',
      rollbackPreviousCN: 'Previous Subject CN',
      rollbackPreviousFingerprint: 'Previous fingerprint',
      rollbackPreviousSavedAt: 'Backed up at',
      rollback: 'Roll back to the previous one',
      rollingBack: 'Rolling back…',
      rollbackConfirmTitle: 'Roll back?',
      rollbackConfirmBody: 'Rolling back immediately puts the previous certificate on the wire (the admin entry reloads). It cannot be undone from the UI, only by uploading again.',
      rollbackConfirmYes: 'Yes, roll back',
      rollbackConfirmNo: 'Cancel',
      rollbackOk: 'Rolled back: the status card is refreshed.',
      errCertInvalid: 'The certificate PEM cannot be parsed (400 tls_cert_invalid): ',
      errKeyInvalid: 'The private key PEM cannot be parsed (400 tls_key_invalid): ',
      errKeyMismatch: 'The private key does not match the certificate (400 tls_key_mismatch): ',
      errCertExpired: 'The certificate has expired (400 tls_cert_expired): ',
      errDomainMismatch: 'The certificate does not cover the required names (400 tls_cert_domain_mismatch): ',
      errDomainMissing: 'missing: {missing}',
      errNoPrevious: 'There is no previous generation to roll back to (404 tls_no_previous): ',
      errValidation: 'Invalid parameters (400 validation_failed): ',
      errRateLimited: 'Too many attempts (429 rate_limited): retry in {seconds} seconds.',
      errRateLimitedNoRetry: 'Too many attempts (429 rate_limited): retry later.',
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
    // issue #586: the "About" panel (views/AdminAboutView.vue, contract docs/api/portal.md §4.16).
    // The point is not "there is a version number" but **which of the three cells this is and where it
    // was read from**: the v0.1.69 release baked a working tree stuck at 0.1.68 and the two sides
    // disagreed for an hour with nothing in the UI to reveal it.
    about: {
      title: 'About this station',
      intro: 'Read-only. Three version numbers, three sources, none replaces another: the server and the platform engine come from the build-info.json baked into the portal image; each FDE engine comes from a derived copy in the database.',
      loading: 'Loading version info…',
      notLoaded: 'Version info not loaded yet (no request has been made).',
      fieldVersion: 'Version',
      fieldRevision: 'Build revision (git)',
      fieldBuiltAt: 'Built at',
      unknown: 'unknown',
      unparsable: 'Unparsable: {value}',
      serverTitle: 'Server (portal image)',
      serverHint: 'Which build the portal container itself is running.',
      sourceBuildInfo: 'Source: build-info.json inside the image (build artifact, the only authority)',
      sourceEnv: 'Source: an explicit environment override (tests / pinning), not what was baked into the image',
      sourcePackage: 'Source: local package.json (dev fallback, not a build artifact)',
      sourceUnknown: 'Source: unknown (neither build-info.json nor package.json could be read)',
      sourceUnknownShape: 'Source: the server did not say, or said something unrecognized (not guessed)',
      // The build-info path actually read (STATION_BUILD_INFO_PATH / ERIX_BUILD_INFO_PATH can move it => it must stay visible).
      buildInfoPath: 'Read path: {path}',
      // #643 B: shown only when the server itself says this is a local build;
      // the frontend never infers it (see lib/versionSurface.ts).
      // Neutral wording, but it must name "no build-info" / "not a release artifact".
      localBuild: 'Local build: no build-info was baked into this portal image, so it is not a '
        + 'release artifact to reconcile against (image tag / digest will not match)',
      engineTitle: 'Platform engine (erix-agent inside the portal image)',
      engineHint: 'The engine the portal process itself uses. Not the one running in each FDE container - that is the third section.',
      // Engine provenance wording follows the label the server derived (the frontend never infers);
      // package.json = dev fallback, or this image never baked a build-info.json at all (old image).
      engineSourceBuildInfo: 'Source: engine_version from build-info.json inside the image (build artifact, the only authority)',
      engineSourcePackage: 'Source: local node_modules/erix-agent/package.json - a dev fallback, or this image has no build-info.json at all (old image); it is not a build artifact',
      engineSourceEnv: 'Source: an environment override (it should not appear on the portal side; when it does, this is not a build artifact)',
      engineSourceUnknown: 'Source: unknown (neither build-info.json nor package.json could be read)',
      engineSourceUnknownShape: 'Source: the server did not say, or said something unrecognized (not guessed)',
      fdesTitle: 'Engine per FDE',
      fdesHint: 'Read from containers.agent_version - a derived copy, not authoritative.',
      snapshotProvision: 'provision-time snapshot',
      snapshotUnknown: 'no provenance given',
      fdeProvisionedAt: 'provisioned {at}',
      revoked: 'revoked',
      fdesEmpty: 'The server says there are no FDE containers.',
      fdesUnreadable: 'containers.agent_version could not be read (that is "unreadable", not "no FDEs").',
      caveat: 'Provenance: the only authority is the build-info.json baked into the image; package.json is a build input, while git tags, image tags, digests and containers.agent_version are derived copies and must be labelled as such.',
    },
    // Host resource snapshot (views/AdminSystemView.vue, issue #650; contract docs/api/portal.md §4.20).
    // Four hard rendering rules (each pinned by a spec case): anything unavailable says "unknown"
    // (never 0); sampling disabled / no first tick yet / history unreadable are three different sentences;
    // load must carry its normalized magnitude; disk is one row per device and unreadable paths must show.
    system: {
      title: 'System (host resources)',
      intro: 'Read-only. A sampler reads /proc and statfs every 30s and stores it; the cards read the newest in-process tick while the charts read the bucketed rows - both come from the same sampler and may differ by one sampling period.',
      retention: 'History retained for {days} days',
      rangeLabel: 'History range',
      loading: 'Reading host readings…',
      notLoaded: 'Host readings not loaded yet (no request has been made).',
      unknown: 'unknown',
      noSample: 'No sampling tick yet, so this cell has no reading (that is not 0).',
      noData: 'No data in this range',
      historyUnavailable: 'History unavailable: {reason}',
      // Three states: "disabled" only when the server says `enabled: false` (with how to turn it on);
      // `enabled: true` with no reading is "waiting for the first tick"; a missing `enabled` (old backend)
      // means say nothing at all - "it did not say" is not "it said no".
      samplingDisabled: 'Sampling is disabled (SYSTEM_METRICS_ENABLED=0): no new readings appear here. To turn it on: set SYSTEM_METRICS_ENABLED=1 in the portal environment and restart the portal.',
      waitingFirstSample: 'Sampling is enabled but the first tick has not landed yet (wait at most one sampling period, 30 seconds by default).',
      cpuTitle: 'CPU',
      cpuUsage: 'Usage (two-tick delta; the first tick after start cannot compute it)',
      cpuCores: 'Cores',
      // Normalization (named in the issue): a bare load=5 on a 36-core box reads as "about to explode".
      // `≈` not `=`: load includes uninterruptible IO and is not core-weighted - it is a magnitude, not usage.
      loadLine: 'load {load} across {cores} cores ≈ {pct}',
      memTitle: 'Memory',
      memAvailable: 'Available',
      memCached: 'Cached',
      memSwap: 'Swap used',
      diskTitle: 'Disk',
      diskMonitored: '{count} file system(s) monitored (deduplicated by device: one physical disk = one row)',
      diskNone: 'This tick read no file system at all (SYSTEM_METRICS_DISK_PATHS unset, or every path unreadable).',
      diskAvail: '{value} free',
      diskUnreadable: 'unreadable: {reason}',
      diskUnreadableNone: 'Every configured path was readable this round (nothing unreadable).',
      // Boundary stated in issue #650: disks not mounted into the portal never appear by themselves,
      // and this surface never claims to show "every disk on the host".
      diskCaveat: 'Scope: only file systems mounted into the portal appear here (host disks that are not mounted do not); this surface does not claim to show every host disk.',
      containersTitle: 'Containers',
      containersUnreadable: 'Container counts unreadable (docker unreachable) - that is "unreadable", not "0 containers".',
      containersStation: 'station-labelled',
      containersFde: 'FDE (running / total)',
      containersPausedStopped: 'paused / stopped',
      driftLine: 'Reconcile: DB {db} ↔ Docker {docker}',
      driftUnknown: 'Reconciliation not given (the DB-side container names could not be read, so neither agreement nor drift can be claimed).',
      driftOnlyDb: 'only in DB: {names}',
      driftOnlyDocker: 'only in Docker: {names}',
      sampledAt: 'Sampled: {at}',
      agoNow: 'just now',
      agoSeconds: '{value}s ago',
      agoMinutes: '{value} min ago',
      agoHours: '{value}h ago',
      agoDays: '{value}d ago',
      timeFuture: 'Timestamp is in the future: {value} (the sampler and this clock disagree; not clamped to "just now")',
      timeUnparsable: 'Unparsable timestamp: {value}',
      bucketSeconds: 'each point = {value}s',
      bucketMinutes: 'each point = {value} min',
      bucketHours: 'each point = {value}h',
      droppedPoints: '{count} history point(s) had an unrecognized shape and were dropped',
      diskDropped: '{count} disk row(s) had an unrecognized shape and were dropped',
      caveat: 'Scope: these are **host** readings (read from /proc and statfs inside the portal container, not cgroup-scoped), effective range {range}; they are not the usage of each FDE container.',
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
    mailOtpSection: 'Email verification code',
    mailOtpHint: 'Require an emailed code as the second factor for this user. This is a per-user switch, parallel to TOTP; the mail channel (SMTP) only decides whether mail can be sent at all.',
    mailOtpEnabledLabel: 'Require an emailed code at sign-in',
    mailOtpEnabledHint: 'When off, this user signs in with the password only (no second factor).',
    // #449 second-factor choice (`second_factor_choice`): for accounts with TOTP enrolled this switch is no
    // longer inert — it adds a second way in. The audit wording matters: the weaker path is logged as
    // `email_code_alt`, so operators must be able to see that from this very row.
    mailOtpEnabledLabelAlt: 'Email code (as an alternative to TOTP)',
    mailOtpAltHint: 'This account has TOTP enrolled. Once enabled, sign-in accepts either TOTP or an emailed code; the email-code path is recorded in the audit log as email_code_alt.',
    mailOtpCurrentEmail: 'Codes will be sent to: {email}',
    mailOtpNeedsEmail: 'This user has no email yet — fill it in on the Profile tab first.',
    // feat-261110-03: the two-factor tab became two checkboxes + expand-on-check.
    // This is the red line shown when the account ends up with no second factor at all. The predicate is
    // "no usable factor", not literally "neither box ticked": the server's `chooseSecondFactor` also
    // requires an enrolled secret, so legacy accounts (migration 0030 defaults `totp_login_enabled` to
    // true, nothing enrolled) still get the warning.
    mailOtpSwitchWarning: 'This account will sign in with the password only (no second factor).',
    // Short label on the checkbox row; the long sentences stay inside the expanded block.
    mailOtpCheckboxLabel: 'Email verification code',
    totpLoginEnabledLabel: 'Authenticator app (TOTP)',
    totpEnrolledState: 'Enrolled',
    totpNotEnrolled: 'Not enrolled',
    saveMfaSettings: 'Save two-factor settings',
    mfaSettingsSaved: 'Two-factor settings saved.',
    // 2026-11-09 (#472 slice A): per-user "file upload" switch (migration 0029).
    fileUploadSection: 'File upload',
    fileUploadHint: 'Lets this user upload files into their own workspace from the workbench. Per-user switch, same pattern as TOTP / email codes: new accounts always start off and an admin has to turn it on here.',
    fileUploadEnabledLabel: 'Allow file uploads',
    fileUploadEnabledHint: 'When off, uploads are rejected server-side (403) and the workbench hides the upload entry. Re-creating a disabled account clears this switch, so it has to be enabled again.',
    fileUploadUnknown: 'Unknown (this account\'s switch could not be read — reload and retry) — unknown is not "off", so saving stays disabled.',
    fileUploadSaved: 'File upload setting saved.',
    saveFileUpload: 'Save file upload setting',
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
      // feat-261110-02: TOTP + email codes moved out of Security into their own tab.
      editTabMfa: 'Two-factor',
      editTabLlm: 'LLM & Repository',
      editTabPorts: 'Preview ports',
      editTabDanger: 'Danger zone',
      basicProfileSection: 'Basic profile',
      llmSection: 'LLM binding',
      dangerSection: 'Danger zone',
      totpSection: 'TOTP settings',
      totpSectionHint: 'Manage this user’s TOTP registration; re-enrolling immediately invalidates the old secret.',
      // issue #497（迁移 0031）：activity = 最近一次用户输入，与 login 是两个维度；
      // 旧键 `lastLogin` 已删（第 8 格换语义后零引用）。**只删这一个键**：`neverLoggedIn` 仍在用
      //（副行与清退日期两格都读它）。
      neverLoggedIn: 'Never',
      // 两个「从未」必须分得开，且都不许渲染成 "Today" 或空串。
      lastActivity: 'Last activity',
      neverActive: 'Never active',
      loginAt: 'Signed in {time}',
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
      'Send failed: the model this FDE is bound to no longer exists in the LLM gateway (slot {slot}, model {model}). Re-select the model in the admin console at /admin and send again (contact your administrator if you lack access)',
    runInProgress: ' (a run is already in progress)',
    treeLoadFailed: 'Failed to load the directory tree: {message}',
    // issue #107：inline rename — blank title blocked locally / hint when the PATCH fails (old title restored)
    renameEmpty: 'Session title cannot be empty',
    renameFailed: 'Rename failed: {message}',
    // issue #114：AI rename failure (message comes from the server: 409 no LLM configured / 502 upstream)
    aiRenameFailed: 'AI rename failed: {message}',
    // issue #488: hiding a session failed. 409 `run_in_progress` keeps the existing backend rejection
    // (**D5: no new contract, no new error code**) and only gets a localized hint that names the way out;
    // other failures keep the server `error.message` untranslated behind a localized prefix.
    hideFailed: 'Failed to hide: {message}',
    hideRunInProgress: 'This session still has a run in progress — stop it first, then hide it.',
    // issue #449: email-code login error codes (code → actionable text; mapping in stores/auth.ts
    // EMAIL_LOGIN_ERROR_KEYS). Only “what to do next” — no promise that a retry will succeed.
    emailCodeInvalid:
      'That code is wrong or has expired: resend a new one, or go back and sign in again.',
    emailNotRegistered:
      'This account has no email address on file, so no sign-in code can be sent: ask your administrator to add one and try again.',
    emailSendFailed:
      'The code email could not be sent this time: click “Send again” — you do not need to retype your password.',
    pendingExpired: 'This sign-in attempt has expired: please enter your login name and password again.',
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
  // issue #528 (event platform W5) user-facing copy. Key names follow the table fixed in `07` §21.1
  // (once fixed they never change — renaming means changing both locales at once, and one side gets missed).
  // ⚠ Raw enum values (`quiet_hours`, …) never reach the UI: the human mapping lives in
  // `lib/macroView.ts` (`skipMessageKey` / `verdictMessageKey`).
  macro: {
    title: 'Watch log',
    loading: 'Loading…',
    loadFailed: 'Failed to load',
    retry: 'Retry',
    chip: {
      enabled: 'Automation · {count} on',
      none: 'Automation · none on',
    },
    config: {
      title: 'Configure ▾',
      intro: 'Checking a box applies immediately — no save button; runs already triggered are not rolled back.',
      userScopeHint: 'Set up by an admin (user level, not subscribed per session)',
      userScopeEnable: 'Enable',
      userScopeEnabled: 'Enabled',
      userScopeCancel: 'Unsubscribe',
      userScopeChooseDir: 'Choose a directory to run in',
    },
    card: {
      enabledCount: '{count} enabled',
      lastEvaluated: 'last evaluated {at}',
      notEvaluated: 'not evaluated yet',
    },
    health: {
      stale: '⚠ last evaluation was {minutes} min ago, expected every {everySeconds}s (stale after {staleAfterSeconds}s) · macros may not be firing',
      neverEvaluated: '⚠ these templates have never been evaluated · macros may not be firing',
      nextStep: 'If it keeps not refreshing, ask an admin to check the executor.',
    },
    filter: {
      template: 'Template',
      verdict: 'Verdict',
      allTemplates: 'All templates',
      allVerdicts: 'All verdicts',
      clear: 'Clear filters',
      status: 'Status',
      allStatuses: 'All statuses',
      from: 'From (incl.)',
      to: 'To (incl.)',
      user: 'User',
      allUsers: 'All users',
    },
    status: {
      pending: 'Queued',
      running: 'Running',
      done: 'Done',
      skipped: 'Skipped',
      failed: 'Failed',
      superseded: 'Superseded',
      unknown: 'Unknown status',
    },
    // The single wording table from `07` §6.1 (old drafts said "not passed" / "not achieved").
    verdict: {
      pass: 'Pass',
      red: 'Rework',
      noop: 'Change unproven',
      human: 'Needs a human',
      unclassified: 'Unjudged',
    },
    // Human wording per `09` §3.3. `humanPresent` states a neutral fact and never blames the user.
    skip: {
      budget: 'Daily budget used up',
      quietHours: 'Quiet hours (22:00–08:00)',
      humanPresent: 'You just sent a message, so it stayed quiet',
      runInProgress: 'A run is in progress in this session',
      deferred: 'A run is in progress, it will be delivered once that ends',
      deferredTimeout: 'Waited for the slot over 10 minutes, gave up',
      activeRunInCwd: 'A run is active in the same directory',
      cancelledByUser: 'You turned the watch off',
      unknown: 'Blocked by a gate (reason unknown)',
      aggregate: '{count} in a row for the same reason',
    },
    kind: {
      runNotify: 'Terminal notification',
      runSilence: 'Silence alert',
      runReview: 'Completion review',
      scheduledTask: 'Scheduled task',
      unknown: 'Unknown kind',
      desc: {
        runNotify: 'Notifies you when a run reaches a terminal state',
        runSilence: 'Alerts when a tool stalls past the threshold',
        runReview: 'Reviews the session after a run ends and reworks once',
        scheduledTask: 'Starts its own macro session at a fixed time each day',
        unknown: 'No description for this kind yet',
      },
    },
    field: {
      name: 'Name',
      states: 'Terminal states to watch',
      channel: 'Notification channel',
      threshold: 'Silence threshold',
      phases: 'Phases to watch',
      reviewDepth: 'Review depth',
      onFail: 'What to do on failure',
      maxRounds: 'Max rounds',
      at: 'Time',
      cwd: 'Directory',
      task: 'Task description',
    },
    action: {
      regenerate: 'Regenerate',
      stopRun: 'Stop run',
      openSettings: 'Open settings',
      refresh: 'Refresh',
      close: 'Close',
      back: 'Back',
    },
    detail: {
      depth: 'depth {depth}',
      noAction: 'Executed',
    },
    // `07` §15: per-run numbers are measured, the summary is marked as an estimate and collapsed by
    // default; with no confirmed unit price we show tokens only and never a currency amount.
    cost: {
      tokens: 'tokens',
      monthly: 'This month',
      triggers: '{count} triggers in this session',
      unknown: 'usage unknown',
      estimateToggle: 'Estimate details',
      estimateHint: 'estimate (unit price comes from the pricing config and may be off)',
    },
    // Business empty states per `07` §17.2 (technical states use `loading` / `loadFailed`).
    empty: {
      noSubscription: 'No template is attached to this session',
      neverTriggered: '{count} enabled, nothing triggered yet. Last evaluated {at}',
      filtered: 'No matching records',
      chooseTemplate: 'Choose a template',
    },
  },
  // `07` §21.3: a dedicated `notifications` table plus a bell in the top bar (not the message stream).
  notifications: {
    title: 'Notifications',
    aria: 'Notifications, {count} unread',
    loading: 'Loading…',
    failed: 'Failed to load notifications',
    empty: 'No notifications',
    markRead: 'Mark as read',
  },
  // `07` §21.4: a separate collapsed "Automation" group in the sidebar; sessions inside are read-only.
  macroSidebar: {
    group: 'Automation',
    readOnlyHint: 'Macro sessions are read-only — you cannot send messages here',
  },
} as const satisfies MessageSchema;
