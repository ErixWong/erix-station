// 全局 key 类型（vue-i18n 官方 TypeScript 支持的「全局作用域类型」方式）：
// 把 zh-CN 的消息 schema 注入 DefineLocaleMessage，组件内 useI18n().t() / 模板 $t() 的 key
// 便受类型约束（错误 key 无补全、拼错可被 IDE/tsc 提示）。
// 仅类型声明，无运行时产物。

import type { MessageSchema } from './locales/zh-CN';

declare module 'vue-i18n' {
  export interface DefineLocaleMessage extends MessageSchema {}
}
