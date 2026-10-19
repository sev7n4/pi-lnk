<script setup lang="ts">
/**
 * PC「我的积分」页 —— 外壳，内容由共享面板 PointsPanel 承载。
 * 「明细」复用个人中心已有的用量 Tab（UsageDayTable + 流水），不重复造轮子。
 */
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import PointsPanel from '@/components/points/PointsPanel.vue'
import TopupModal from '@/components/membership/TopupModal.vue'

const router = useRouter()
const showTopup = ref(false)

function back() {
  if (window.history.length > 1) router.back()
  else router.replace('/profile')
}
</script>

<template>
  <div class="pt-page">
    <header class="pt-page-head">
      <button type="button" class="pt-page-back" @click="back">‹ 返回</button>
      <h1 class="pt-page-title">我的积分</h1>
    </header>
    <PointsPanel @open-usage="router.push('/profile?tab=billing')" @open-topup="showTopup = true" />
    <TopupModal v-model="showTopup" />
  </div>
</template>

<style scoped>
.pt-page {
  max-width: 720px;
  margin: 0 auto;
  padding: var(--lnk-space-6) var(--lnk-pad-panel);
  display: flex;
  flex-direction: column;
  gap: var(--lnk-space-5);
}
.pt-page-head {
  display: flex;
  align-items: center;
  gap: var(--lnk-space-3);
}
.pt-page-back {
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
  font-size: var(--lnk-text-sm);
  color: var(--lnk-text-secondary);
}
.pt-page-back:hover {
  color: var(--lnk-text-primary);
}
.pt-page-title {
  margin: 0;
  font-size: var(--lnk-text-xl);
  font-weight: 700;
  color: var(--lnk-text-primary);
}
</style>
