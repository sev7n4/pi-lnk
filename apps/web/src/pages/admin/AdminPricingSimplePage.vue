<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { adminApi, AdminApiError, type PricingSubjectRow, type MaterializeResult, type MarginPolicyRow } from '@/services/admin-api'

/**
 * 极简定价台（小白模式）：把 S1 三页的黑话收敛为「利润率% + 一键导入成本 + 一键更新价目」。
 * - 利润率：人话「平台加价 %」（默认 10%），底层仍是 MarginPolicy.profitBp（×100）。
 * - 一键导入成本：粘贴「模型, 档位, 每单位成本(元)」多行，服务端按主体自动推断计量单位。
 * - 一键更新价目：重建主体 → 物化草案 → 出价摘要（已出价 / 缺成本 + 清单）。
 * - 缺成本清单用中文呈现（模型 + 档位），直接告诉运营还差哪些成本没填。
 */

const loading = ref(false)
const actionError = ref('')

// 状态卡
const subjects = ref<PricingSubjectRow[]>([])
const marginRows = ref<MarginPolicyRow[]>([])
const importedCostCount = ref(0)

// 利润率（人话 %）
const profitPct = ref(10)
const savingMargin = ref(false)

// 一键更新价目
const refreshing = ref(false)
const lastMaterialize = ref<MaterializeResult | null>(null)
const lastReadinessOk = ref<boolean | null>(null)

// 导入成本对话框
const importVisible = ref(false)
const importText = ref('')
const importing = ref(false)
const importResultText = ref('')

const subjectByKey = computed(() => new Map(subjects.value.map((s) => [s.subjectKey, s])))
const totalSubjects = computed(() => subjects.value.length)
const pricedCount = computed(() =>
  lastMaterialize.value ? lastMaterialize.value.added + lastMaterialize.value.changed + lastMaterialize.value.unchanged : null,
)
const missingCount = computed(() => (lastMaterialize.value ? lastMaterialize.value.missingCost.length : null))

/** 缺成本清单（人话）：subjectKey → 模型 + 档位。 */
const missingList = computed(() => {
  if (!lastMaterialize.value) return []
  return lastMaterialize.value.missingCost.map((key) => {
    const s = subjectByKey.value.get(key)
    return s ? `${s.modelKey} · ${s.spec}` : key
  })
})

const globalMargin = computed(() => marginRows.value.find((m) => m.scope === 'global' && m.status === 'active'))

function errMsg(err: unknown, fallback: string): string {
  return err instanceof AdminApiError ? err.message : fallback
}

async function reload() {
  loading.value = true
  actionError.value = ''
  try {
    const [subs, margins, costs] = await Promise.all([
      adminApi.pricingS1.listSubjects(),
      adminApi.pricingS1.listMarginPolicies(),
      adminApi.pricingS1.listCostRates(),
    ])
    subjects.value = subs
    marginRows.value = margins
    importedCostCount.value = costs.length
    if (globalMargin.value) profitPct.value = Math.round(globalMargin.value.profitBp / 100)
  } catch (err) {
    actionError.value = errMsg(err, '加载失败')
  } finally {
    loading.value = false
  }
}

async function saveMargin() {
  if (profitPct.value < 0 || profitPct.value > 500) {
    actionError.value = '利润率需在 0%–500% 之间'
    return
  }
  savingMargin.value = true
  actionError.value = ''
  try {
    await adminApi.pricingS1.putMarginPolicy({
      scope: 'global',
      profitBp: Math.round(profitPct.value * 100),
      priceFloorBp: 500,
      status: 'active',
    })
    ElMessage.success(`已保存平台利润率 ${profitPct.value}%（底价地板 5%）`)
    await reload()
  } catch (err) {
    actionError.value = errMsg(err, '保存利润率失败')
  } finally {
    savingMargin.value = false
  }
}

