// issue #449 二选一的**管理台**判据（工单 §三）：`mail_otp_enabled` 对已绑 TOTP 的账号不再是死开关。
//
// 手法：本视图（1400+ 行、要桩一整套 admin 端点）没有行为级夹具，沿用本仓库既有的**源码级结构判据**
// （同 `LoginView.spec.ts` 的 `?raw` 用例）+ 直接断 locale 文案对象。
// 覆盖：① 开关不置灰；② TOTP 用户走「替代方式」标签 + 说明（且说明点名 `email_code_alt`）；
// ③ 非 TOTP 用户文案一字不改；④ 旧的「本开关不影响」死开关文案彻底退场（zh/en 都删）；
// ⑤（feat-261110-03）控制件必须是原生勾选框，手搓 switch 已退场。
import { describe, expect, it } from 'vitest';
import adminUsersViewSource from './AdminUsersView.vue?raw';
import { zhCN } from '../i18n/locales/zh-CN';
import { en } from '../i18n/locales/en';

/**
 * 「二次验证」那一档里两个勾选框所在的那一块（feat-261110-03）。
 * 勾选框刻意住在折叠块**外面**：否则「取消勾选」会把自己和保存按钮一起 v-if 掉 ⇒ 关掉无法提交。
 */
const MFA_FACTORS_BLOCK = adminUsersViewSource.slice(
  adminUsersViewSource.indexOf('data-test="mfa-totp-row"'),
  adminUsersViewSource.indexOf('data-test="totp-settings-section"'),
);
/**
 * 邮件验证码设置那一块（从 section 开头到下一档「LLM」面板的开头）。
 * feat-261110-03：控制件从上一版自实现的「轨道 + 滑块」开关（`role="switch"`）回到原生勾选框
 * `<input type="checkbox" data-test=…>`（用户原话「用checkbox吧，两个checkbox就行」），
 * 但**仍在同一档、同一语义**，断言语义一条没删。
 * feat-261111-01：块内那个「保存邮件码设置」按钮（`data-test="save-mail-otp"`）已删 ⇒ 它不能再当
 * 结束锚点（锚点被删时 `indexOf` 返回 -1，`slice(start, -1)` 会**静默变形而不报错** = 假绿风险）。
 * 改钉仍然存在的下一档开头 `id="edit-panel-llm"`（邮件码块是「二次验证」那一档的最后一块，下一块就是 LLM 面板）：
 * 起点锚点失配 ⇒ 切片为空，下面第一条 `not.toBe('')` 当场红；终点锚点失配 ⇒ 切片不空而是默默胖到文件末尾，
 * 靠下面两条 `not.toContain` 拦（已实测：把锚点改名，那两条就红）。
 */
const MAIL_OTP_BLOCK = adminUsersViewSource.slice(
  adminUsersViewSource.indexOf('data-test="mail-otp-section"'),
  adminUsersViewSource.indexOf('id="edit-panel-llm"'),
);
/** 邮件码勾选框本体那一个标签（`[^>]*` 而不是 `[\s\S]*?`：否则会从 TOTP 那个 input 一路贴过来，
 * 把两个标签的 `:disabled` 当成一个读）。 */
const MAIL_CHECKBOX_TAG = MFA_FACTORS_BLOCK.match(/<input[^>]*data-test="mail-otp-enabled"[^>]*>/)?.[0] ?? '';
const TOTP_CHECKBOX_TAG = MFA_FACTORS_BLOCK.match(/<input[^>]*data-test="mfa-totp-checkbox"[^>]*>/)?.[0] ?? '';

