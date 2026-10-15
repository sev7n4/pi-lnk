<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  adminApi,
  AdminApiError,
  type AdminPriceListVersion,
  type AdminDiffSummary,
  type AdminPublishEntry,
  type AdminDraftView,
} from '@/services/admin-api'

/**
 * P1-a T8：价目版本发布流页（draft → diff → publish → rollback 单向流）。
 * 防线：发布前必须先看 diff（publish 内自动加载）；发布/回滚二次确认；
 * diff 的 floorViolations/missingCost/noCostCoverage 标红/标注。
 */

const loading = ref(false)
const actionError = ref('')
const versions = ref<AdminPriceListVersion[]>([])

// 建草案表单（复制 active 基线）
const draftVersion = ref('')
const draftNote = ref('')

// 草案编辑（matchKey/credits 行内改值）
const draft = ref<AdminDraftView | null>(null)
const editCredits = ref<Record<string, string>>({})
const savingEntries = ref(false)

// 影响面预览
const diff = ref<AdminDiffSummary | null>(null)
const diffLoading = ref(false)

const activeVersion = computed(() => versions.value.find((v) => v.status === 'active')?.version ?? null)

function errMsg(err: unknown, fallback: string): string {
  return err instanceof AdminApiError ? err.message : fallback
}

async function reload() {
  loading.value = true
  actionError.value = ''
  try {
    versions.value = await adminApi.pricingVersions.list()
  } catch (err) {
    actionError.value = errMsg(err, '加载失败')
  } finally {
    loading.value = false
  }
}

async function createDraft() {
  actionError.value = ''
  const version = draftVersion.value.trim()
  const note = draftNote.value.trim()
  if (version === '' || note === '') {
    actionError.value = 'version / note 必须是非空字符串'
    return
  }
  try {
    const created = await adminApi.pricingVersions.createDraft(version, note)
    ElMessage.success(`草案 ${created.version} 已创建（${created.entries} 条条目）`)
    draftVersion.value = ''
    draftNote.value = ''
    await reload()
    await openDraft(created.id)
  } catch (err) {
    actionError.value = errMsg(err, '建草案失败')
  }
}

async function openDraft(id: string) {
  actionError.value = ''
  try {
    draft.value = await adminApi.pricingVersions.get(id)
    diff.value = null
    editCredits.value = Object.fromEntries(draft.value.entries.map((e) => [e.matchKey, String(e.credits)]))
  } catch (err) {
    actionError.value = errMsg(err, '加载草案失败')
  }
}

async function saveEntries() {
  if (!draft.value) return
  actionError.value = ''
  const entries: AdminPublishEntry[] = []
  for (const e of draft.value.entries) {
    const raw = (editCredits.value[e.matchKey] ?? '').trim()
    const n = Number(raw)
    if (!Number.isInteger(n) || n <= 0) {
      actionError.value = `${e.matchKey}.credits 必须是正整数，收到: ${raw}`
      return
    }
    entries.push({ ...e, credits: n })
  }
  savingEntries.value = true
  try {
    const { written } = await adminApi.pricingVersions.putEntries(draft.value.id, entries)
    ElMessage.success(`已保存 ${written} 条条目`)
    diff.value = null
    await openDraft(draft.value.id)
  } catch (err) {
    actionError.value = errMsg(err, '保存失败')
  } finally {
    savingEntries.value = false
  }
}

async function loadDiff() {
  if (!draft.value) return
  diffLoading.value = true
  actionError.value = ''
  try {
    diff.value = await adminApi.pricingVersions.diff(draft.value.id)
  } catch (err) {
    actionError.value = errMsg(err, 'diff 加载失败')
  } finally {
    diffLoading.value = false
  }
}

