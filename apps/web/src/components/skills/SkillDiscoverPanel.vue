<script setup lang="ts">
/**
 * M1-3 技能发现面板（发现页双区：市场区 + 我的技能区）。
 *
 * - 市场区：拉 /skills/catalog，卡片展示兼容评分/版本/发布者，点「安装」→ install(packageHash)。
 * - 我的技能区（P3 重构）：网格卡片 + 胶囊开关（setEnabled）+ 分组（sourceType：
 *   用户自定义 paste/zip/url/github vs 来自市场 market）+ 搜索过滤 + 批量管理
 *   （uninstallBatch + 单一确认弹窗）；导入入口 → SkillImportDialog（paste）。
 * - 确认弹窗：cancel 不触发 DELETE，只有 ok 才 remove/uninstallBatch（M1-3 RED 判据 + P3 C8）。
 *
 * 视图只呈现控制面事实：安装默认 enabled=false、信任级别、兼容评分；不假装「生态兼容完成」。
 * 样式只用 design tokens（--lnk-*），不动 z-index 语义阶梯（design-token.test.ts 守卫）。
 */
import { computed, onMounted, ref } from 'vue'
import BrandPatternAvatar from '@/components/account/BrandPatternAvatar.vue'
import SkillImportDialog from './SkillImportDialog.vue'
import SkillDetailSheet from './SkillDetailSheet.vue'
import { displayNameFromDesc } from '@/constants/agentSkillMap'
import {
  skillApi,
  type CatalogItem,
  type MineItem,
} from '@/services/skill-api'

/** F2（2026-11-17 P3 真机修复）：内置技能由宿主 dockSkills 经 prop 只读传入，
 *  不在面板内二次拉取 /skills/runtime（单一事实源）；内置 ≠ 用户已安装，两个真边界不混列。 */
interface BuiltinSkillDef { id: string; label: string; desc?: string }

const props = withDefaults(
  defineProps<{ initialTab?: 'market' | 'mine'; builtinSkills?: BuiltinSkillDef[] }>(),
  { initialTab: 'market', builtinSkills: () => [] },
)

/** 操作成功后通知宿主（AgentSideRail 据此刷新 dockSkills/胶囊候选）。 */
const emit = defineEmits<{ 'skills-changed': [] }>()

const tab = ref<'market' | 'mine'>(props.initialTab)
const catalog = ref<CatalogItem[]>([])
const mine = ref<MineItem[]>([])
const marketLoading = ref(true)
const mineLoading = ref(true)
const marketError = ref(false)

// 单一确认弹窗状态（卸载/删除共用一处；P3 扩展为批量 ids）
const confirm = ref<{ ids: string[]; label: string } | null>(null)

// ── P3：管理视图状态（搜索 / 分组 / 批量 / 导入） ──
const mineSearch = ref('')
const importOpen = ref(false)
const batchMode = ref(false)
const batchSelected = ref<string[]>([])

/** UI 美化 §4.5：只读详情壳状态——只消费已加载数据，零 fetch / 零新字段。 */
interface DetailState {
  name: string
  desc: string
  kind: 'builtin' | 'custom' | 'market'
  source?: string
  version?: string
  trustLevel?: string
  enabled?: boolean
}
const detail = ref<DetailState | null>(null)
/* 二轮 R5（2026-11-18）：内置卡/详情名统一走 displayNameFromDesc（label 含 CJK 直接用，
   slug 从 desc 首句派生），消灭裸英文 slug——与 + / / 列表同一派名函数，零第二份规则。 */
function builtinDisplayName(item: BuiltinSkillDef): string {
  return displayNameFromDesc(item.label, item.desc)
}
function openBuiltinDetail(item: BuiltinSkillDef) {
  detail.value = { name: builtinDisplayName(item), desc: item.desc ?? '', kind: 'builtin' }
}
function openMineDetail(item: MineItem, kind: 'custom' | 'market') {
  detail.value = {
    name: item.displayName,
    desc: kind === 'custom'
      ? `${item.skill} · v${item.version} · ${item.sourceType}`
      : `${item.skill} · v${item.version}`,
    kind,
    source: kind === 'custom' ? item.sourceType : 'market',
    version: item.version,
    trustLevel: item.trustLevel,
    enabled: item.enabled,
  }
}

