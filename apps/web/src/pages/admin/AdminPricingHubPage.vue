<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { adminApi, AdminApiError, type CostRecordRow, type CostRecordTier, type MaterializeResult } from '@/services/admin-api'

/**
 * 定价中心（spec: docs/design/2026-11-15-pricing-console-redesign.md）：
 * 一面「上架模型的填数墙」——卡片数量恒等于在售模型数；成本记录的增删只在模型上下架，
 * 本页只改数值（R3）：档位成本 + 每模型自持利润率（R4，无全局继承）。
 * 价目表为只读产物（R5），入口链到 versions 页；生成价目 = rebuild → 物化草案 → 门禁预览。
 */

const loading = ref(false)
const actionError = ref('')
const records = ref<CostRecordRow[]>([])
const selectedKey = ref('')

// 编辑态：档位数值（字符串输入框）+ 自持利润率
const tierValues = ref<Record<string, string>>({})
const profitPctValue = ref<number | null>(null)
const saving = ref(false)
const selectedTier = ref('')

// 生成价目
const refreshing = ref(false)
const lastMaterialize = ref<MaterializeResult | null>(null)
const lastReadinessOk = ref<boolean | null>(null)

const MODALITY_LABEL: Record<string, string> = { image: '图像', video: '视频', audio: '音频', text: '文本' }

const grouped = computed(() => {
  const map = new Map<string, CostRecordRow[]>()
  for (const r of records.value) {
    const list = map.get(r.modality) ?? []
    list.push(r)
    map.set(r.modality, list)
  }
  return [...map.entries()]
})

const selected = computed(() => records.value.find((r) => r.modelKey === selectedKey.value) ?? null)

const readyCount = computed(() => records.value.filter((r) => r.status === 'ready').length)
const missingCount = computed(() => records.value.filter((r) => r.status !== 'ready').length)

const missingList = computed(() => {
  if (!lastMaterialize.value) return []
  return lastMaterialize.value.missingCost.map((key) => {
    const [capability, modelKey, spec] = key.split('|')
    return `${modelKey} · ${capability === 'text' ? 'token' : spec}`
  })
})

const selectedTierObj = computed<CostRecordTier | null>(() => selected.value?.tiers.find((t) => t.spec === selectedTier.value) ?? null)

function errMsg(err: unknown, fallback: string): string {
  return err instanceof AdminApiError ? err.message : fallback
}

function statusColor(status: string): string {
  return status === 'ready' ? 'var(--color-success-600)' : status === 'partial' ? 'var(--color-warning-600)' : 'var(--color-danger-600)'
}

function statusLabel(status: string): string {
  return status === 'ready' ? '已就绪' : status === 'partial' ? '部分缺成本' : '待填成本'
}

function selectRecord(r: CostRecordRow): void {
  selectedKey.value = r.modelKey
  selectedTier.value = r.tiers[0]?.spec ?? ''
  const vals: Record<string, string> = {}
  for (const t of r.tiers) {
    // 预填：自有 per_second 值优先，其次 legacy per_video 折算参考值（不落存储，仅引导填数）
    const v = t.costYuan ?? t.perVideoDerived
    vals[t.spec] = v === null ? '' : String(Math.round(v * 1e6) / 1e6)
  }
  tierValues.value = vals
  profitPctValue.value = r.profitPct ?? 10
}

async function reload(keepSelection = true): Promise<void> {
  loading.value = true
  actionError.value = ''
  try {
    records.value = await adminApi.pricingS1.listCostRecords()
    const keep = keepSelection ? records.value.find((r) => r.modelKey === selectedKey.value) : null
    if (keep) selectRecord(keep)
    else {
      const first = records.value.find((r) => r.status !== 'ready') ?? records.value[0]
      if (first) selectRecord(first)
    }
  } catch (err) {
    actionError.value = errMsg(err, '加载定价记录失败')
  } finally {
    loading.value = false
  }
}

async function saveRecord(): Promise<void> {
  const rec = selected.value
  if (!rec) return
  const tiers: { spec: string; costYuan: number }[] = []
  for (const t of rec.tiers) {
    const raw = (tierValues.value[t.spec] ?? '').trim()
    if (raw === '') continue
    const v = Number(raw)
    if (!Number.isFinite(v) || v < 0) {
      actionError.value = `档位「${t.label}」金额非法：${raw}`
      return
    }
    tiers.push({ spec: t.spec, costYuan: v })
  }
  if (tiers.length === 0) {
    actionError.value = '请至少填写一个档位成本'
    return
  }
  saving.value = true
  actionError.value = ''
  try {
    const body: { tiers: { spec: string; costYuan: number }[]; profitPct?: number } = { tiers }
    if (profitPctValue.value !== null && profitPctValue.value >= 0 && profitPctValue.value <= 100) {
      body.profitPct = profitPctValue.value
    }
    await adminApi.pricingS1.updateCostRecord(rec.modelKey, body)
    ElMessage.success(`已保存 ${rec.displayName}：${tiers.length} 个档位 + 利润率`)
    await reload(true)
  } catch (err) {
    actionError.value = errMsg(err, '保存失败')
  } finally {
    saving.value = false
  }
}