describe('#449 管理台：TOTP 账号的邮件验证码开关不再是死开关', () => {
  it('开关本体没有被置灰（TOTP 账号也能真打开它）', () => {
    expect(MAIL_OTP_BLOCK, '找不到邮件验证码设置那一块').not.toBe('');
    // 但「非空」不够：结束锚点失配时 `indexOf` 返回 -1，`slice(start, -1)` **不报错也不切空**，而是切到
    // 「文件末尾前一字符」⇒ 切片悄悄变胖（实测从 ~1.3KB 胖到整份文件）而下面的 toContain 照绿。
    // 所以还得钉「没越界」：下一档（LLM 面板）的东西一律不得出现在这一块里。
    // （这条本身也有牙：把 `id="edit-panel-llm"` 改名跑一下，这里就红。）
    expect(MAIL_OTP_BLOCK, '结束锚点失效：切片已越界到下一档').not.toContain('id="edit-panel-llm"');
    expect(MAIL_OTP_BLOCK, '结束锚点失效：切片里出现了 LLM 面板本体').not.toContain('UserLlmPane');
    expect(MAIL_CHECKBOX_TAG, '找不到邮件码勾选框本体').not.toBe('');
    expect(MAIL_CHECKBOX_TAG, 'test id 必须还在开关上（旧用例的选择器靠它）').toContain('data-test="mail-otp-enabled"');
    expect(MAIL_CHECKBOX_TAG, '必须是原生勾选框').toContain('type="checkbox"');
    // 旧的「死开关」形态 = 因 `totp_enabled` 而置灰。勾选框仍可以因「请求在途」禁用，
    // 所以断言从「一个 :disabled 也不能有」改成「:disabled 的取值里不得出现 TOTP」——语义更窄且不失原意。
    const disabledBinding = MAIL_CHECKBOX_TAG.match(/:disabled="([^"]*)"/)?.[1] ?? '';
    expect(disabledBinding, '禁用不得因 TOTP 而起（置灰 = 死开关的旧形态）').not.toMatch(/totp|editUser/i);
    // feat-261111-01：在途闸从旧的 `mailOtpBusy`（块内那个单独保存按钮专用）换成共用保存动作的 `mfaBusy`。
    // 语义一字未动：「禁用只应来自请求在途」——只是那个已退场的 ref 不能再当字面锚点。
    expect(disabledBinding, '禁用只应来自请求在途').toContain('mfaBusy');
  });

  it('未绑定 TOTP ⇒ 那一位的勾选框禁用并说「未绑定」（而不是让人勾一个走不通的因素）', () => {
    expect(TOTP_CHECKBOX_TAG, '找不到 TOTP 勾选框本体').not.toBe('');
    expect(TOTP_CHECKBOX_TAG.match(/:disabled="([^"]*)"/)?.[1] ?? '',
      '禁用必须来自「有没有绑密钥」').toContain('editUser.totp_enabled');
    expect(TOTP_CHECKBOX_TAG, '勾的值必须是 totp_login_enabled（不是 totp_enabled）')
      .toContain('v-model="editForm.totp_login_enabled"');
    expect(MFA_FACTORS_BLOCK, '「未绑定」文案必须挂在同一行')
      .toContain("t('admin.fde.totpNotEnrolled')");
    expect(MFA_FACTORS_BLOCK, '绑定按钮必须在这一行上（未绑定时它是唯一出口，不新造按钮）')
      .toMatch(/v-if="!editUser\.totp_enabled"[\s\S]*?data-test="confirm-totp-enroll"/);
  });

  it('勾选框取代了自实现的 switch：整视不得再有 role="switch" / aria-checked 的手搓开关', () => {
    expect(adminUsersViewSource, '本视图不得再出现自实现的 switch').not.toContain('role="switch"');
    expect(adminUsersViewSource, '本视图不得再有手搓 switch 的 aria-checked').not.toMatch(/<button[\s\S]*?aria-checked/);
    // 上一版「旧的裸勾选框必须退场」的锚点已随用户改口径而反转：勾选框才是这一版的交付形态，
    // 而且这一档恰好两个（TOTP / 邮件码）。
    expect(MFA_FACTORS_BLOCK.match(/type="checkbox"/g), '两个勾选框都得是原生 checkbox').toHaveLength(2);
  });

  it('标签与说明按 `totp_enabled` 分叉：TOTP 用户看到「作为 TOTP 的替代方式」+ 审计口径说明', () => {
    expect(MAIL_OTP_BLOCK).toContain(
      "{{ editUser.totp_enabled ? t('admin.fde.mailOtpEnabledLabelAlt') : t('admin.fde.mailOtpEnabledLabel') }}",
    );
    expect(MAIL_OTP_BLOCK).toContain(
      "{{ editUser.totp_enabled ? t('admin.fde.mailOtpAltHint') : t('admin.fde.mailOtpEnabledHint') }}",
    );
    // 旧的死开关提示行必须退场（否则「替代方式」和「本开关不影响」同屏互相打脸）。
    expect(adminUsersViewSource).not.toContain('mailOtpHiddenByTotp');
  });

  it('文案成对且口径正确：zh/en 都有替代标签与说明，说明点名 email_code_alt', () => {
    const zhFde = zhCN.admin.fde as unknown as Record<string, string>;
    const enFde = en.admin.fde as unknown as Record<string, string>;

    expect(zhFde.mailOtpEnabledLabelAlt).toBe('邮件验证码（作为 TOTP 的替代方式）');
    expect(zhFde.mailOtpAltHint).toContain('TOTP 或邮箱验证码任一通过');
    expect(zhFde.mailOtpAltHint).toContain('email_code_alt');
    expect(enFde.mailOtpEnabledLabelAlt).toBe('Email code (as an alternative to TOTP)');
    expect(enFde.mailOtpAltHint).toContain('either TOTP or an emailed code');
    expect(enFde.mailOtpAltHint).toContain('email_code_alt');

    // 非 TOTP 用户的文案保持现状（工单 §三：未绑 TOTP 时文案不变）。
    expect(zhFde.mailOtpEnabledLabel).toBe('登录时要求邮箱验证码');
    expect(enFde.mailOtpEnabledLabel).toBe('Require an emailed code at sign-in');
    expect(zhFde.mailOtpEnabledHint).toBe('关闭时该用户只用口令登录（没有第二因素）。');
    // 「此项不生效」这句已经不再成立（TOTP 账号现在会拿到二选一），留在文案里就是假话。
    expect(zhFde.mailOtpEnabledHint).not.toContain('不生效');
    expect(enFde.mailOtpEnabledHint).not.toMatch(/ignore|no effect/);
    // 死开关时代的键彻底删掉（zh/en 同步删，localeParity 兜另一半）。
    expect(zhFde.mailOtpHiddenByTotp).toBeUndefined();
    expect(enFde.mailOtpHiddenByTotp).toBeUndefined();
  });

  // 工单 feat-261110-03 §2.7：键集对齐由 localeParity 兜，这里额外钉「警告文案真的两边都写了、
  // 且说的确实是“没第二因素”」（否则红字会变成未翻译的键名，或把“没勾”误写成“没第二因素”）。
  it('zh/en 都有 mailOtpSwitchWarning，且口径是「只用口令登录（无第二因素）」', () => {
    const zhFde = zhCN.admin.fde as unknown as Record<string, string>;
    const enFde = en.admin.fde as unknown as Record<string, string>;
    for (const [locale, bag] of [['zh-CN', zhFde], ['en', enFde]] as const) {
      expect(bag.mailOtpSwitchWarning, `${locale} 缺 mailOtpSwitchWarning`).toBeTruthy();
      expect(bag.mailOtpSwitchWarning, `${locale} 空串`).not.toBe('');
      expect(bag.mailOtpSwitchWarning, `${locale} 不得漏翻译（界面会把键名直接打出来）`)
        .not.toMatch(/admin\.fde\.|mailOtpSwitchWarning/);
      expect(bag.mailOtpSwitchWarning, `${locale} 必须说清没有第二因素`).toMatch(/口令|password/i);
      expect(bag.mailOtpSwitchWarning, `${locale} 必须说清没有第二因素`).toMatch(/第二因素|second factor/i);
      // 新增键必须成对（删一边、加一边会被 localeParity 抓，但漏两个都漏情能跟过那里）。
      for (const key of ['totpLoginEnabledLabel', 'totpEnrolledState', 'totpNotEnrolled',
        'saveMfaSettings', 'mfaSettingsSaved', 'mailOtpCheckboxLabel']) {
        expect(bag[key], `${locale} 缺 admin.fde.${key}`).toBeTruthy();
      }
    }
    expect(zhFde.totpNotEnrolled).toBe('未绑定');
    expect(enFde.totpNotEnrolled).toBe('Not enrolled');
    expect(zhFde.totpLoginEnabledLabel).toBe('验证器应用（TOTP）');
    // 上一版为手搓 switch 加的左右档位文案已退场（控件形态变了，留着就是孤儿键）。
    expect(zhFde.mailOtpSwitchOff).toBeUndefined();
    expect(enFde.mailOtpSwitchOff).toBeUndefined();
    expect(zhFde.mailOtpSwitchOn).toBeUndefined();
    expect(enFde.mailOtpSwitchOn).toBeUndefined();
  });
});

