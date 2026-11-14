<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  adminApi,
  AdminApiError,
  type PricingSubjectRow,
  type SubjectRebuildResult,
  type MaterializeResult,
  type VersionReadiness,
  type AdminPriceListVersion,
} from '@/services/admin-api'

/**
 * S1：定价主体页（运维入口）。
 * - 主体列表：展示 subjectKey / 能力 / 模型 / 档位 / 上游 / 成本覆盖状态；
 *   cost_missing 红标（提示运营先去「成本配置」补成本行，否则物化会缺成本主体）。
 * - 重建主体：以 ModelCatalogEntry 为真源幂等重建（PricingSubjectService.rebuild）。
 * - 物化工作流：选草案 → 物化（成本×利润→积分落草案）→ 就绪检查（发布门禁七条硬拒）
 *   → 发布（仅就绪时放行）。
 */

const loading = ref(false)
const actionError = ref('')
const subjects = ref<PricingSubjectRow[]>([])
const rebuildResult = ref<SubjectRebuildResult | null>(null)

// 物化工作流
const versions = ref<AdminPriceListVersion[]>([])
const draftId = ref('')
const materializeLoading = ref(false)
const materializeResult = ref<MaterializeResult | null>(null)
const readinessLoading = ref(false)
const readiness = ref<VersionReadiness | null>(null)
const publishing = ref(false)

const draftOptions = computed(() => versions.value.filter((v) => v.status === 'draft'))
const hasCostMissing = computed(() => subjects.value.some((s) => s.status === 'cost_missing'))

function errMsg(err: unknown, fallback: string): string {
  return err instanceof AdminApiError ? err.message : fallback
}

function statusTagType(status: string): 'danger' | 'warning' | 'success' | 'info' {
  if (status === 'cost_missing') return 'danger'
  if (status === 'priced') return 'success'
  if (status === 'draft') return 'warning'
  return 'info'
}

async function reloadSubjects() {
  loading.value = true
  actionError.value = ''
  try {
    subjects.value = await adminApi.pricingS1.listSubjects()
  } catch (err) {
    actionError.value = errMsg(err, '主体加载失败')
  } finally {
    loading.value = false
  }
}

async function reloadVersions() {
  try {
    versions.value = await adminApi.pricingVersions.list()
    if (!draftId.value && draftOptions.value.length > 0) {
      draftId.value = draftOptions.value[0].id
    }
  } catch {
    // 版本列表非阻断：物化面板会提示先建草案
  }
}

async function rebuild() {
  actionError.value = ''
  try {
    rebuildResult.value = await adminApi.pricingS1.rebuildSubjects()
    ElMessage.success(`主体重建完成：新增 ${rebuildResult.value.added} / 未变 ${rebuildResult.value.unchanged}`)
    await reloadSubjects()
  } catch (err) {
    actionError.value = errMsg(err, '重建主体失败')
  }
}

async function materialize() {
  if (!draftId.value) {
    actionError.value = '请先选择或创建一份 draft 草案（去「价目发布流」页建草案）'
    return
  }
  materializeLoading.value = true
  actionError.value = ''
  readiness.value = null
  try {
    materializeResult.value = await adminApi.pricingS1.materializeDraft(draftId.value)
    ElMessage.success(
      `物化完成：新增 ${materializeResult.value.added} / 变更 ${materializeResult.value.changed} / 不变 ${materializeResult.value.unchanged}`,
    )
  } catch (err) {
    actionError.value = errMsg(err, '物化失败')
  } finally {
    materializeLoading.value = false
  }
}

async function checkReadiness() {
  if (!draftId.value) {
    actionError.value = '请先选择或创建一份 draft 草案'
    return
  }
  readinessLoading.value = true
  actionError.value = ''
  try {
    readiness.value = await adminApi.pricingS1.getReadiness(draftId.value)
  } catch (err) {
    actionError.value = errMsg(err, '就绪检查失败')
  } finally {
    readinessLoading.value = false
  }
}

