<script setup lang="ts">
/**
 * 独立注册/登录页（2026-10-23 用户裁决第 6 点：「点【我的】-退出登录，应直接跳转到
 * 注册登录页，无需跳到品牌页」）。
 *
 * 为什么要有「页」而不只是弹窗（产品决策）：
 *  ① 手机号 + 验证码 + 滑块在窄屏弹窗里会被软键盘顶出视野；满屏页才做得对
 *     （与移动端品牌页同为满屏形态）。
 *  ② 退出登录后的落点要确定：身份事件 ⇒ 回到身份页。弹窗方案会把用户留在
 *     「已无权限的项目页」里——那正是要避免的。
 *  ③ /login 可直达可分享（客服链接、官网注册入口）。
 *
 * 语义链：退出登录 → /login → 登录成功 → /workflow（品牌页）⇒ 登录后过 hero
 * （沿用上一轮裁决「登出重登过品牌页加深印象」，只是把**入口**换成独立登录页）。
 *
 * 表单逻辑复用 LoginFormPanel（不重写登录/注册/验证码），只在此编排：
 * 滑块验证码 → 发码 → 成功跳转。PC 端页内点「登录」仍可用全局弹窗（轻量插进来，
 * 不打断上下文）；本页只承担「退出登录后的确定落点」与「可分享的身份入口」。
 */
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import LoginFormPanel from '@/components/auth/LoginFormPanel.vue'
import SliderCaptchaOverlay from '@/components/auth/SliderCaptchaOverlay.vue'

const router = useRouter()
const auth = useAuthStore()

const formRef = ref<InstanceType<typeof LoginFormPanel> | null>(null)
const showCaptcha = ref(false)
const pendingPhone = ref('')

/** 已登录就别停在登录页 ⇒ 直接去品牌页（/workflow）。 */
onMounted(() => {
  if (auth.isLoggedIn) void router.replace('/workflow')
})

function onRequestSendCode(phone: string) {
  pendingPhone.value = phone
  showCaptcha.value = true
}

function onCaptchaClose() {
  showCaptcha.value = false
  formRef.value?.cancelSending()
}

async function onCaptchaVerified(ticket: string) {
  showCaptcha.value = false
  try {
    await auth.sendCode(pendingPhone.value, ticket)
    formRef.value?.markSendSuccess()
  } catch (err) {
    const ax = err as { code?: string; response?: { status?: number } }
    if (ax.code === 'ECONNABORTED' || ax.response?.status === 502) {
      formRef.value?.setSendError('网络超时，请稍后重试（跨境链路可能较慢）')
    } else {
      formRef.value?.setSendError('验证码发送失败')
    }
  }
}

/** 登录/注册成功 ⇒ 回品牌页（登录后过 hero，加深品牌印象）。 */
function onAuthSuccess() {
  void router.replace('/workflow')
}
</script>

<template>
  <div class="login-page">
    <div class="login-page__panel">
      <LoginFormPanel
        ref="formRef"
        standalone
        class="w-full max-w-[360px]"
        @request-send-code="onRequestSendCode"
        @success="onAuthSuccess"
      />
      <SliderCaptchaOverlay
        v-if="showCaptcha"
        @verified="onCaptchaVerified"
        @close="onCaptchaClose"
      />
    </div>
  </div>
</template>

<style scoped>
/* 恒深签名底（--lnk-surface-signature 两主题同值）⇒ 与品牌页同源：
   登录页是「品牌 → 身份入口」的一段，视觉语言必须是同一个墨色宇宙。
   ⛔ 签名面只用 on-signature 家族令牌（随主题翻转的面板文字色压恒深底会降对比度）。 */
.login-page {
  display: flex;
  min-height: 100vh;
  min-height: 100dvh;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
  background: var(--lnk-surface-signature);
}

/* 移动端满屏：内容顶对齐（拇指区在下方），PC 居中卡片 */
.login-page__panel {
  display: flex;
  width: 100%;
  flex-direction: column;
  align-items: center;
}

@media (min-width: 768px) {
  .login-page__panel {
    justify-content: center;
  }
}
</style>
