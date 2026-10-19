<script setup lang="ts">
/**
 * 账号信息（移动端「我的」二级卡片，双端共用面板）
 *
 * 范围（2026-10-19 用户裁决）：**只做账号信息展示**。
 * 系统当前是手机号 + 短信验证码登录，User 模型没有 password 字段、服务端也没有任何
 * 密码机制 —— 在没有真密码能力的前提下展示「密码」入口会是个假按钮（点了没反应，
 * 正是本轮要消灭的体验问题），故本期不出现密码相关项。后续接入密码能力时再扩。
 *
 * 视觉：与 SubscriptionPanel / PointsPanel 同构（同一套卡片 + 令牌），保持风格一致。
 */
import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { subscriptionLabel } from '@/services/users-api'
import { BRAND_LOGO_URL } from '@/constants/brand'

const auth = useAuthStore()

const nickname = computed(() => auth.user?.nickname || '未登录')
const phone = computed(() => auth.user?.phone || '')
const accountId = computed(() => auth.user?.id || '')
/// 用户自定义头像优先，缺省回落品牌吉祥物。
const avatarUrl = computed(() => auth.user?.avatar || BRAND_LOGO_URL)

/// 手机号脱敏：138****8000。账号信息展示不应泄露完整号码。
const maskedPhone = computed(() => {
  const p = phone.value
  if (!p) return '—'
  if (p.length < 7) return p
  return `${p.slice(0, 3)}****${p.slice(-4)}`
})

function formatDate(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 8 * 3600 * 1000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`
}
const createdAt = computed(() => (auth.user?.createdAt ? formatDate(auth.user.createdAt) : '—'))
</script>

<template>
  <div class="acc-panel">
    <section class="acc-card acc-card--id">
      <img :src="avatarUrl" alt="" class="acc-avatar" draggable="false">
      <div class="acc-id-text">
        <p class="acc-name">{{ nickname }}</p>
        <p class="acc-sub">{{ maskedPhone }}</p>
      </div>
    </section>

    <section class="acc-card">
      <h3 class="acc-title">账号信息</h3>
      <dl class="acc-rows">
        <div class="acc-row">
          <dt>昵称</dt>
          <dd>{{ nickname }}</dd>
        </div>
        <div class="acc-row">
          <dt>手机号</dt>
          <dd>{{ maskedPhone }}</dd>
        </div>
        <div class="acc-row">
          <dt>账号 ID</dt>
          <dd class="acc-mono">{{ accountId }}</dd>
        </div>
        <div class="acc-row">
          <dt>注册时间</dt>
          <dd>{{ createdAt }}</dd>
        </div>
        <div class="acc-row">
          <dt>当前套餐</dt>
          <dd>{{ subscriptionLabel(auth.user?.membership) }}</dd>
        </div>
      </dl>
    </section>

    <section class="acc-card">
      <h3 class="acc-title">登录方式</h3>
      <div class="acc-row">
        <dt>验证方式</dt>
        <dd>手机号验证码</dd>
      </div>
    </section>

    <p class="acc-note">
      如需修改手机号或昵称，请联系官方客服（sev7nseason@outlook.com）处理。
    </p>
  </div>
</template>

<style scoped>
.acc-panel {
  display: flex;
  flex-direction: column;
  gap: var(--lnk-space-4);
  min-width: 0;
}
.acc-card {
  display: flex;
  flex-direction: column;
  gap: var(--lnk-space-3);
  padding: var(--lnk-pad-card);
  border: 1px solid var(--lnk-border-default);
  border-radius: var(--lnk-radius-xl);
  background: var(--lnk-surface-raised);
  min-width: 0;
  box-sizing: border-box;
}
.acc-card--id {
  flex-direction: row;
  align-items: center;
  gap: var(--lnk-space-3);
}
.acc-avatar {
  width: 48px;
  height: 48px;
  border-radius: var(--lnk-radius-full);
  object-fit: contain;
  background: var(--neo-brand-gradient);
  flex-shrink: 0;
}
.acc-id-text {
  min-width: 0;
}
.acc-name {
  margin: 0;
  font-size: var(--lnk-text-lg);
  font-weight: 700;
  color: var(--lnk-text-primary);
}
.acc-sub {
  margin: 2px 0 0;
  font-size: var(--lnk-text-2xs);
  color: var(--lnk-text-muted);
}
.acc-title {
  margin: 0;
  font-size: var(--lnk-text-sm);
  font-weight: 600;
  color: var(--lnk-text-primary);
}
.acc-rows {
  display: flex;
  flex-direction: column;
  gap: var(--lnk-space-2);
  margin: 0;
}
.acc-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--lnk-space-3);
  font-size: var(--lnk-text-sm);
  min-width: 0;
}
.acc-row dt {
  color: var(--lnk-text-secondary);
  flex-shrink: 0;
}
.acc-row dd {
  margin: 0;
  color: var(--lnk-text-primary);
  font-weight: 600;
  text-align: right;
  word-break: break-all;
  min-width: 0;
}
.acc-mono {
  font-family: var(--lnk-font-mono, ui-monospace, monospace);
  font-size: var(--lnk-text-2xs);
}
.acc-note {
  margin: 0;
  font-size: var(--lnk-text-2xs);
  line-height: 1.8;
  color: var(--lnk-text-muted);
}
</style>