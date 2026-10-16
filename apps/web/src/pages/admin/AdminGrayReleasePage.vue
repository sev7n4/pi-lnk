<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  adminApi,
  AdminApiError,
  type AdminGrayRelease,
  type AdminGrayPreview,
  type AdminGrayReport,
  type AdminPriceListVersion,
} from '@/services/admin-api'

/**
 * P1-a T8：白名单灰度发布页（spec §8.5 防线的前端表达）：
 * 创建前必须先「预览命中」，N 命中 / M 未命中显式展示、未命中号码逐个列出；
 * 未预览或 hits=0 时创建按钮禁用（disabled，不是隐藏）。
 */

const loading = ref(false)
const actionError = ref('')
const releases = ref<AdminGrayRelease[]>([])
const drafts = ref<AdminPriceListVersion[]>([])

// 创建表单
const formVersionId = ref('')
const formRawInput = ref('')
const formNote = ref('')
// 日期时间选择器的值：ISO 字符串（value-format 产出）；清空时 Element Plus 置 null
const formStartsAt = ref<string | null>('')
const formEndsAt = ref<string | null>('')

// 预览命中（创建前置）
const preview = ref<AdminGrayPreview | null>(null)
const previewLoading = ref(false)
const creating = ref(false)

// 报告抽屉
const reportVisible = ref(false)
const report = ref<AdminGrayReport | null>(null)

/** 仅 draft 可灰度（后端 createRelease 硬校验 status==='draft'）；无 draft 时下拉禁用 + 空态提示 */
const hasDraft = computed(() => drafts.value.length > 0)

/** 防线：必须已预览且命中 > 0 且已选版本，才允许创建 */
const canCreate = computed(
  () => preview.value !== null && preview.value.hits.length > 0 && formVersionId.value !== '',
)

/** 创建禁用原因：按钮禁用时给出明确指引，避免「禁止符号无解释」的空转 */
const createDisabledReason = computed(() => {
  if (!hasDraft.value) return '当前无 draft 版本可灰度——灰度对象必须是 draft（草案）'
  if (formVersionId.value === '') return '请先选择灰度版本'
  if (preview.value === null) return '请粘贴名单并点「预览命中」'
  if (preview.value.hits.length === 0) return '名单 0 命中，创建已禁用（空集假绿防线）'
  return ''
})

// 预览态失效：名单或版本一变，陈旧命中数立即作废（否则面板显示旧命中数、按钮仍可点 → 服务端 400）
watch([formRawInput, formVersionId], () => {
  preview.value = null
})

function errMsg(err: unknown, fallback: string): string {
  return err instanceof AdminApiError ? err.message : fallback
}

/** 日期选择器清空时值为 null；统一归一：空串/null → undefined（后端默认 now / +7 天） */
function normDate(v: string | null): string | undefined {
  const s = typeof v === 'string' ? v.trim() : ''
  return s === '' ? undefined : s
}

async function reload() {
  loading.value = true
  actionError.value = ''
  try {
    const [rows, versions] = await Promise.all([adminApi.pricingGray.list(), adminApi.pricingVersions.list()])
    releases.value = rows
    drafts.value = versions.filter((v) => v.status === 'draft')
  } catch (err) {
    actionError.value = errMsg(err, '加载失败')
  } finally {
    loading.value = false
  }
}

async function loadPreview() {
  actionError.value = ''
  if (formRawInput.value.trim() === '') {
    actionError.value = '请先粘贴名单再预览命中'
    return
  }
  previewLoading.value = true
  try {
    preview.value = await adminApi.pricingGray.preview(formRawInput.value)
  } catch (err) {
    actionError.value = errMsg(err, '预览失败')
  } finally {
    previewLoading.value = false
  }
}

async function createGray() {
  actionError.value = ''
  if (!canCreate.value) return
  creating.value = true
  try {
    const created = await adminApi.pricingGray.create({
      versionId: formVersionId.value,
      rawInput: formRawInput.value,
      startsAt: normDate(formStartsAt.value),
      endsAt: normDate(formEndsAt.value),
      note: formNote.value.trim() === '' ? undefined : formNote.value,
    })
    ElMessage.success(`灰度已创建：${created.releaseId}（${created.hits} 人命中，按 ${created.version} 计价）`)
    preview.value = null
    formRawInput.value = ''
    formNote.value = ''
    formStartsAt.value = ''
    formEndsAt.value = ''
    await reload()
  } catch (err) {
    actionError.value = errMsg(err, '创建失败')
  } finally {
    creating.value = false
  }
}

