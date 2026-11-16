<script setup lang="ts">
/**
 * M1-3 技能发现面板（发现页双区：市场区 + 我的技能区）。
 *
 * - 市场区：拉 /skills/catalog，卡片展示兼容评分/版本/发布者，点「安装」→ install(packageHash)。
 * - 我的技能区：拉 /skills/mine，启停开关 → setEnabled；卸载走**单一确认弹窗**二次确认。
 * - 确认弹窗：cancel 不触发 DELETE，只有 ok 才 remove(id)（M1-3 RED 判据）。
 *
 * 视图只呈现控制面事实：安装默认 enabled=false、信任级别、兼容评分；不假装「生态兼容完成」。
 * 样式只用 design tokens（--lnk-*），不动 z-index 语义阶梯（design-token.test.ts 守卫）。
 */
import { onMounted, ref } from 'vue'
import {
  skillApi,
  type CatalogItem,
  type MineItem,
} from '@/services/skill-api'

const props = withDefaults(defineProps<{ initialTab?: 'market' | 'mine' }>(), { initialTab: 'market' })

const tab = ref<'market' | 'mine'>(props.initialTab)
const catalog = ref<CatalogItem[]>([])
const mine = ref<MineItem[]>([])
const marketLoading = ref(true)
const mineLoading = ref(true)
const marketError = ref(false)

// 单一确认弹窗状态（卸载/删除共用一处）
const confirm = ref<{ id: string; label: string } | null>(null)

async function loadCatalog() {
  marketLoading.value = true
  marketError.value = false
  try {
    catalog.value = await skillApi.catalog()
  } catch {
    catalog.value = []
    marketError.value = true
  } finally {
    marketLoading.value = false
  }
}

async function loadMine() {
  mineLoading.value = true
  try {
    mine.value = await skillApi.mine()
  } catch {
    mine.value = []
  } finally {
    mineLoading.value = false
  }
}

function switchTab(next: 'market' | 'mine') {
  tab.value = next
  if (next === 'mine') void loadMine()
}

async function onInstall(item: CatalogItem) {
  try {
    await skillApi.install(item.packageHash)
    // 安装后默认 enabled=false：若当前在「我的技能」视图则刷新；此处仅刷新 mine 数据供切换时一致
    await loadMine()
  } catch {
    // 视图不吞错：保留卡片，用户可重试（错误详情由网络层日志承担）
  }
}

async function onToggle(item: MineItem) {
  const next = !item.enabled
  try {
    await skillApi.setEnabled(item.id, next)
    item.enabled = next
  } catch {
    // 状态未变，保留原值
  }
}

function askUninstall(item: MineItem) {
  confirm.value = { id: item.id, label: item.displayName }
}

function cancelUninstall() {
  confirm.value = null
}

async function confirmUninstall() {
  const target = confirm.value
  if (!target) return
  confirm.value = null
  try {
    await skillApi.remove(target.id)
    await loadMine()
  } catch {
    // 卸载失败：下次刷新即可见真实状态
  }
}

async function onRollback(item: MineItem) {
  try {
    await skillApi.rollback(item.id)
    await loadMine()
  } catch {
    // 无上一版本等失败：保留原状
  }
}

onMounted(() => {
  void loadCatalog()
  void loadMine()
})
</script>