async function refreshPricing(): Promise<void> {
  refreshing.value = true
  actionError.value = ''
  lastReadinessOk.value = null
  try {
    await adminApi.pricingS1.rebuildSubjects()
    const versions = await adminApi.pricingVersions.list()
    const existing = versions.find((v) => v.status === 'draft')
    let draftId: string
    if (existing) {
      draftId = existing.id
    } else {
      let created
      try {
        created = await adminApi.pricingVersions.createDraft('v-hub', '定价中心生成价目')
      } catch {
        created = await adminApi.pricingVersions.createDraft(`v-hub-${Date.now()}`, '定价中心生成价目')
      }
      draftId = created.id
    }
    const mat = await adminApi.pricingS1.materializeDraft(draftId)
    lastMaterialize.value = mat
    try {
      const r = await adminApi.pricingS1.getReadiness(draftId)
      lastReadinessOk.value = r.ok
      if (!r.ok) actionError.value = `发布门禁未通过：${r.violations.join('；')}`
    } catch {
      /* 就绪检查非阻断 */
    }
    await reload(true)
    ElMessage.success(`物化完成：已出价 ${mat.added + mat.changed + mat.unchanged} / 缺成本 ${mat.missingCost.length}`)
  } catch (err) {
    actionError.value = errMsg(err, '生成价目失败')
  } finally {
    refreshing.value = false
  }
}

onMounted(() => reload(false))

defineExpose({ reload, saveRecord, refreshPricing, records, selectedKey, tierValues, profitPctValue, lastMaterialize, actionError })
</script>