async function publish() {
  if (!draftId.value) return
  actionError.value = ''
  if (!readiness.value) await checkReadiness()
  const r = readiness.value
  if (!r) return
  if (!r.ok) {
    actionError.value = `发布门禁未通过：${r.violations.join('；')}`
    return
  }
  try {
    await ElMessageBox.confirm(`确认发布所选草案？`, '发布确认', {
      type: 'warning',
      confirmButtonText: '发布',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  publishing.value = true
  try {
    const { version } = await adminApi.pricingVersions.publish(draftId.value)
    ElMessage.success(`已发布 ${version}`)
    materializeResult.value = null
    readiness.value = null
    await reloadVersions()
  } catch (err) {
    actionError.value = errMsg(err, '发布失败')
  } finally {
    publishing.value = false
  }
}

onMounted(() => {
  reloadSubjects()
  reloadVersions()
})

defineExpose({
  reloadSubjects,
  reloadVersions,
  rebuild,
  materialize,
  checkReadiness,
  publish,
  subjects,
  versions,
  draftId,
  materializeResult,
  readiness,
  actionError,
})
</script>

<template>
  <section class="p-2">
    <header class="mb-3 flex items-center gap-3">
      <h1 class="text-base font-semibold text-fg">定价主体</h1>
      <span class="text-sm text-fg-3">S1 成本/利润/物化真源（以模型目录为唯一真源重建）</span>
      <el-button :loading="loading" @click="reloadSubjects">刷新</el-button>
      <el-button type="primary" @click="rebuild">重建主体</el-button>
    </header>
    <p v-if="actionError" class="mb-2 rounded border border-danger-border bg-danger-bg p-2 text-sm text-danger">{{ actionError }}</p>
    <p v-if="rebuildResult" class="mb-2 rounded border border-line-subtle bg-surface-base p-2 text-sm text-fg-2">
      上次重建：新增 {{ rebuildResult.added }} / 未变 {{ rebuildResult.unchanged }}
    </p>
    <p v-if="hasCostMissing" class="mb-2 rounded border border-warning-border bg-warning-bg p-2 text-sm text-warning">
      存在 cost_missing 主体（红标）：请先到「成本配置」补对应成本行，否则物化会缺成本主体、发布被拒。
    </p>

    <el-table :data="subjects" v-loading="loading" size="small" border max-height="520">
      <el-table-column prop="subjectKey" label="subjectKey" min-width="220" />
      <el-table-column prop="capability" label="能力" width="110" />
      <el-table-column prop="modelKey" label="模型" min-width="140" />
      <el-table-column prop="spec" label="档位" width="100" />
      <el-table-column prop="provider" label="provider" width="100" />
      <el-table-column prop="upstream" label="upstream" width="110" />
      <el-table-column prop="billableUnit" label="计量单位" width="120" />
      <el-table-column label="成本覆盖状态" width="120">
        <template #default="{ row }">
          <el-tag :type="statusTagType(row.status)" size="small">{{ row.status }}</el-tag>
        </template>
      </el-table-column>
    </el-table>

    <!-- 物化工作流面板 -->
    <div class="mt-4 rounded border border-line-subtle bg-surface-base p-3">
      <h2 class="mb-2 text-sm font-semibold text-fg">物化 / 发布工作流</h2>
      <div class="mb-3 flex items-center gap-2">
        <span class="text-sm text-fg-2">选择草案：</span>
        <el-select v-model="draftId" placeholder="选择 draft 版本" class="w-72">
          <el-option v-for="v in draftOptions" :key="v.id" :label="`${v.version}（${v.status}）`" :value="v.id" />
        </el-select>
        <span v-if="draftOptions.length === 0" class="text-sm text-warning">无 draft，请先到「价目发布流」建草案</span>
        <el-button size="small" type="primary" :loading="materializeLoading" @click="materialize">物化</el-button>
        <el-button size="small" :loading="readinessLoading" @click="checkReadiness">就绪检查</el-button>
        <el-button size="small" type="warning" :disabled="!readiness || !readiness.ok" :loading="publishing" @click="publish">发布</el-button>
      </div>

      <div v-if="materializeResult" class="mb-2 text-sm" data-test="materialize-result">
        <p class="text-fg-2">
          物化：新增 {{ materializeResult.added }} / 变更 {{ materializeResult.changed }} / 不变 {{ materializeResult.unchanged }}
        </p>
        <p v-if="materializeResult.missingCost.length > 0" class="text-danger">缺成本主体 {{ materializeResult.missingCost.length }} 条：{{ materializeResult.missingCost.join(', ') }}</p>
        <p v-if="materializeResult.floorViolations.length > 0" class="text-danger">
          地板违规 {{ materializeResult.floorViolations.length }} 条：
          <span v-for="v in materializeResult.floorViolations" :key="v.matchKey" class="mr-2">{{ v.matchKey }} {{ v.kind === 'max' ? '>' : '<' }}={{ v.limit }}</span>
        </p>
        <p v-if="materializeResult.noCostCoverage.length > 0" class="text-warning">无成本覆盖 {{ materializeResult.noCostCoverage.length }} 条</p>
      </div>

      <div v-if="readiness" class="text-sm" data-test="readiness">
        <p v-if="readiness.ok" class="text-success">就绪：可发布（发布门禁七条全过）</p>
        <p v-else class="text-danger">发布门禁未通过 {{ readiness.violations.length }} 条：{{ readiness.violations.join('；') }}</p>
      </div>
    </div>
  </section>
</template>