<template>
  <section class="skill-panel" aria-label="技能中心">
    <div class="tabs" role="tablist">
      <button
        type="button"
        class="tab"
        :class="{ 'is-active': tab === 'market' }"
        :aria-selected="tab === 'market'"
        @click="switchTab('market')"
      >技能市场</button>
      <button
        type="button"
        class="tab"
        :class="{ 'is-active': tab === 'mine' }"
        :aria-selected="tab === 'mine'"
        @click="switchTab('mine')"
      >我的技能</button>
    </div>

    <!-- 市场区 -->
    <div v-if="tab === 'market'" class="zone" role="tabpanel">
      <p v-if="marketLoading" class="hint">加载技能市场…</p>
      <p v-else-if="marketError || !catalog.length" class="hint" data-testid="market-empty">暂无可用技能</p>
      <div v-else class="cards">
        <article v-for="item in catalog" :key="item.packageHash" class="card" data-testid="market-card">
          <div class="card-head">
            <span class="card-name">{{ item.displayName }}</span>
            <span class="ver">v{{ item.version }}</span>
          </div>
          <p class="summary">{{ item.summary || item.description }}</p>
          <div class="meta">
            <span class="chip">{{ item.compatProfile }}</span>
            <span class="chip">兼容 {{ Math.round(item.compatScore * 100) }}%</span>
            <span v-if="item.vertical" class="chip">{{ item.vertical }}</span>
            <span class="publisher">{{ item.publisher }}</span>
          </div>
          <button type="button" class="install" data-testid="market-install" @click="onInstall(item)">安装</button>
        </article>
      </div>
    </div>

    <!-- 我的技能区 -->
    <div v-else class="zone" role="tabpanel">
      <p v-if="mineLoading" class="hint">加载我的技能…</p>
      <p v-else-if="!mine.length" class="hint">还没有已安装技能</p>
      <div v-else class="rows">
        <article v-for="item in mine" :key="item.id" class="row" data-testid="mine-skill-row">
          <div class="row-head">
            <span class="card-name">{{ item.displayName }}</span>
            <span v-if="item.enabled" class="badge-on" data-testid="enabled-badge">已启用</span>
            <span v-else class="badge-off">未启用</span>
          </div>
          <p class="summary">{{ item.skill }} · v{{ item.version }} · {{ item.sourceType }}</p>
          <div class="actions">
            <button type="button" class="act" data-testid="mine-toggle" @click="onToggle(item)">
              {{ item.enabled ? '停用' : '启用' }}
            </button>
            <button type="button" class="act" data-testid="mine-rollback" @click="onRollback(item)">回滚</button>
            <button type="button" class="act danger" data-testid="mine-uninstall" @click="askUninstall(item)">卸载</button>
          </div>
        </article>
      </div>
    </div>

    <!-- 单一确认弹窗：卸载二次确认 -->
    <div v-if="confirm" class="confirm-mask" data-testid="confirm-dialog" role="dialog" aria-modal="true">
      <div class="confirm-box">
        <p class="confirm-title">确认卸载？</p>
        <p class="confirm-desc">「{{ confirm.label }}」将从你的技能列表移除。</p>
        <div class="confirm-actions">
          <button type="button" class="act" data-testid="confirm-cancel" @click="cancelUninstall">取消</button>
          <button type="button" class="act danger" data-testid="confirm-ok" @click="confirmUninstall">确认卸载</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.skill-panel { display: flex; flex-direction: column; gap: var(--lnk-space-3); padding: var(--lnk-space-4); color: var(--lnk-text-primary); }
.tabs { display: flex; gap: var(--lnk-space-2); border-bottom: 1px solid var(--lnk-border-subtle); }
.tab { appearance: none; border: 0; background: transparent; color: var(--lnk-text-muted); padding: var(--lnk-space-2) var(--lnk-space-3); cursor: pointer; font: inherit; }
.tab.is-active { color: var(--lnk-accent); border-bottom: 2px solid var(--lnk-accent); }
.zone { min-height: 120px; }
.hint { color: var(--lnk-text-muted); font-size: var(--lnk-text-sm); padding: var(--lnk-space-3) 0; }
.cards, .rows { display: flex; flex-direction: column; gap: var(--lnk-space-3); }
.card, .row { border: 1px solid var(--lnk-border-subtle); border-radius: var(--lnk-radius-md); padding: var(--lnk-space-3); background: var(--lnk-surface-raised); }
.card-head, .row-head { display: flex; align-items: center; gap: var(--lnk-space-2); justify-content: space-between; }
.card-name { font-weight: 600; }
.ver, .publisher { color: var(--lnk-text-muted); font-size: var(--lnk-text-xs); }
.summary { color: var(--lnk-text-secondary); font-size: var(--lnk-text-sm); margin: var(--lnk-space-2) 0; }
.meta { display: flex; flex-wrap: wrap; gap: var(--lnk-space-2); align-items: center; }
.chip { font-size: var(--lnk-text-xs); color: var(--lnk-text-muted); border: 1px solid var(--lnk-border-subtle); border-radius: var(--lnk-radius-sm); padding: 0 var(--lnk-space-2); }
.badge-on { font-size: var(--lnk-text-xs); color: var(--lnk-accent); }
.badge-off { font-size: var(--lnk-text-xs); color: var(--lnk-text-muted); }
.install, .act { appearance: none; cursor: pointer; font: inherit; border: 1px solid var(--lnk-border-subtle); background: var(--lnk-surface-canvas); color: var(--lnk-text-primary); border-radius: var(--lnk-radius-sm); padding: var(--lnk-space-1) var(--lnk-space-3); margin-top: var(--lnk-space-2); }
.actions { display: flex; gap: var(--lnk-space-2); }
.act.danger { color: var(--lnk-error); }
.confirm-mask { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); display: flex; align-items: center; justify-content: center; z-index: var(--lnk-z-overlay); }
.confirm-box { background: var(--lnk-surface-raised); border-radius: var(--lnk-radius-md); padding: var(--lnk-space-5); max-width: 320px; width: 90%; }
.confirm-title { font-weight: 600; margin-bottom: var(--lnk-space-2); }
.confirm-desc { color: var(--lnk-text-secondary); font-size: var(--lnk-text-sm); }
.confirm-actions { display: flex; gap: var(--lnk-space-2); justify-content: flex-end; margin-top: var(--lnk-space-4); }
</style>
