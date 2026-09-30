// English messages（issue #101 P1）。键集必须与 locales/zh-CN.ts 完全一致：
// `satisfies MessageSchema` 会在漏译（缺键）或多译（多余键）时编译报错。
// 语言名保持母语自名（中文 / English），不随当前 locale 翻译。

import type { MessageSchema } from './zh-CN';

export const en = {
  common: {
    copy: 'Copy',
    copied: 'Copied',
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
} as const satisfies MessageSchema;