async function openReport(id: string) {
  actionError.value = ''
  try {
    report.value = await adminApi.pricingGray.report(id)
    reportVisible.value = true
  } catch (err) {
    actionError.value = errMsg(err, '报告加载失败')
  }
}

async function promote(id: string) {
  actionError.value = ''
  try {
    await ElMessageBox.confirm('转正会把该灰度版本发布为全局 active（走发布流校验），确认转正？', '转正确认', {
      type: 'warning',
      confirmButtonText: '转正',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    const { version } = await adminApi.pricingGray.promote(id)
    ElMessage.success(`已转正 ${version} 为全局 active`)
    await reload()
  } catch (err) {
    actionError.value = errMsg(err, '转正失败')
  }
}

async function rollbackRelease(id: string) {
  actionError.value = ''
  try {
    // 文案与实现对齐：服务端 gray rollback 成功后已 invalidate 计价缓存，名单用户
    // 下一笔报价即回global；「约 30s 内」是保守上限（缓存 TTL），不承诺「立即」。
    await ElMessageBox.confirm('关停后名单用户约 30s 内回到全局价目，确认关停？', '关停确认', {
      type: 'warning',
      confirmButtonText: '关停',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    await adminApi.pricingGray.rollback(id)
    ElMessage.success('灰度已关停（rolled_back）')
    await reload()
  } catch (err) {
    actionError.value = errMsg(err, '关停失败')
  }
}

function statusTagType(status: string): 'success' | 'warning' | 'info' | 'danger' {
  if (status === 'active') return 'success'
  if (status === 'promoted') return 'warning'
  if (status === 'rolled_back') return 'danger'
  return 'info'
}

onMounted(reload)

// 测试经 w.vm 直调（同 AdminPricingPage 先例）：script setup 顶层绑定默认不暴露。
defineExpose({
  reload,
  loadPreview,
  createGray,
  openReport,
  promote,
  rollbackRelease,
  releases,
  drafts,
  formVersionId,
  formRawInput,
  formNote,
  formStartsAt,
  formEndsAt,
  preview,
  report,
  canCreate,
  hasDraft,
  createDisabledReason,
  actionError,
})
</script>

<template>
  <section class="p-2">
    <header class="mb-3 flex items-center gap-3">
      <h1 class="text-base font-semibold text-fg">灰度发布</h1>
      <el-button :loading="loading" @click="reload">刷新</el-button>
    </header>
    <p v-if="actionError" class="mb-2 rounded border border-danger-border bg-danger-bg p-2 text-sm text-danger">{{ actionError }}</p>

    <!-- 创建表单 + 预览命中防线 -->
    <div class="mb-3 rounded border border-line-subtle bg-surface-base p-3">
      <div class="mb-2 flex items-center gap-2">
        <span class="text-sm text-fg-2">灰度版本（仅 draft）：</span>
        <el-select
          v-model="formVersionId"
          placeholder="选择 draft 版本"
          class="w-64"
          :disabled="!hasDraft"
        >
          <el-option v-for="v in drafts" :key="v.id" :label="`${v.version}（${v.entryCount} 条）`" :value="v.id" />
        </el-select>
        <span v-if="!hasDraft" class="text-sm text-warning" data-test="no-draft-hint">
          当前无 draft 版本——灰度对象必须是 draft（草案）。请先在「价目发布流」页复制 active 建草案；发布后 draft 会被消耗，无法再对该版本灰度。
        </span>
      </div>
      <el-input
        v-model="formRawInput"
        type="textarea"
        :rows="3"
        placeholder="名单手机号（换行/逗号/空格分隔）；先「预览命中」再创建"
        class="mb-2"
      />
      <div class="mb-2 flex items-center gap-2">
        <el-date-picker
          v-model="formStartsAt"
          type="datetime"
          placeholder="开始时间（可选，默认现在）"
          value-format="YYYY-MM-DDTHH:mm:ss.SSSZ"
          class="w-64"
        />
        <el-date-picker
          v-model="formEndsAt"
          type="datetime"
          placeholder="结束时间（可选，默认 +7 天）"
          value-format="YYYY-MM-DDTHH:mm:ss.SSSZ"
          class="w-64"
        />
        <el-input v-model="formNote" placeholder="备注（可选）" class="w-48" />
        <el-button :loading="previewLoading" @click="loadPreview">预览命中</el-button>
        <el-button
          type="primary"
          :disabled="!canCreate"
          :loading="creating"
          data-test="create-btn"
          @click="createGray"
        >创建灰度</el-button>
      </div>
      <p v-if="!canCreate" class="text-sm text-fg-3" data-test="create-disabled-reason">{{ createDisabledReason }}</p>

      <!-- 预览结果：N 命中 / M 未命中显式展示，未命中号码逐个列出 -->
      <div v-if="preview" class="text-sm" data-test="preview-panel">
        <p :class="preview.hits.length === 0 ? 'text-danger' : 'text-fg-2'">
          命中 {{ preview.hits.length }} 人 / 未命中 {{ preview.misses.length }} 个
        </p>
        <p v-if="preview.misses.length > 0" class="text-danger" data-test="miss-list">
          未命中号码（逐个）：{{ preview.misses.join('、') }}
        </p>
        <p v-if="preview.hits.length > 0" class="text-fg-3">
          命中：{{ preview.hits.map((h) => h.phone).join('、') }}
        </p>
        <p v-if="preview.hits.length === 0" class="text-danger">0 命中：创建按钮已禁用（空集假绿防线）</p>
      </div>
    </div>

    <!-- release 列表 -->
    <el-table :data="releases" v-loading="loading" size="small" border>
      <el-table-column prop="version" label="版本" min-width="130" />
      <el-table-column label="状态" width="120">
        <template #default="{ row }">
          <el-tag :type="statusTagType(row.status)" size="small">{{ row.status }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="hits" label="命中数" width="80" />
      <el-table-column label="窗口" min-width="280">
        <template #default="{ row }">{{ row.startsAt }} ~ {{ row.endsAt }}</template>
      </el-table-column>
      <el-table-column prop="note" label="备注" min-width="120" />
      <el-table-column label="操作" width="220" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openReport(row.id)">报告</el-button>
          <el-button v-if="row.status === 'active'" link type="warning" @click="promote(row.id)">转正</el-button>
          <el-button v-if="row.status === 'active'" link type="danger" @click="rollbackRelease(row.id)">关停</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 报告抽屉（全字段；txAmountByCategory 含 refund 行，直接展示） -->
    <el-drawer v-model="reportVisible" title="灰度发布报告" size="420px">
      <div v-if="report" class="text-sm" data-test="report-panel">
        <p class="mb-1"><span class="text-fg-3">releaseId：</span>{{ report.releaseId }}</p>
        <p class="mb-1"><span class="text-fg-3">版本：</span>{{ report.version }}（{{ report.status }}）</p>
        <p class="mb-1"><span class="text-fg-3">命中数：</span>{{ report.hits }}</p>
        <p class="mb-1"><span class="text-fg-3">交易笔数（含退款）：</span>{{ report.txCount }} / 退款 {{ report.refundCount }} 笔</p>
        <p class="mb-1">
          <span class="text-fg-3">分目录金额（含 refund 行）：</span>
          <template v-if="Object.keys(report.txAmountByCategory).length > 0">
            <span v-for="(amount, cat) in report.txAmountByCategory" :key="cat" class="mr-2">{{ cat }}={{ amount }}</span>
          </template>
          <template v-else>无</template>
        </p>
        <p class="mb-1 mt-2 font-semibold text-fg">按用户消费</p>
        <el-table :data="report.byUser" size="small" border>
          <el-table-column prop="userId" label="用户" min-width="160" />
          <el-table-column prop="consumeCount" label="笔数" width="70" />
          <el-table-column prop="consumeTotal" label="消费总额" width="100" />
        </el-table>
      </div>
    </el-drawer>
  </section>
</template>
