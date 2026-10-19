<script setup lang="ts">
/**
 * PC「我的订阅」页 —— 外壳（页头 + 返回），内容全部交给共享面板 SubscriptionPanel。
 * 移动端同一个面板挂在 pane 里，两端只有导航壳不同。
 */
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import SubscriptionPanel from '@/components/membership/SubscriptionPanel.vue'
import MembershipModal from '@/components/membership/MembershipModal.vue'

const router = useRouter()
const showPlans = ref(false)

function back() {
  if (window.history.length > 1) router.back()
  else router.replace('/profile')
}
</script>

<template>
  <div class="sub-page">
    <header class="sub-page-head">
      <button type="button" class="sub-page-back" @click="back">‹ 返回</button>
      <h1 class="sub-page-title">我的订阅</h1>
    </header>
    <SubscriptionPanel @open-plans="showPlans = true" />
    <MembershipModal v-model="showPlans" />
  </div>
</template>

<style scoped>
.sub-page {
  max-width: 720px;
  margin: 0 auto;
  padding: var(--lnk-space-6) var(--lnk-pad-panel);
  display: flex;
  flex-direction: column;
  gap: var(--lnk-space-5);
}
.sub-page-head {
  display: flex;
  align-items: center;
  gap: var(--lnk-space-3);
}
.sub-page-back {
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
  font-size: var(--lnk-text-sm);
  color: var(--lnk-text-secondary);
}
.sub-page-back:hover {
  color: var(--lnk-text-primary);
}
.sub-page-title {
  margin: 0;
  font-size: var(--lnk-text-xl);
  font-weight: 700;
  color: var(--lnk-text-primary);
}
</style>