async function publish() {
  if (!draft.value) return
  actionError.value = ''
  // 发布前强制拉取 diff：确认弹窗中展示最大涨幅
  if (!diff.value) await loadDiff()
  const d = diff.value
  if (!d) return
  const inc = d.maxIncrease
  const incText = inc
    ? `最大涨幅：${inc.matchKey} ${inc.from} → ${inc.to}（+${(inc.pct * 100).toFixed(1)}%）`
    : '无条目上调'
  try {
    await ElMessageBox.confirm(`确认发布 ${d.draftVersion} 为 active？${incText}`, '发布确认', {
      type: 'warning',
      confirmButtonText: '发布',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    const { version } = await adminApi.pricingVersions.publish(draft.value.id)
    ElMessage.success(`已发布 ${version}`)
    draft.value = null
    diff.value = null
    await reload()
  } catch (err) {
    actionError.value = errMsg(err, '发布失败')
  }
}

async function rollback() {
  actionError.value = ''
  try {
    await ElMessageBox.confirm('回滚会把当前 active 换成最近一个已发布版本，确认回滚？', '回滚确认', {
      type: 'warning',
      confirmButtonText: '回滚',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    const { version } = await adminApi.pricingVersions.rollback()
    ElMessage.success(`已回滚到 ${version}`)
    await reload()
  } catch (err) {
    actionError.value = errMsg(err, '回滚失败')
  }
}

function statusTagType(status: string): 'warning' | 'success' | 'info' {
  if (status === 'active') return 'success'
  if (status === 'draft') return 'warning'
  return 'info'
}

onMounted(reload)

// 测试经 w.vm 直调（同 AdminPricingPage 先例）：script setup 顶层绑定默认不暴露。
defineExpose({
  reload,
  createDraft,
  openDraft,
  saveEntries,
  loadDiff,
  publish,
  rollback,
  versions,
  draft,
  editCredits,
  diff,
  actionError,
  draftVersion,
  draftNote,
  activeVersion,
})
</script>

<template>
  <section class="p-2">
    <header class="mb-3 flex items-center gap-3">
      <h1 class="text-base font-semibold text-fg">价目版本发布流</h1>
      <span class="text-sm text-fg-3">当前 active：{{ activeVersion ?? '（无）' }}</span>
      <el-button :loading="loading" @click="reload">刷新</el-button>
      <el-button type="danger" plain @click="rollback">回滚</el-button>
    </header>
    <p v-if="actionError" class="mb-2 rounded border border-danger-border bg-danger-bg p-2 text-sm text-danger">{{ actionError }}</p>

    <!-- 建草案 -->
    <div class="mb-3 flex items-center gap-2 rounded border border-line-subtle bg-surface-base p-3">
      <span class="text-sm text-fg-2">复制 active 建草案：</span>
      <el-input v-model="draftVersion" placeholder="新版本号（如 2026.11-A）" class="w-52" />
      <el-input v-model="draftNote" placeholder="变更说明（note）" class="w-72" />
      <el-button type="primary" @click="createDraft">建草案</el-button>
    </div>

    <!-- 版本列表 -->
    <el-table :data="versions" v-loading="loading" size="small" border>
      <el-table-column prop="version" label="版本" min-width="140" />
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="statusTagType(row.status)" size="small">{{ row.status }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="note" label="说明" min-width="160" />
      <el-table-column prop="entryCount" label="条目数" width="80" />
      <el-table-column prop="publishedAt" label="发布时间" min-width="160" />
      <el-table-column label="操作" width="110" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" :disabled="row.status !== 'draft'" @click="openDraft(row.id)">编辑草案</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 草案编辑 -->
    <div v-if="draft" class="mt-4 rounded border border-line-subtle bg-surface-base p-3">
      <div class="mb-2 flex items-center gap-3">
        <h2 class="text-sm font-semibold text-fg">编辑草案 · {{ draft.version }}（{{ draft.status }}）</h2>
        <el-button size="small" type="primary" :loading="savingEntries" @click="saveEntries">保存条目</el-button>
        <el-button size="small" :loading="diffLoading" @click="loadDiff">影响面预览</el-button>
        <el-button size="small" type="warning" @click="publish">发布</el-button>
      </div>
      <el-table :data="draft.entries" size="small" border>
        <el-table-column prop="matchKey" label="matchKey" min-width="200" />
        <el-table-column prop="capability" label="capability" width="110" />
        <el-table-column prop="basis" label="basis" min-width="140" />
        <el-table-column prop="costRateId" label="costRateId" min-width="140" />
        <el-table-column label="credits（行内改值）" width="160">
          <template #default="{ row }">
            <el-input v-model="editCredits[row.matchKey]" size="small" />
          </template>
        </el-table-column>
      </el-table>

      <!-- 影响面预览（diff 全字段；风险项标红/标注） -->
      <div v-if="diff" class="mt-3 text-sm" data-test="diff-panel">
        <p class="mb-1 font-semibold text-fg">
          影响面：{{ diff.draftVersion }}（draft）vs {{ diff.activeVersion ?? '（无 active 基线）' }}
        </p>
        <p class="mb-1 text-fg-2">
          新增 {{ diff.added }} / 删除 {{ diff.removed }} / 变更 {{ diff.changed }} / 不变 {{ diff.unchanged }}
        </p>
        <p class="mb-1 text-fg-2">
          最大涨幅：<template v-if="diff.maxIncrease">{{ diff.maxIncrease.matchKey }} {{ diff.maxIncrease.from }} → {{ diff.maxIncrease.to }}（+{{ (diff.maxIncrease.pct * 100).toFixed(1) }}%）</template><template v-else>无</template>
        </p>
        <p class="mb-1 text-fg-2">
          最大降幅：<template v-if="diff.maxDecrease">{{ diff.maxDecrease.matchKey }} {{ diff.maxDecrease.from }} → {{ diff.maxDecrease.to }}（{{ (diff.maxDecrease.pct * 100).toFixed(1) }}%）</template><template v-else>无</template>
        </p>
        <p v-if="diff.floorViolations.length > 0" class="mb-1 text-danger" data-test="floor-violations">
          地板违规 {{ diff.floorViolations.length }} 条：
          <span v-for="v in diff.floorViolations" :key="v.matchKey" class="mr-2">{{ v.matchKey }} credits={{ v.credits }} &lt; floor={{ v.floor }}</span>
        </p>
        <p v-if="diff.missingCost.length > 0" class="mb-1 text-danger" data-test="missing-cost">
          成本费率缺失（发布时跳过地板并告警）：{{ diff.missingCost.join(', ') }}
        </p>
        <p v-if="diff.noCostCoverage.length > 0" class="mb-1 text-warning" data-test="no-cost-coverage">
          无成本覆盖（地板跳过标注）：{{ diff.noCostCoverage.join(', ') }}
        </p>
        <p v-if="diff.floorViolations.length === 0 && diff.missingCost.length === 0" class="text-fg-3">无地板违规、无成本费率缺失</p>
      </div>
    </div>
  </section>
</template>
