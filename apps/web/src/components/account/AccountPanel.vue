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
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useAuthStore } from '@/stores/auth'
import { membershipApi, subscriptionLabel } from '@/services/users-api'
import BrandPatternAvatar from './BrandPatternAvatar.vue'

const auth = useAuthStore()

const nickname = computed(() => auth.user?.nickname || '未登录')
const phone = computed(() => auth.user?.phone || '')
const accountId = computed(() => auth.user?.id || '')

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

/// ── 头像上传（最简实现）──
const fileInput = ref<HTMLInputElement | null>(null)
const uploading = ref(false)

function pickAvatar() {
  fileInput.value?.click()
}

async function onAvatarPicked(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // 允许连续选同一文件再次触发
  if (!file || uploading.value) return
  if (!file.type.startsWith('image/')) {
    ElMessage.error('请选择图片文件')
    return
  }
  uploading.value = true
  try {
    const dataUrl = await compressImage(file)
    const { data } = await membershipApi.updateAvatar(dataUrl)
    if (auth.user) auth.user.avatar = data.data.avatar ?? undefined
    ElMessage.success('头像已更新')
  } catch (err) {
    const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
    ElMessage.error(msg ?? '头像上传失败，请重试')
  } finally {
    uploading.value = false
  }
}

/**
 * 压缩到 256×256 再上传：原图动辄几 MB，data URL 一次请求扛不住；
 * 顺带统一输出 jpeg，避免把 HEIC 之类浏览器读不了的格式传上去。
 */
function compressImage(file: File, size = 256): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.onload = () => {
      const img = new Image()
      img.onerror = () => reject(new Error('图片解析失败'))
      img.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d')
        if (!ctx) return reject(new Error('canvas 不可用'))
        const side = Math.min(img.width, img.height) // 居中裁剪成正方形，避免拉伸变形
        ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size)
        resolve(canvas.toDataURL('image/jpeg', 0.85))
      }
      img.src = String(reader.result)
    }
    reader.readAsDataURL(file)
  })
}
</script>

<template>
  <div class="acc-panel">
    <section class="acc-card acc-card--id">
      <button type="button" class="acc-avatar-btn" :disabled="uploading" @click="pickAvatar">
        <BrandPatternAvatar
          :src="auth.user?.avatar"
          :seed="auth.user?.id ?? 'anonymous'"
          :name="nickname"
          size="lg"
          class="acc-avatar"
        />
        <span class="acc-avatar-mask">{{ uploading ? '上传中' : '更换' }}</span>
      </button>
      <input ref="fileInput" type="file" accept="image/*" class="acc-file" @change="onAvatarPicked">
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
.acc-avatar-btn {
  position: relative;
  border: none;
  padding: 0;
  border-radius: var(--lnk-radius-full);
  overflow: hidden;
  cursor: pointer;
  flex-shrink: 0;
  line-height: 0;
}
.acc-avatar-mask {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--lnk-text-2xs);
  line-height: 1.2;
  color: var(--lnk-text-on-accent);
  background: rgb(0 0 0 / 45%);
  opacity: 0;
  transition: opacity var(--lnk-duration-fast) var(--lnk-ease-standard);
}
.acc-avatar-btn:hover .acc-avatar-mask,
.acc-avatar-btn:focus-visible .acc-avatar-mask {
  opacity: 1;
}
.acc-file {
  display: none;
}
.acc-avatar {
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
</style>