<script setup lang="ts">
// #255 路由表里 `/change-password` 那条的组件：**故意什么都不渲染**。
//
// 为什么存在：受限态下 `/change-password` 必须是一个**真实可达的路由**（守卫的改写落点、
// 地址栏手敲 #/change-password 的深链、`router.replace` 的目的地都要能命中它），
// 但**画面的唯一渲染点是 App.vue 的闸门**（`<ForcePasswordChangeView v-if="passwordChangeRequired">`）。
//
// 为什么不能在这里再挂一次本体（① 的残余风险，② 顺手统一掉）：改密成功的那一刻
// `passwordChangeRequired` 先翻成 false（App 闸门随即切到 `<router-view />`），
// 而 `router.replace(落地页)` 还在后面一帧 ⇒ 中间这一帧路由仍停在 /change-password。
// 路由表若挂本体，就会「App 闸门刚卸载一个实例 ⇄ router-view 又挂一个新实例」——
// 人看到的是一整屏表单闪一下又消失（顺带还把已输入的字段与焦点丢掉）。
// ⇒ 这里渲染空，那一帧就是干净的空档，而不是「同组件重挂一帧」。
</script>

<template>
  <!-- 无内容：见上面注释。断言见 ForcePasswordChangeView.spec.ts 的「同组件不重挂」用例。 -->
</template>