const CUSTOM_SOURCES = new Set(['paste', 'zip', 'url', 'github'])

/** 用户自定义组：sourceType ∈ {paste,zip,url,github}（导入/自装）；来自市场：market。 */
const customSkills = computed(() =>
  mine.value.filter((s) => CUSTOM_SOURCES.has(s.sourceType)),
)
const marketSkills = computed(() =>
  mine.value.filter((s) => !CUSTOM_SOURCES.has(s.sourceType)),
)

function matchSearch(s: MineItem): boolean {
  const q = mineSearch.value.trim().toLowerCase()
  if (!q) return true
  return s.displayName.toLowerCase().includes(q) || s.skill.toLowerCase().includes(q)
}

const filteredCustom = computed(() => customSkills.value.filter(matchSearch))
const filteredMarket = computed(() => marketSkills.value.filter(matchSearch))

// F2：内置技能只读分区——数据来自 prop（宿主 dockSkills），搜索同样过滤；无任何开关/卸载出口。
function matchBuiltinSearch(s: BuiltinSkillDef): boolean {
  const q = mineSearch.value.trim().toLowerCase()
  if (!q) return true
  return s.label.toLowerCase().includes(q) || (s.desc ?? '').toLowerCase().includes(q)
}
const filteredBuiltin = computed(() => props.builtinSkills.filter(matchBuiltinSearch))

function toggleBatchSelect(id: string) {
  const idx = batchSelected.value.indexOf(id)
  if (idx >= 0) batchSelected.value.splice(idx, 1)
  else batchSelected.value.push(id)
}

function exitBatchMode() {
  batchMode.value = false
  batchSelected.value = []
}

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
    emit('skills-changed')
  } catch {
    // 视图不吞错：保留卡片，用户可重试（错误详情由网络层日志承担）
  }
}

async function onToggle(item: MineItem) {
  const next = !item.enabled
  try {
    await skillApi.setEnabled(item.id, next)
    item.enabled = next
    emit('skills-changed')
  } catch {
    // 状态未变，保留原值
  }
}

function askUninstall(item: MineItem) {
  confirm.value = { ids: [item.id], label: item.displayName }
}

function askBatchUninstall() {
  if (!batchSelected.value.length) return
  confirm.value = {
    ids: [...batchSelected.value],
    label: `已选 ${batchSelected.value.length} 个技能`,
  }
}

function cancelUninstall() {
  confirm.value = null
}

async function confirmUninstall() {
  const target = confirm.value
  if (!target) return
  confirm.value = null
  try {
    if (target.ids.length > 1) {
      // P3 C8：批量卸载复用 uninstallBatch（服务端现成，confirmed=true 强制口径与单删一致）
      await skillApi.uninstallBatch(target.ids, true)
      exitBatchMode()
    } else {
      await skillApi.remove(target.ids[0])
    }
    await loadMine()
    emit('skills-changed')
  } catch {
    // 卸载失败：下次刷新即可见真实状态
  }
}

async function onRollback(item: MineItem) {
  try {
    await skillApi.rollback(item.id)
    await loadMine()
    emit('skills-changed')
  } catch {
    // 无上一版本等失败：保留原状
  }
}