async function refreshPricing() {
  refreshing.value = true
  actionError.value = ''
  lastReadinessOk.value = null
  try {
    await adminApi.pricingS1.rebuildSubjects()
    // 确保有一个 draft 草案可物化
    const versions = await adminApi.pricingVersions.list()
    const existing = versions.find((v) => v.status === 'draft')
    let draftId: string
    if (existing) {
      draftId = existing.id
    } else {
      let created
      try {
        created = await adminApi.pricingVersions.createDraft('v-simple', '极简台一键更新价目')
      } catch {
        created = await adminApi.pricingVersions.createDraft(`v-simple-${Date.now()}`, '极简台一键更新价目')
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
    await reload()
    ElMessage.success(`物化完成：已出价 ${mat.added + mat.changed + mat.unchanged} / 缺成本 ${mat.missingCost.length}`)
  } catch (err) {
    actionError.value = errMsg(err, '更新价目失败')
  } finally {
    refreshing.value = false
  }
}

function parseImportText(): { modelKey: string; spec: string; costYuan: number }[] {
  const out: { modelKey: string; spec: string; costYuan: number }[] = []
  const lines = importText.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  for (const line of lines) {
    const parts = line.split(/[,，\s]+/).filter(Boolean)
    if (parts.length < 3) throw new Error(`无法解析行：「${line}」——需 模型, 档位, 金额`)
    const cost = Number(parts[2])
    if (!Number.isFinite(cost) || cost < 0) throw new Error(`金额非法：「${parts[2]}」`)
    out.push({ modelKey: parts[0], spec: parts[1], costYuan: cost })
  }
  if (out.length === 0) throw new Error('请至少粘贴一行')
  return out
}

async function doImport() {
  actionError.value = ''
  let rows: { modelKey: string; spec: string; costYuan: number }[]
  try {
    rows = parseImportText()
  } catch (err) {
    actionError.value = err instanceof Error ? err.message : '解析失败'
    return
  }
  importing.value = true
  importResultText.value = ''
  try {
    const res = await adminApi.pricingS1.importCostRates(rows)
    importResultText.value = res.results
      .map((r) => `${r.ok ? '✓' : '✗'} ${r.modelKey}/${r.spec}${r.ok ? '' : `：${r.message}`}`)
      .join('\n')
    if (res.failed > 0) {
      actionError.value = `${res.imported} 条成功，${res.failed} 条失败（见下方明细）`
    } else {
      ElMessage.success(`已导入 ${res.imported} 条成本`)
      importVisible.value = false
      importText.value = ''
      await reload()
    }
  } catch (err) {
    actionError.value = errMsg(err, '导入失败')
  } finally {
    importing.value = false
  }
}

onMounted(reload)

defineExpose({ reload, saveMargin, refreshPricing, doImport, profitPct, subjects, lastMaterialize, actionError })
</script>

<template>
  <section class="p-3">
    <header class="mb-4 flex items-center gap-3">
      <h1 class="text-lg font-semibold text-fg">极简定价台</h1>
      <span class="text-sm text-fg-3">小白也能上手：设利润率 → 导入成本 → 一键出价</span>
      <el-button :loading="loading" @click="reload">刷新</el-button>
      <router-link to="/admin/pricing-subjects" class="text-sm text-primary">高级模式 →</router-link>
    </header>

    <p v-if="actionError" class="mb-3 rounded border border-danger-border bg-danger-bg p-2 text-sm text-danger">{{ actionError }}</p>

    <!-- 状态卡 -->
    <div class="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
      <div class="rounded border border-line-subtle bg-surface-base p-3">
        <div class="text-xs text-fg-3">在售模型</div>
        <div class="text-2xl font-semibold text-fg">{{ new Set(subjects.map((s) => s.modelKey)).size }}</div>
      </div>
      <div class="rounded border border-line-subtle bg-surface-base p-3">
        <div class="text-xs text-fg-3">定价项总数</div>
        <div class="text-2xl font-semibold text-fg">{{ totalSubjects }}</div>
      </div>
      <div class="rounded border border-line-subtle bg-surface-base p-3">
        <div class="text-xs text-fg-3">已出价</div>
        <div class="text-2xl font-semibold text-success">{{ pricedCount ?? '—' }}</div>
      </div>
      <div class="rounded border border-line-subtle bg-surface-base p-3">
        <div class="text-xs text-fg-3">缺成本</div>
        <div class="text-2xl font-semibold" :class="missingCount && missingCount > 0 ? 'text-danger' : 'text-fg'">{{ missingCount ?? '—' }}</div>
      </div>
    </div>

    <!-- 三步操作 -->
    <div class="mb-4 grid grid-cols-1 gap-3 md:grid-cols-3">
      <!-- 第 1 步：利润率 -->
      <div class="rounded border border-line-subtle bg-surface-base p-3">
        <h2 class="mb-2 text-sm font-semibold text-fg">① 平台利润率（加价 %）</h2>
        <div class="flex items-center gap-2">
          <el-input-number v-model="profitPct" :min="0" :max="500" :step="1" />
          <span class="text-sm text-fg-2">%（当前生效：{{ globalMargin ? Math.round(globalMargin.profitBp / 100) : 10 }}%）</span>
        </div>
        <p class="mt-1 text-xs text-fg-3">平台卖价 = 成本 × (1 + 此利润率)。底价地板 5% 不可击穿。</p>
        <el-button class="mt-2" size="small" type="primary" :loading="savingMargin" @click="saveMargin">保存利润率</el-button>
      </div>

      <!-- 第 2 步：导入成本 -->
      <div class="rounded border border-line-subtle bg-surface-base p-3">
        <h2 class="mb-2 text-sm font-semibold text-fg">② 导入成本</h2>
        <p class="text-xs text-fg-3">已登记成本行 {{ importedCostCount }} 条。按「模型, 档位, 每单位成本(元)」逐行粘贴，系统自动识别计量单位。</p>
        <el-button class="mt-2" size="small" type="primary" @click="importVisible = true">一键导入成本</el-button>
      </div>

      <!-- 第 3 步：更新价目 -->
      <div class="rounded border border-line-subtle bg-surface-base p-3">
        <h2 class="mb-2 text-sm font-semibold text-fg">③ 更新价目</h2>
        <p class="text-xs text-fg-3">重建定价主体 → 用成本×利润率算出所有定价项 → 落草案。下方显示已出价 / 缺成本。</p>
        <el-button class="mt-2" size="small" type="primary" :loading="refreshing" @click="refreshPricing">一键更新价目</el-button>
      </div>
    </div>

    <!-- 缺成本清单 -->
    <div v-if="missingList.length > 0" class="mb-3 rounded border border-warning-border bg-warning-bg p-3">
      <h3 class="mb-1 text-sm font-semibold text-warning">还差 {{ missingList.length }} 项缺成本（到「导入成本」补上即可出价）</h3>
      <div class="flex flex-wrap gap-1 text-xs">
        <el-tag v-for="m in missingList" :key="m" size="small" type="warning">{{ m }}</el-tag>
      </div>
    </div>

    <!-- 物化摘要 -->
    <div v-if="lastMaterialize" class="rounded border border-line-subtle bg-surface-base p-3 text-sm">
      <h3 class="mb-1 font-semibold text-fg">本次物化摘要</h3>
      <p class="text-fg-2">新增 {{ lastMaterialize.added }} / 变更 {{ lastMaterialize.changed }} / 不变 {{ lastMaterialize.unchanged }}</p>
      <p v-if="lastReadinessOk === true" class="text-success">发布门禁：通过，可发布</p>
      <p v-else-if="lastReadinessOk === false" class="text-danger">发布门禁：未通过（见顶部提示）</p>
    </div>

    <!-- 导入成本对话框 -->
    <el-dialog v-model="importVisible" title="一键导入成本" width="560px">
      <p class="mb-2 text-sm text-fg-3">
        每行填：<code>模型, 档位, 每单位成本(元)</code>。例：<code>agnes-video-2.5-flash, 768p:5s, 2.86</code>。
        模型与档位需与「高级模式 → 定价主体」页完全一致；单位为人民币元。
      </p>
      <el-input v-model="importText" type="textarea" :rows="10" placeholder="agnes-video-2.5-flash, 768p:5s, 2.86&#10;cogvideox-flash, 480p:5s, 1.5&#10;h3-max-turbo, 768p:5s, 3.0" />
      <pre v-if="importResultText" class="mt-2 max-h-40 overflow-auto rounded bg-surface-muted p-2 text-xs text-fg-2">{{ importResultText }}</pre>
      <template #footer>
        <el-button @click="importVisible = false">关闭</el-button>
        <el-button type="primary" :loading="importing" @click="doImport">导入</el-button>
      </template>
    </el-dialog>
  </section>
</template>
