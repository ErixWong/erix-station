// 默认语言（zh-CN）——i18n key 的权威来源（issue #101 P1）。
//
// 约定：
//   ① 新增文案一律先加在这里，再补 en.ts 对译（en.ts 用 `satisfies MessageSchema` 保证键集一致）；
//   ② 命名空间按页面/组件划分：本阶段只有 login.*（登录页）与 locale.*（语言切换菜单自身），
//      P2 起补 workbench.* / sidebar.* / stream.* / composer.* / admin.* / picker.* / errors.*；
//   ③ `as const` 保留字面量类型，供 vue-i18n 泛型与 DefineLocaleMessage 推导 key 类型；
//   ④ 语言名（locale.zhCN / locale.en）用母语自名（endonym），两种语言下取值相同，不随当前 locale 翻译。

export const zhCN = {
  // 跨页面复用骨架（P2 起填充；此处先放已知复用项）
  common: {
    copy: '复制',
    copied: '已复制',
  },
  // 语言切换菜单自身文案
  locale: {
    label: '语言',
    zhCN: '中文',
    en: 'English',
  },
  // 登录页（views/LoginView.vue）——覆盖该视图全部用户可见文案。
  // 注意：登录失败/校验失败的提示来自 auth store（auth.error），归 P2 的 errors.*，不在此处。
  login: {
    title: 'FDE Station 登录',
    loginName: '登录名',
    password: '口令',
    next: '下一步',
    totpHint: '输入认证器 6 位码（本地账号两步登录）。',
    totpLabel: 'TOTP',
    totpSubmit: '验证并登录',
    backToLogin: '← 返回重新登录',
  },
} as const;

/**
 * 消息 schema：由 zh-CN（key 权威来源）递归推导，叶子值放宽为 string。
 * 用途：① createI18n<[MessageSchema], AppLocale> 泛型；② DefineLocaleMessage 注入（见 ../types.d.ts）。
 * 之所以放宽叶子：en 的文案字面量与 zh-CN 不同，schema 只约束键结构 + 叶子类型（string）。
 */
export type MessageSchema = WidenLeaves<typeof zhCN>;

type WidenLeaves<T> = { [K in keyof T]: T[K] extends string ? string : WidenLeaves<T[K]> };