async function onImported(skillName: string) {
  await loadMine()
  emit('skills-changed')
  void skillName
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
      <!-- 二轮 R4（2026-11-18）：空市场补内置区引导——市场空目录不再死胡同（有内置技能时）。 -->
      <p v-else-if="marketError || !catalog.length" class="hint" data-testid="market-empty">
        暂无可用技能<span v-if="props.builtinSkills.length"> · 内置技能见「我的技能」页（{{ props.builtinSkills.length }} 个平台技能可直接查看）</span>
      </p>
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

    <!-- 我的技能区（P3：网格卡片 + 开关 + 分组 + 搜索 + 批量管理） -->
    <div v-else class="zone" role="tabpanel">
      <div class="mine-toolbar" data-testid="mine-toolbar">
        <div class="mine-toolbar-row">
          <span class="mine-count">已安装技能（{{ mine.length }}）</span>
          <input
            v-model="mineSearch"
            class="mine-search"
            data-testid="mine-search"
            type="search"
            placeholder="搜索已安装的技能"
            aria-label="搜索已安装的技能"
          />
          <button type="button" class="mine-act" data-testid="open-import" @click="importOpen = true">导入技能</button>
          <button
            type="button"
            class="mine-act"
            data-testid="toggle-batch"
            @click="batchMode ? exitBatchMode() : (batchMode = true, batchSelected = [])"
          >
            {{ batchMode ? '退出批量' : '批量管理' }}
          </button>
        </div>
      </div>

      <!-- F2：只读内置技能分区（平台提供、常开不可停用；数据来自宿主 dockSkills prop，面板零 fetch） -->
      <section v-if="props.builtinSkills.length" class="group" data-testid="builtin-section">
        <h3 class="group-title">内置技能（{{ props.builtinSkills.length }}）· 平台提供 · 常开</h3>
        <div class="cards-grid">
          <article
            v-for="item in filteredBuiltin"
            :key="item.id"
            class="manage-card builtin-card"
            data-testid="builtin-skill-row"
            :class="{ 'is-clickable': !batchMode }"
            @click="!batchMode && openBuiltinDetail(item)"
          >
            <div class="manage-head">
              <BrandPatternAvatar :seed="item.id" :name="item.label" size="sm" />
              <span class="card-name manage-name" :title="builtinDisplayName(item)">{{ builtinDisplayName(item) }}</span>
              <button
                type="button"
                class="detail-open"
                data-testid="skill-detail-open"
                :aria-label="`查看 ${builtinDisplayName(item)} 详情`"
                @click.stop="openBuiltinDetail(item)"
              >ⓘ</button>
            </div>
            <!-- 二轮 R7（2026-11-18）：「内置」badge 从 head 行移到 summary 行尾——
                 390px 下 head 4 元素挤行会把卡名压到 ~180px；badge 独立行不挤占名字宽度。 -->
            <div class="summary-row">
              <p v-if="item.desc" class="summary manage-summary" :title="item.desc">{{ item.desc }}</p>
              <span class="builtin-badge">内置</span>
            </div>
          </article>
        </div>
      </section>

      <!-- 批量操作栏 -->
      <div v-if="batchMode" class="batch-bar" data-testid="batch-bar">
        <span class="batch-count">已选 {{ batchSelected.length }} 个</span>
        <button
          type="button"
          class="mine-act mine-act-danger"
          data-testid="batch-uninstall"
          :disabled="!batchSelected.length"
          @click="askBatchUninstall"
        >批量卸载</button>
      </div>

      <p v-if="mineLoading" class="hint">加载我的技能…</p>
      <p v-else-if="!mine.length" class="hint">内置技能由平台提供，导入或安装后可在此管理</p>
      <template v-else>
        <section v-if="filteredCustom.length" class="group" data-testid="group-custom">
          <h3 class="group-title">用户自定义（{{ customSkills.length }}）</h3>
          <div class="cards-grid">
            <article
              v-for="item in filteredCustom"
              :key="item.id"
              class="manage-card"
              data-testid="mine-skill-row"
              :class="{ 'is-off': !item.enabled, 'is-batch-picked': batchMode && batchSelected.includes(item.id), 'is-clickable': !batchMode }"
              @click="batchMode ? toggleBatchSelect(item.id) : openMineDetail(item, 'custom')"
            >
              <div class="manage-head">
                <BrandPatternAvatar :seed="item.skill" :name="item.displayName" size="sm" />
                <span class="card-name manage-name" :title="item.displayName">{{ item.displayName }}</span>
                <button
                  type="button"
                  class="detail-open"
                  data-testid="skill-detail-open"
                  :aria-label="`查看 ${item.displayName} 详情`"
                  @click.stop="openMineDetail(item, 'custom')"
                >ⓘ</button>
                <button
                  type="button"
                  class="mine-switch"
                  role="switch"
                  :aria-checked="item.enabled"
                  :aria-label="item.enabled ? `停用 ${item.displayName}（停用后不再自动生效，也不出现在 + / / 列表）` : `启用 ${item.displayName}`"
                  data-testid="mine-toggle"
                  @click.stop="onToggle(item)"
                >
                  <span class="mine-knob" />
                </button>
              </div>
              <!-- 二轮 R7（2026-11-18）：状态行 + 元数据行两行结构（桌面端仍单行连排）——
                   原四段元数据单行省略会把版本/来源吞掉；移动端分两行各自省略，信息保得住。 -->
              <p class="summary manage-summary" :title="`${item.enabled ? '已启用 · 自动可用' : '已停用'} · ${item.skill} · v${item.version} · ${item.sourceType}`">
                <span class="sum-status">{{ item.enabled ? '已启用 · 自动可用' : '已停用' }}</span>
                <span class="sum-meta">{{ item.skill }} · v{{ item.version }} · {{ item.sourceType }}</span>
              </p>
              <div v-if="!batchMode" class="actions manage-actions">
                <button type="button" class="act" data-testid="mine-rollback" @click.stop="onRollback(item)">回滚</button>
                <button type="button" class="act danger" data-testid="mine-uninstall" @click.stop="askUninstall(item)">卸载</button>
              </div>
            </article>
          </div>
        </section>
        <section v-if="filteredMarket.length" class="group" data-testid="group-market">
          <h3 class="group-title">来自市场（{{ marketSkills.length }}）</h3>
          <div class="cards-grid">
            <article
              v-for="item in filteredMarket"
              :key="item.id"
              class="manage-card"
              data-testid="mine-skill-row"
              :class="{ 'is-off': !item.enabled, 'is-batch-picked': batchMode && batchSelected.includes(item.id), 'is-clickable': !batchMode }"
              @click="batchMode ? toggleBatchSelect(item.id) : openMineDetail(item, 'market')"
            >
              <div class="manage-head">
                <BrandPatternAvatar :seed="item.skill" :name="item.displayName" size="sm" />
                <span class="card-name manage-name" :title="item.displayName">{{ item.displayName }}</span>
                <button
                  type="button"
                  class="detail-open"
                  data-testid="skill-detail-open"
                  :aria-label="`查看 ${item.displayName} 详情`"
                  @click.stop="openMineDetail(item, 'market')"
                >ⓘ</button>
                <button
                  type="button"
                  class="mine-switch"
                  role="switch"
                  :aria-checked="item.enabled"
                  :aria-label="item.enabled ? `停用 ${item.displayName}（停用后不再自动生效，也不出现在 + / / 列表）` : `启用 ${item.displayName}`"
                  data-testid="mine-toggle"
                  @click.stop="onToggle(item)"
                >
                  <span class="mine-knob" />
                </button>
              </div>
              <p class="summary manage-summary" :title="`${item.enabled ? '已启用 · 自动可用' : '已停用'} · ${item.skill} · v${item.version}`">
                <span class="sum-status">{{ item.enabled ? '已启用 · 自动可用' : '已停用' }}</span>
                <span class="sum-meta">{{ item.skill }} · v{{ item.version }}</span>
              </p>
              <div v-if="!batchMode" class="actions manage-actions">
                <button type="button" class="act" data-testid="mine-rollback" @click.stop="onRollback(item)">回滚</button>
                <button type="button" class="act danger" data-testid="mine-uninstall" @click.stop="askUninstall(item)">卸载</button>
              </div>
            </article>
          </div>
        </section>
        <p v-if="!filteredCustom.length && !filteredMarket.length" class="hint" data-testid="mine-filter-empty">没有匹配的技能</p>
      </template>
    </div>

    <!-- 单一确认弹窗：卸载二次确认（P3 支持批量 ids） -->
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

    <!-- UI 美化 §4.5：只读详情壳（复用 MobileSheet，零 fetch） -->
    <SkillDetailSheet
      v-if="detail"
      v-bind="detail"
      @close="detail = null"
    />

    <!-- P3：导入弹窗（paste） -->
    <SkillImportDialog
      v-if="importOpen"
      @close="importOpen = false"
      @imported="onImported"
    />
  </section>
</template>

<style scoped>
.skill-panel { display: flex; flex-direction: column; gap: var(--lnk-space-3); padding: var(--lnk-space-4); color: var(--lnk-text-primary); }
.tabs { display: flex; gap: var(--lnk-space-2); border-bottom: 1px solid var(--lnk-border-subtle); }
.tab { appearance: none; border: 0; background: transparent; color: var(--lnk-text-muted); padding: var(--lnk-space-2) var(--lnk-space-3); cursor: pointer; font: inherit; }
.tab.is-active { color: var(--lnk-accent); border-bottom: 2px solid var(--lnk-accent); }
.zone { min-height: 120px; }
.hint { color: var(--lnk-text-muted); font-size: var(--lnk-text-sm); padding: var(--lnk-space-3) 0; }
.cards { display: flex; flex-direction: column; gap: var(--lnk-space-3); }
.card { border: 1px solid var(--lnk-border-subtle); border-radius: var(--lnk-radius-md); padding: var(--lnk-space-3); background: var(--lnk-surface-raised); }
.card-head { display: flex; align-items: center; gap: var(--lnk-space-2); justify-content: space-between; }
.card-name { font-weight: 600; }
.ver, .publisher { color: var(--lnk-text-muted); font-size: var(--lnk-text-xs); }
.summary { color: var(--lnk-text-secondary); font-size: var(--lnk-text-sm); margin: var(--lnk-space-2) 0; }
.meta { display: flex; flex-wrap: wrap; gap: var(--lnk-space-2); align-items: center; }
.chip { font-size: var(--lnk-text-xs); color: var(--lnk-text-muted); border: 1px solid var(--lnk-border-subtle); border-radius: var(--lnk-radius-sm); padding: 0 var(--lnk-space-2); }
.install, .act { appearance: none; cursor: pointer; font: inherit; border: 1px solid var(--lnk-border-subtle); background: var(--lnk-surface-canvas); color: var(--lnk-text-primary); border-radius: var(--lnk-radius-sm); padding: var(--lnk-space-1) var(--lnk-space-3); margin-top: var(--lnk-space-2); }
.actions { display: flex; gap: var(--lnk-space-2); }
.act.danger { color: var(--lnk-error); }
.confirm-mask { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); display: flex; align-items: center; justify-content: center; z-index: var(--lnk-z-overlay); }
.confirm-box { background: var(--lnk-surface-raised); border-radius: var(--lnk-radius-md); padding: var(--lnk-space-5); max-width: 320px; width: 90%; }
.confirm-title { font-weight: 600; margin-bottom: var(--lnk-space-2); }
.confirm-desc { color: var(--lnk-text-secondary); font-size: var(--lnk-text-sm); }
.confirm-actions { display: flex; gap: var(--lnk-space-2); justify-content: flex-end; margin-top: var(--lnk-space-4); }

