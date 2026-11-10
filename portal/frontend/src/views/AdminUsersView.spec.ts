// issue #449 二选一的**管理台**判据（工单 §三）：`mail_otp_enabled` 对已绑 TOTP 的账号不再是死开关。
//
// 手法：本视图（1300+ 行、要桩一整套 admin 端点）没有行为级夹具，沿用本仓库既有的**源码级结构判据**
// （同 `LoginView.spec.ts` 的 `?raw` 用例）+ 直接断 locale 文案对象。
// 覆盖：① 开关不置灰；② TOTP 用户走「替代方式」标签 + 说明（且说明点名 `email_code_alt`）；
// ③ 非 TOTP 用户文案一字不改；④ 旧的「本开关不影响」死开关文案彻底退场（zh/en 都删）。
import { describe, expect, it } from 'vitest';
import adminUsersViewSource from './AdminUsersView.vue?raw';
import { zhCN } from '../i18n/locales/zh-CN';
import { en } from '../i18n/locales/en';

/**
 * 邮件验证码开关那一块（从 section 开头到保存按钮）。
 * feat-261110-02：控制件从 `<input type=checkbox data-test=…>` 换成了 `<ToggleSwitch test-id=…>`
 * ⇒ 锚点从 checkbox 本体改到 section 开头（取的是原来那块的一个超集），**断言语义一条没删**。
 */
const MAIL_OTP_BLOCK = adminUsersViewSource.slice(
  adminUsersViewSource.indexOf('data-test="mail-otp-section"'),
  adminUsersViewSource.indexOf('data-test="save-mail-otp"'),
);
/** 开关本体那一个标签（`<ToggleSwitch … />`）。 */
const SWITCH_TAG = MAIL_OTP_BLOCK.match(/<ToggleSwitch[\s\S]*?\/>/)?.[0] ?? '';

describe('#449 管理台：TOTP 账号的邮件验证码开关不再是死开关', () => {
  it('开关本体没有被置灰（TOTP 账号也能真打开它）', () => {
    expect(MAIL_OTP_BLOCK, '找不到邮件验证码开关那一块').not.toBe('');
    expect(SWITCH_TAG, '找不到开关本体').not.toBe('');
    expect(SWITCH_TAG, 'test id 必须还在开关上（旧用例的选择器靠它）').toContain('test-id="mail-otp-enabled"');
    expect(MAIL_OTP_BLOCK, '旧的裸勾选框必须退场，否则「醒目 switch」根本没落地').not.toContain('type="checkbox"');
    // 旧的「死开关」形态 = 因 `totp_enabled` 而置灰。换成 ToggleSwitch 后它仍可以因「请求在途」禁用，
    // 所以断言从「一个 :disabled 也不能有」改成「:disabled 的取值里不得出现 TOTP」——语义更窄且不失原意。
    const disabledBinding = SWITCH_TAG.match(/:disabled="([^"]*)"/)?.[1] ?? '';
    expect(disabledBinding, '禁用不得因 TOTP 而起（置灰 = 死开关的旧形态）').not.toMatch(/totp|editUser/i);
    expect(disabledBinding, '禁用只应来自请求在途').toContain('mailOtpBusy');
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
});
