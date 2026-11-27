// store 契约面清单（issue #501 抽出的**唯一一份**，两个消费者共用）：
//   · `runner/test/store-contract.test.js`  —— 必需方法断言、#640 退役方法反向自证、上游套件的能力申报；
//   · `runner/test/agentd-store-route.test.js` —— #501 判据 2（`STORE_METHODS` 每一项都要有 agentd case）
//     与判据 3（store 实际暴露的方法集合 = 申报的能力方法集合，逐项相等）。
// 清单只有一份，两个消费者才不会各抄一遍然后漂移（#501 的漏网正是「白名单加了、路由没加、没人比对」）。
//
// ⚠ 能力名 → 方法名的映射以**上游现查**为准（`node_modules/erix-agent/test/contract/transcript-store.js:112-116`
//   的 `OPTIONAL_CAPABILITIES`，该常量未 export ⇒ 这里只能照抄一份；上游改名/加组时上游套件那条
//   「申报的能力名不在名单里」会先红，本表跟着改）。

/** 上游 TranscriptStore 契约点名的方法（必需 + 已申报的 run-state 一族）。 */
export const UPSTREAM_CONTRACT_METHODS = Object.freeze([
  'appendRound', 'load',
  'saveRunState', 'loadRunState', 'markRunState',
  'loadRunStateStatus',
]);

/** issue #640：整条退役（IPC 白名单 / agentd 路由 / portal 端点 / 快照表都删了），不得再出现在任何一面。 */
export const RETIRED_STORE_METHODS = Object.freeze(['saveRunSnapshot', 'loadLatestRunSnapshot']);

/** legacy 兼容项：`recall` 不属于 0.14.0 契约方法（0.8.0 退役），U7 端点保留只读兼容（issue #43）。 */
export const LEGACY_STORE_METHODS = Object.freeze(['recall']);

/**
 * 本站向上游契约套件**申报**的可选能力（报半组会被判红：申报了却没整组实现 ⇒ 收尾用例红）。
 * 这里是「申报面」的唯一真相源：`store-contract.test.js` 把它直接交给 `transcriptStoreContract`，
 * #501 判据 3 拿它推导「应该存在的方法集合」⇒ 只摘申报不摘实现（或反之）当场就红。
 */
export const DECLARED_OPTIONAL_CAPABILITIES = Object.freeze(['runState', 'runStateStatus', 'rawRows']);

/** 能力名 → 该方法组覆盖的 store 方法名（上游 `OPTIONAL_CAPABILITIES` 同值，见文件头为何要照抄）。 */
export const OPTIONAL_CAPABILITY_METHODS = Object.freeze({
  runState: Object.freeze(['saveRunState', 'loadRunState', 'markRunState']),
  runStateStatus: Object.freeze(['loadRunStateStatus']),
  rawRows: Object.freeze(['loadRawRows']),
  fastPathProbes: Object.freeze(['loadByDedupKey', 'loadMaxRound']),
});

/**
 * 引擎 0.32+/0.33.0 的**账本恢复行**三件套（issue #500）：引擎按方法名单独探测，但上游
 * `OPTIONAL_CAPABILITIES` 里**没有**对应的能力名 ⇒ 它落在「能力申报」之外，判据 3 要把它算进申报面，
 * 否则「实现了却没申报」在这一族上是隐身的那一面（#501 判据 3 要堵的正是这个空档）。
 */
export const ENGINE_LOCAL_STORE_METHODS = Object.freeze([
  'appendRecoveryRow', 'listRecoveryRows', 'clearRecoveryRows',
]);

/** 申报面推导出的「应当存在的方法集合」（判据 3 的一侧；逐项相等才算声明 = 实现）。 */
export function declaredStoreMethods() {
  const methods = new Set(UPSTREAM_CONTRACT_METHODS);
  for (const capability of DECLARED_OPTIONAL_CAPABILITIES) {
    const group = OPTIONAL_CAPABILITY_METHODS[capability];
    if (group === undefined) {
      throw new Error(`申报了未知能力 ${capability}（不在 OPTIONAL_CAPABILITY_METHODS 名单里）`);
    }
    for (const method of group) methods.add(method);
  }
  for (const method of ENGINE_LOCAL_STORE_METHODS) methods.add(method);
  for (const method of LEGACY_STORE_METHODS) methods.add(method);
  return methods;
}