/* ── P3 管理视图（网格卡片 + 开关 + 分组 + 搜索 + 批量）── */
.mine-toolbar { display: flex; flex-direction: column; gap: var(--lnk-space-1); }
.mine-toolbar-row { display: flex; align-items: center; gap: var(--lnk-space-2); flex-wrap: nowrap; min-width: 0; }
.mine-count { font-size: var(--lnk-text-xs); font-weight: 600; color: var(--lnk-text-primary); white-space: nowrap; }
@media (max-width: 640px) { .mine-count { display: none; } }
.mine-search { flex: 1; min-width: 120px; border: 1px solid var(--lnk-border-subtle); border-radius: var(--lnk-radius-sm); background: var(--lnk-surface-canvas); color: var(--lnk-text-primary); font: inherit; font-size: var(--lnk-text-xs); padding: var(--lnk-space-1) var(--lnk-space-2); }
.mine-search:focus { outline: none; border-color: var(--lnk-accent); }
.mine-act { appearance: none; cursor: pointer; font: inherit; font-size: var(--lnk-text-xs); border: 1px solid var(--lnk-border-subtle); background: var(--lnk-surface-canvas); color: var(--lnk-text-primary); border-radius: var(--lnk-radius-sm); padding: var(--lnk-space-1) var(--lnk-space-2); }
.mine-act:disabled { opacity: 0.5; cursor: not-allowed; }
.mine-act-danger { color: var(--lnk-error); border-color: var(--lnk-error); }
.batch-bar { display: flex; align-items: center; gap: var(--lnk-space-2); }
.batch-count { font-size: var(--lnk-text-xs); color: var(--lnk-text-secondary); }
.group { margin-bottom: var(--lnk-space-3); }
/* 二轮 R8（2026-11-18）：分组头 sticky 吸顶——长列表滚动时始终知道当前分区；
   裁决=不嵌套二级 Tab（HIG 反嵌套导航，规格 §4.3）。z-index:1 防后续卡片背景盖住。 */