<template>
  <section class="p-3">
    <header class="mb-4 flex flex-wrap items-center gap-3">
      <h1 class="text-lg font-semibold text-fg">定价中心</h1>
      <span class="text-sm text-fg-3">卡片数量 = 在售模型数；增删记录在「模型管理」上下架，这里只改数值</span>
      <el-button :loading="loading" @click="reload()">刷新</el-button>
      <el-button type="primary" :loading="refreshing" @click="refreshPricing">生成价目表</el-button>
      <router-link to="/admin/pricing-versions" class="text-sm text-accent">价目表（只读）→</router-link>
    </header>

    <p v-if="actionError" class="mb-3 rounded border border-danger-border bg-danger-bg p-2 text-sm text-danger">{{ actionError }}</p>

    <div class="flex flex-wrap items-center gap-3">
      <div class="rounded border border-line-subtle bg-surface-base p-3">
        <div class="text-xs text-fg-3">在售模型</div>
        <div class="text-2xl font-semibold text-fg">{{ records.length }}</div>
      </div>
      <div class="rounded border border-line-subtle bg-surface-base p-3">
        <div class="text-xs text-fg-3">已就绪</div>
        <div class="text-2xl font-semibold text-success">{{ readyCount }}</div>
      </div>
      <div class="rounded border border-line-subtle bg-surface-base p-3">
        <div class="text-xs text-fg-3">待填 / 缺成本</div>
        <div class="text-2xl font-semibold" :class="missingCount > 0 ? 'text-danger' : 'text-fg'">{{ missingCount }}</div>
      </div>
    </div>

    <div class="mt-4 flex items-start gap-3">
      <!-- 左栏：在售模型按模态分组 + 状态点 -->
      <aside class="w-56 flex-none rounded border border-line-subtle bg-surface-base p-2">
        <div v-for="[modality, list] in grouped" :key="modality" class="mb-2">
          <div class="px-2 py-1 text-xs text-fg-3">{{ MODALITY_LABEL[modality] ?? modality }} · {{ list.length }}</div>
          <button
            v-for="r in list"
            :key="r.modelKey"
            class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm"
            :class="r.modelKey === selectedKey ? 'bg-surface-sunken text-fg' : 'text-fg-2 hover:bg-surface-sunken'"
            @click="selectRecord(r)"
          >
            <span class="h-2 w-2 flex-none rounded-full" :style="{ background: statusColor(r.status) }"></span>
            <span class="truncate">{{ r.displayName || r.modelKey }}</span>
          </button>
        </div>
      </aside>

      <!-- 主区：选中模型的成本卡片（修改模式） -->
      <div v-if="selected" class="min-w-0 flex-1 rounded border border-line-subtle bg-surface-base p-4">
        <div class="mb-1 flex flex-wrap items-center gap-2">
          <h2 class="text-base font-semibold text-fg">{{ selected.displayName || selected.modelKey }}</h2>
          <el-tag size="small" type="info">{{ selected.channel }}</el-tag>
          <span class="h-2.5 w-2.5 rounded-full" :style="{ background: statusColor(selected.status) }"></span>
          <span class="text-sm" :class="selected.status === 'ready' ? 'text-success' : 'text-danger'">{{ statusLabel(selected.status) }}</span>
          <span class="text-xs text-fg-3">{{ MODALITY_LABEL[selected.modality] ?? selected.modality }} · 一条成本记录</span>
        </div>

        <div class="mt-3 text-xs text-fg-3">成本档位（视频按「元/秒」填一次，时长 4s/5s/10s/15s 自动展开）</div>
        <div class="mt-2 flex flex-wrap gap-2">
          <button
            v-for="t in selected.tiers"
            :key="t.spec"
            class="rounded-lg border px-3 py-1.5 text-sm"
            :class="t.spec === selectedTier ? 'border-accent bg-accent-subtle text-accent' : 'border-line-subtle bg-surface-base text-fg-2'"
            @click="selectedTier = t.spec"
          >
            {{ t.spec }}
            <span v-if="t.costYuan === null" class="ml-1 text-xs text-danger">待填</span>
          </button>
        </div>

        <div v-if="selectedTierObj" class="mt-3 flex flex-wrap items-center gap-3">
          <label class="flex flex-col gap-1 text-xs text-fg-2">
            {{ selectedTierObj.label }}
            <el-input v-model="tierValues[selectedTierObj.spec]" class="w-40" placeholder="填金额" />
          </label>
          <span v-if="selectedTierObj.costYuan === null && selectedTierObj.perVideoDerived !== null" class="text-xs text-fg-3">
            参考值 {{ selectedTierObj.perVideoDerived }} 元（由既有整条视频成本折算，保存后按「元/秒」生效）
          </span>
        </div>

        <div class="mt-4 flex flex-wrap items-center gap-3">
          <label class="flex items-center gap-2 text-sm text-fg-2">
            本模型利润率（自持）
            <el-input-number v-model="profitPctValue" :min="0" :max="100" :step="1" />
            %
          </label>
          <el-button type="primary" size="small" :loading="saving" @click="saveRecord">保存本卡</el-button>
        </div>

        <div v-if="selected.missingSpecs.length > 0" class="mt-4 rounded border border-warning-border bg-warning-bg p-2 text-xs text-warning">
          待出价 {{ selected.missingSpecs.length }} / {{ selected.subjectsTotal }} 条规格（例：{{ selected.missingSpecs.slice(0, 6).join('、') }}{{ selected.missingSpecs.length > 6 ? ' …' : '' }}）。上面档位填完点「生成价目表」即全部出价。
        </div>
        <div v-else class="mt-4 rounded border border-line-subtle bg-surface-base p-2 text-xs text-success">
          本模型 {{ selected.subjectsTotal }} 条规格全部可出价；点顶部「生成价目表」落草案。
        </div>
      </div>
      <div v-else class="min-w-0 flex-1 rounded border border-line-subtle bg-surface-base p-6 text-sm text-fg-3">
        左侧选择一个在售模型开始填数。新模型请在「模型管理」上架（上架流程内含定价填写）。
      </div>
    </div>

    <!-- 全局缺成本清单（生成价目后） -->
    <div v-if="missingList.length > 0" class="mt-4 rounded border border-warning-border bg-warning-bg p-3">
      <h3 class="mb-1 text-sm font-semibold text-warning">价目表还差 {{ missingList.length }} 项缺成本（回到对应卡片填数即可）</h3>
      <div class="flex flex-wrap gap-1 text-xs">
        <el-tag v-for="m in missingList" :key="m" size="small" type="warning">{{ m }}</el-tag>
      </div>
    </div>

    <div v-if="lastMaterialize" class="mt-3 rounded border border-line-subtle bg-surface-base p-3 text-sm">
      <h3 class="mb-1 font-semibold text-fg">本次物化摘要</h3>
      <p class="text-fg-2">新增 {{ lastMaterialize.added }} / 变更 {{ lastMaterialize.changed }} / 不变 {{ lastMaterialize.unchanged }}</p>
      <p v-if="lastReadinessOk === true" class="text-success">发布门禁：通过，可到「价目表（只读）」页发布</p>
      <p v-else-if="lastReadinessOk === false" class="text-danger">发布门禁：未通过（见顶部提示）</p>
    </div>
  </section>
</template>
