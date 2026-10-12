<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { adminApi, AdminApiError, type ChannelModelEntry } from '@/services/admin-api'

const loading = ref(false)
const channelName = ref('')
const parseError = ref(false)
const models = ref<ChannelModelEntry[]>([])
const actionError = ref('')

const PRICING_KEYS = ['inputPerM', 'outputPerM', 'cacheReadPerM', 'cacheWritePerM'] as const
type PricingKey = (typeof PRICING_KEYS)[number]

const configuredCount = computed(() => models.value.filter((m) => m.pricing != null).length)

const editorVisible = ref(false)
const editingName = ref('')
const pricingForm = ref<Record<PricingKey, string>>({ inputPerM: '', outputPerM: '', cacheReadPerM: '', cacheWritePerM: '' })

async function reload() {
  loading.value = true
  actionError.value = ''
  try {
    const data = await adminApi.platformChannel()
    channelName.value = data.name
    parseError.value = data.parseError
    models.value = data.models
  } catch (err) {
    actionError.value = err instanceof AdminApiError ? err.message : '加载失败'
  } finally {
    loading.value = false
  }
}

function pricingText(m: ChannelModelEntry): string {
  // Follow-up ③（前端）：pricing:null 与未配置同义（pull-models 事故残留形态）
  if (m.pricing == null) return '未配定价'
  return PRICING_KEYS.filter((k) => m.pricing?.[k] !== undefined)
    .map((k) => `${k}=${m.pricing![k]}`)
    .join(' / ')
}

function openEditor(name: string) {
  const m = models.value.find((x) => x.name === name)
  editingName.value = name
  pricingForm.value = { inputPerM: '', outputPerM: '', cacheReadPerM: '', cacheWritePerM: '' }
  if (m?.pricing) {
    for (const k of PRICING_KEYS) {
      if (m.pricing[k] !== undefined) pricingForm.value[k] = String(m.pricing[k])
    }
  }
  editorVisible.value = true
}

/** 四字段文本 → 对象；非法输入返回 null 并设置 actionError。 */
function buildPricingPayload(): Record<string, number> | null {
  const out: Record<string, number> = {}
  for (const k of PRICING_KEYS) {
    const raw = pricingForm.value[k].trim()
    if (raw === '') continue
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0) {
      actionError.value = `pricing.${k} 必须是非负有限数，收到: ${raw}`
      return null
    }
    out[k] = n
  }
  if (Object.keys(out).length === 0) {
    actionError.value = '至少填写一个费率字段（全部留空请用「清除」）'
    return null
  }
  return out
}

async function submitPricing() {
  actionError.value = ''
  const payload = buildPricingPayload()
  if (payload === null) return
  try {
    await adminApi.setPlatformModelPricing(editingName.value, payload)
    ElMessage.success('已保存，下一生成会话即生效')
    editorVisible.value = false
    await reload()
  } catch (err) {
    actionError.value = err instanceof AdminApiError ? err.message : '保存失败'
  }
}

async function clearPricing(name: string) {
  actionError.value = ''
  try {
    await ElMessageBox.confirm(`确认清除 ${name} 的定价？（清除后该模型不计费）`, '清除确认', {
      type: 'warning',
      confirmButtonText: '清除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    await adminApi.setPlatformModelPricing(name, null)
    ElMessage.success('已清除')
    await reload()
  } catch (err) {
    actionError.value = err instanceof AdminApiError ? err.message : '操作失败'
  }
}

onMounted(reload)

// 测试经 w.vm 直调（同 AdminModelsPage 先例）：script setup 顶层绑定默认不暴露。
defineExpose({ openEditor, submitPricing, clearPricing, pricingForm, actionError })
</script>

<template>
  <section class="p-2">
    <header class="mb-3 flex items-center gap-3">
      <h1 class="text-base font-semibold text-fg">平台渠道定价</h1>
      <span class="text-sm text-fg-3">{{ channelName }}</span>
      <span class="text-sm text-fg-2">{{ configuredCount }}/{{ models.length }} 已配定价</span>
      <el-button :loading="loading" @click="reload">刷新</el-button>
    </header>
    <p v-if="parseError" class="mb-2 rounded border border-warning-border bg-warning-bg p-2 text-sm text-warning">
      平台渠道 models JSON 畸形（服务端拒绝写入）——请先检查渠道行
    </p>
    <p v-if="actionError" class="mb-2 rounded border border-danger-border bg-danger-bg p-2 text-sm text-danger">{{ actionError }}</p>
    <el-table :data="models" v-loading="loading" size="small" border>
      <el-table-column prop="name" label="模型" min-width="180" />
      <el-table-column prop="capability" label="能力" width="90" />
      <el-table-column label="定价（USD/百万 token）" min-width="240">
        <template #default="{ row }">
          <span v-if="row.pricing == null" class="rounded border border-warning-border bg-warning-bg px-1 text-warning">未配定价</span>
          <span v-else class="text-fg">{{ pricingText(row) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="150" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" :disabled="parseError" @click="openEditor(row.name)">编辑</el-button>
          <el-button link type="danger" :disabled="parseError || row.pricing == null" @click="clearPricing(row.name)">清除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="editorVisible" :title="`定价 · ${editingName}`" width="480px">
      <el-form label-width="140px">
        <el-form-item v-for="k in PRICING_KEYS" :key="k" :label="k">
          <el-input v-model="pricingForm[k]" placeholder="留空 = 不计费该维度" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editorVisible = false">取消</el-button>
        <el-button type="primary" @click="submitPricing">保存</el-button>
      </template>
    </el-dialog>
  </section>
</template>