// issue #497（工单 feat-261112-01，迁移 0031）：用户列表第 8 格从「最近登录」换成「最后活动 + 登录于 …」两行。
// 沿用本文件的**源码级结构判据**手法（DOM 断言在 `AdminView.spec.ts`，那边是真 mount）。
// 这里钉的是「形状不许漂」：列数、两行结构、副行的 v-if、无硬编码中文、空值措辞分开。
describe('issue #497：第 8 格的两行结构（列数不变、无硬编码中文、两个「从未」分开）', () => {
  const CJK = /[\u4e00-\u9fff]/;
  /** 活动格本体：主行锚点开头 → 最近的一个 `</td>`（锚点失配 ⇒ 切片为空，第一条断言当场红）。 */
  const activityCell = (() => {
    const start = adminUsersViewSource.indexOf('data-test="user-activity-main"');
    if (start === -1) return '';
    const end = adminUsersViewSource.indexOf('</td>', start);
    return end === -1 ? adminUsersViewSource.slice(start) : adminUsersViewSource.slice(start, end);
  })();
  /** 表头那一格（第 8 个 `<th scope="col">`）。 */
  const headerCells = [...adminUsersViewSource.matchAll(/<th scope="col"[^>]*>([\s\S]*?)<\/th>/g)].map((m) => m[1]);
  /**
   * 剥掉**注释**（HTML 注释、块注释、整行 `//` 注释），只留会真的渲染/执行的部分。
   * 中文注释是给人读的，不算硬编码；但整行注释以外的中文（模板文本、字符串字面量）算。
   */
  const noComments = (text: string) => text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/[^\n]*$/gm, '');

  it('列数与列宽一字未改：9 个 col / 9 个 th / 行内 9 个 td（不许新增列把 th[8] 往后挤）', () => {
    expect(adminUsersViewSource.match(/<col /g) ?? [], 'colgroup 列数').toHaveLength(9);
    expect(adminUsersViewSource.match(/<th scope="col"/g) ?? [], '表头列数').toHaveLength(9);
    // 第 8 格（下标 7）的语义已换成「最后活动」，且旧键 `lastLogin` 不再出现在表头里
    expect(headerCells[7] ?? '').toContain("t('admin.fde.lastActivity')");
    expect(adminUsersViewSource, '旧表头键必须退场（没换语义 = 这格还在说登录）')
      .not.toMatch(/<th[^>]*>\{\{ t\('admin\.fde\.lastLogin'\) \}\}<\/th>/);
  });

  it('两行结构：主行 = 活动，副行小字 = 登录于 …，且副行在从未登录时整行不渲染', () => {
    expect(activityCell, '找不到活动格（锚点 data-test="user-activity-main" 被改名了？）').not.toBe('');
    expect(activityCell).toContain("formatLastActivity(user.last_activity_at)");
    expect(activityCell).toContain('data-test="user-login-sub"');
    // 副行必须是**小字**（「副行」是设计判据）且带 v-if —— 没有 v-if 就会渲染出「登录于 从未登录」这种病句
    const subTag = /<span[^>]*data-test="user-login-sub"[^>]*>/.exec(activityCell)?.[0] ?? '';
    expect(subTag, '找不到副行的 span 标签本体').not.toBe('');
    expect(subTag).toMatch(/text-xs/);
    expect(subTag).toMatch(/v-if="user\.last_login_at"/);
    // M5 回归锚（真机 e2e 抓到的）：**两行都必须带 `:title`**。旧版是整格 `<td :title>`，
    // 两行化后主行自己带了、副行漏了 ⇒ 被列宽截断的那一行 hover 不出全文，既有能力丢了。
    // 注意切片的起点：`activityCell` 是从主行的 `data-test` **那一刻**开始切的，`<span` 在切片之前，
    // 所以主行的标签本体要去整份源码里取（这个 data-test 全文件唯一）。
    const mainTag = /<span[^>]*data-test="user-activity-main"[^>]*>/.exec(adminUsersViewSource)?.[0] ?? '';
    expect(mainTag, '找不到主行的 span 标签本体').not.toBe('');
    expect(mainTag).toMatch(/:title="formatLastActivity\(user\.last_activity_at\)"/);
    expect(subTag).toMatch(/:title="t\('admin\.fde\.loginAt', \{ time: formatLastLogin\(user\.last_login_at\) \}\)"/);
    // 副行的 title 与显示文本必须是**同一个模板调用**（两处各写一遍同一句），
    // 只有一个来源时它们迟早会漂（title 说一个时刻、显示另一个时刻）。
    const subRest = activityCell.slice(activityCell.indexOf('data-test="user-login-sub"'));
    expect(subRest.match(/t\('admin\.fde\.loginAt'/g) ?? [], '副行的 title 与文本必须同形两处')
      .toHaveLength(2);
    // 副行取的是 last_login_at（另一条时间线），主行取的是 last_activity_at —— 两行不许读同一个值
    expect(activityCell).toContain('formatLastLogin(user.last_login_at)');
    expect(activityCell.match(/last_activity_at/g) ?? [], '主行必须读 last_activity_at').not.toHaveLength(0);
  });

  it('那一格没有硬编码中文（文案全部走 t()；注释里的中文不算）', () => {
    const rendered = noComments(activityCell);
    expect(rendered, `活动格里出现硬编码文案：${rendered}`).not.toMatch(CJK);
    // 组件任何地方都不许把这四个词当**文案**写死（写在注释里不算，见 noComments）。
    // 只查模板文本与字符串字面量：先剥注释，再要求四个词一个都不出现。
    for (const word of ['从未活动', '从未登录', '最后活动', '登录于']) {
      expect(noComments(adminUsersViewSource), `组件里不许硬编码「${word}」`)
        .not.toContain(word);
    }
  });

  it('空值措辞两个词分开，且都不许写成「今天」/空串；副行是带占位的模板', () => {
    const zhFde = zhCN.admin.fde as unknown as Record<string, string>;
    const enFde = en.admin.fde as unknown as Record<string, string>;
    // 成对存在（漏一边 localeParity 也会抓，这里点名是为了失败信息可操作）
    for (const [locale, bag] of [['zh-CN', zhFde], ['en', enFde]] as const) {
      for (const key of ['lastActivity', 'neverActive', 'loginAt']) {
        expect(bag[key], `${locale} 缺 admin.fde.${key}`).toBeTruthy();
        expect(bag[key], `${locale} admin.fde.${key} 不许空串`).not.toBe('');
        expect(bag[key], `${locale} admin.fde.${key} 不许漏翻译（界面会打键名）`)
          .not.toMatch(/admin\.fde\./);
      }
      // 红线：空值承诺。活动/登录的「从未」文案都不许带「今天/昨天/today/now」这种相对时间口气
      expect(bag.neverActive, `${locale} neverActive 不许承诺相对时间`).not.toMatch(/今天|昨天|现在|today|yesterday|now/i);
      expect(bag.neverLoggedIn, `${locale} neverLoggedIn 同上`).not.toMatch(/今天|昨天|现在|today|yesterday|now/i);
      // 副行必须是「登录于 {time}」这种占位模板：没有 {time} 就说明时间被丢了（或写死在组件里）
      expect(bag.loginAt, `${locale} loginAt 必须带 {time} 占位`).toContain('{time}');
    }
    // 两个「从未」必须是两个不同的词（同一个词 = 界面上分不开「没说过话」和「没进过门」）
    expect(zhCN.admin.fde.neverActive).toBe('从未活动');
    expect(zhCN.admin.fde.neverLoggedIn).toBe('从未登录');
    expect(zhCN.admin.fde.neverActive).not.toBe(zhCN.admin.fde.neverLoggedIn);
    expect(en.admin.fde.neverActive).toBe('Never active');
    expect(en.admin.fde.neverActive).not.toBe(en.admin.fde.neverLoggedIn);
    expect(en.admin.fde.lastActivity).toBe('Last activity');
    expect(en.admin.fde.lastActivity).not.toBe(zhCN.admin.fde.lastActivity);
  });

  it('格式化函数按语义分层：空值措辞各管各的（活动那一格不许回落到「从未登录」）', () => {
    const src = adminUsersViewSource;
    const activityFn = /function formatLastActivity[\s\S]*?\n\}/.exec(src)?.[0] ?? '';
    const loginFn = /function formatLastLogin[\s\S]*?\n\}/.exec(src)?.[0] ?? '';
    expect(activityFn, 'formatLastActivity 退场了？').not.toBe('');
    expect(activityFn).toContain("t('admin.fde.neverActive')");
    expect(activityFn, '活动那一格不许说「从未登录」').not.toContain('neverLoggedIn');
    expect(loginFn).toContain("t('admin.fde.neverLoggedIn')");
    expect(loginFn).not.toContain('neverActive');
    // 不解析出合法时间戳时原样回显（旧行为）——不许发明「今天」这类兜底
    expect(/function formatMoment[\s\S]*?Number\.isNaN\(timestamp\) \? value/.test(src),
      '时间点格式化必须原样回显不可解析的值，而不是造一个兜底词').toBe(true);
  });
});
