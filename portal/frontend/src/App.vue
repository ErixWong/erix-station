<script setup lang="ts">
// 应用外壳。#255：受限会话（`users.must_change_password=true`）时整页换成强制改密屏——
// 这里是「关不掉」的**第一道**机制：<router-view /> 走 v-else ⇒ 工作台 / 会话视图 / 管理台布局
// 整棵子树根本不挂载（顶栏 ☰ 导航、管理台链接、登出按钮都不存在），与「一个可关闭的 modal」是两回事。
// 第二道在 router.ts 的全局守卫：受限态下任何导航（含手改 URL、深链 #/session/<id>、前进/后退、
// 以及登录后访问 /login）都被改写到 /change-password。
// 唯一的离开方式是服务端把旗标清掉：改密成功后 store 会重新 `GET /api/me` 取真实旗标。
import { useAuthStore } from './stores/auth';
import ForcePasswordChangeView from './views/ForcePasswordChangeView.vue';

const auth = useAuthStore();
</script>

<template>
  <ForcePasswordChangeView v-if="auth.passwordChangeRequired" />
  <router-view v-else />
</template>