.group-title { font-size: var(--lnk-text-xs); font-weight: 600; color: var(--lnk-text-muted); margin: var(--lnk-space-2) 0; position: sticky; top: 0; z-index: 1; background: var(--lnk-surface-raised); }
.cards-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--lnk-space-3); }
/* 二轮 R1（2026-11-18）：移动端单列必须 minmax(0,1fr)——裸 1fr 的 min 走 min-content（整行文本宽），
   nowrap 长描述把卡撑到 2011px（实测爆宽 5.2 倍屏宽）；minmax(0,1fr) 钉死 min=0。 */
@media (max-width: 639px) { .cards-grid { grid-template-columns: minmax(0, 1fr); } }
.manage-card { border: 1px solid var(--lnk-border-subtle); border-radius: var(--lnk-radius-md); padding: var(--lnk-space-3); background: var(--lnk-surface-raised); display: flex; flex-direction: column; gap: var(--lnk-space-2); }
.manage-card.is-clickable { cursor: pointer; }
.manage-card.is-off { opacity: 0.72; }
.manage-card.is-batch-picked { border-color: var(--lnk-accent); }
.manage-head { display: flex; align-items: center; gap: var(--lnk-space-2); }
.manage-name { flex: 1; min-width: 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: var(--lnk-lh-md); }
.manage-summary { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
/* 二轮 R7：内置卡 badge 独立行（summary 行尾），不挤占 head 卡名宽度 */
.summary-row { display: flex; align-items: center; gap: var(--lnk-space-2); min-width: 0; }
.summary-row .manage-summary { flex: 1; min-width: 0; }
/* 二轮 R7：我的卡状态行/元数据行——桌面端连排单行（· 分隔），移动端两行各自省略 */
.sum-status, .sum-meta { min-width: 0; }
.sum-meta::before { content: ' · '; }
@media (max-width: 639px) {
  .sum-status, .sum-meta { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sum-meta::before { content: none; }
  /* 二轮 R7：移动端触控目标补足 HIG 44px（实测 .act ~30px / .tab ~36px 违规） */
  .act, .install, .tab { min-height: var(--lnk-touch-target); }
}
.manage-actions { margin-top: auto; }
.detail-open { appearance: none; border: 0; background: transparent; color: var(--lnk-text-muted); cursor: pointer; flex: none; min-width: var(--lnk-touch-target); min-height: var(--lnk-touch-target); display: inline-flex; align-items: center; justify-content: center; font-size: var(--lnk-text-sm); }
.mine-switch { position: relative; appearance: none; border: 0; cursor: pointer; flex-shrink: 0; width: 51px; height: 31px; border-radius: var(--lnk-radius-full); background: var(--lnk-border-strong); transition: background var(--lnk-duration-fast) ease; padding: 0; }
.mine-switch::after { content: ''; position: absolute; inset: -7px; }
.mine-switch[aria-checked="true"] { background: var(--lnk-accent); }
.mine-knob { position: absolute; top: 2px; left: 2px; width: 27px; height: 27px; border-radius: var(--lnk-radius-full); background: var(--lnk-surface-raised); box-shadow: var(--lnk-shadow-xs); transition: left var(--lnk-duration-fast) ease; }
.mine-switch[aria-checked="true"] .mine-knob { left: 22px; }

/* F2：只读内置技能卡——无 mine-toggle / 卸载出口，与用户已安装技能边界清晰。 */
.builtin-card { background: var(--lnk-surface-canvas); }
.builtin-badge { font-size: var(--lnk-text-xs); color: var(--lnk-accent); border: 1px solid var(--lnk-accent); border-radius: var(--lnk-radius-sm); padding: 0 var(--lnk-space-2); flex-shrink: 0; }
</style>
