<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  adminApi,
  AdminApiError,
  type AdminCatalogEntry,
  type AdminCatalogLinkOps,
  type CatalogEntryInput,
} from '@/services/admin-api'
import { linkStatusOf, LINK_LEVEL_TEXT_CLASS } from './modelLinkStatus'

const route = useRoute()
const router = useRouter()

const loading = ref(false)
const version = ref(0)
const entries = ref<AdminCatalogEntry[]>([])
/** modelKey → 链路原料（服务端 fail-soft 时为 null → 灯色全灰「未知」）。 */
const opsByModel = ref<Record<string, AdminCatalogLinkOps> | null>(null)
const keyword = ref('')
const actionError = ref('')

const VALID_MODALITIES = ['text', 'image', 'video', 'audio']
const VALID_BINDINGS = ['gateway-openai-compat', 'fal-http', 'minimax-http', 'zhipu-http']
const LINK_LEVELS = ['red', 'yellow', 'green', 'gray'] as const

// —— 分类筛选（2026-10-12 运营增强；筛选态同步 URL query，可分享/收藏）——
const modalityFilter = ref('')
const linkFilter = ref<(typeof LINK_LEVELS)[number] | ''>('')
const upstreamFilter = ref('')
const lifecycleFilter = ref<'' | 'active' | 'off'>('') // '' = 全部

const upstreamOptions = computed(() => {
  const set = new Set<string>()
  for (const ops of Object.values(opsByModel.value ?? {})) {
    if (ops.upstream) set.add(ops.upstream)
  }
  return [...set].sort()
})

/** 单行链路状态（灯色 + 文案 + tooltip）；供模板与测试使用。 */
function linkOf(row: AdminCatalogEntry) {
  return linkStatusOf(opsByModel.value?.[row.modelKey] ?? null, row.deletedAt !== null)
}

const filtered = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  return entries.value.filter((e) => {
    if (k && !e.modelKey.toLowerCase().includes(k) && !e.displayName.toLowerCase().includes(k) && !e.gatewayModelId.toLowerCase().includes(k)) return false
    if (modalityFilter.value && e.modality !== modalityFilter.value) return false
    if (lifecycleFilter.value === 'active' && e.deletedAt !== null) return false
    if (lifecycleFilter.value === 'off' && e.deletedAt === null) return false
    if (upstreamFilter.value && (opsByModel.value?.[e.modelKey]?.upstream ?? '') !== upstreamFilter.value) return false
    if (linkFilter.value && linkOf(e).level !== linkFilter.value) return false
    return true
  })
})

function syncQuery() {
  const q: Record<string, string> = {}
  if (keyword.value.trim()) q.kw = keyword.value.trim()
  if (modalityFilter.value) q.modality = modalityFilter.value
  if (linkFilter.value) q.link = linkFilter.value
  if (upstreamFilter.value) q.upstream = upstreamFilter.value
  if (lifecycleFilter.value) q.lifecycle = lifecycleFilter.value
  router.replace({ query: q }).catch(() => {})
}
watch([keyword, modalityFilter, linkFilter, upstreamFilter, lifecycleFilter], syncQuery)

async function reload() {
  loading.value = true
  try {
    const data = await adminApi.listCatalog()
    version.value = data.version
    entries.value = data.entries
    opsByModel.value = data.ops ?? null
  } catch (err) {
    actionError.value = err instanceof AdminApiError ? err.message : '加载失败'
  } finally {
    loading.value = false
  }
}

/** 下架（软删）；复用于行内开关 off 与批量下架。409/400 防呆原样透出。 */
async function removeEntry(id: string, modelKey: string) {
  actionError.value = ''
  try {
    await ElMessageBox.confirm(`确认下架 ${modelKey}？（软删，可由 POST 同 modelKey 恢复）`, '下架确认', {
      type: 'warning',
      confirmButtonText: '下架',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    await adminApi.deleteCatalogEntry(id)
    ElMessage.success('已下架')
    await reload()
  } catch (err) {
    // 400/409 防呆（默认模型等）原样透出，引导运营先处理
    actionError.value = err instanceof AdminApiError ? err.message : '操作失败'
  }
}

/** 恢复上架：软删行开关拨回 on → 确认后按既有配置走 POST（服务端同 key 恢复语义）。 */
async function restoreEntry(row: AdminCatalogEntry) {
  actionError.value = ''
  try {
    await ElMessageBox.confirm(`恢复上架 ${row.modelKey}？（按既有配置恢复，可再编辑）`, '上架确认', {
      type: 'info',
      confirmButtonText: '上架',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    await adminApi.createCatalogEntry({
      modelKey: row.modelKey,
      displayName: row.displayName,
      gatewayModelId: row.gatewayModelId,
      modality: row.modality,
      providerBinding: row.providerBinding,
      params: row.params ?? {},
      defaults: row.defaults,
      audioKind: row.audioKind,
    })
    ElMessage.success('已恢复上架')
    await reload()
  } catch (err) {
    actionError.value = err instanceof AdminApiError ? err.message : '操作失败'
  }
}

/** 在售开关：off→on 走恢复上架，on→off 走下架确认。开关 :model-value 受控，失败不翻转。 */
async function toggleSale(row: AdminCatalogEntry) {
  if (row.deletedAt !== null) {
    await restoreEntry(row)
  } else {
    await removeEntry(row.id, row.modelKey)
  }
}

// —— 批量下架（红灯筛选后多选 → 一键处置）——
const selected = ref<AdminCatalogEntry[]>([])
const activeSelectedCount = computed(() => selected.value.filter((r) => r.deletedAt === null).length)

function onSelectionChange(rows: AdminCatalogEntry[]) {
  selected.value = rows
}

async function batchOffboard() {
  const targets = selected.value.filter((r) => r.deletedAt === null)
  if (targets.length === 0) {
    ElMessage.info('未选中在售条目')
    return
  }
  try {
    await ElMessageBox.confirm(`确认批量下架 ${targets.length} 个模型？（软删，可恢复）`, '批量下架', {
      type: 'warning',
      confirmButtonText: '批量下架',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  actionError.value = ''
  const failed: string[] = []
  for (const t of targets) {
    try {
      await adminApi.deleteCatalogEntry(t.id)
    } catch (err) {
      failed.push(`${t.modelKey}：${err instanceof AdminApiError ? err.message : '操作失败'}`)
    }
  }
  if (failed.length > 0) actionError.value = `部分下架失败（其余已生效）：${failed.join('；')}`
  else ElMessage.success(`已下架 ${targets.length} 个`)
  selected.value = []
  await reload()
}

onMounted(async () => {
  // missing「去上架」预填：/admin/models?prefill=<modelKey> → 打开新增弹窗并预填三标识
  const prefill = typeof route.query.prefill === 'string' ? route.query.prefill.trim() : ''
  if (prefill) {
    startCreate()
    form.value.modelKey = prefill
    form.value.displayName = prefill
    form.value.gatewayModelId = prefill
  }
  const q = route.query
  if (typeof q.kw === 'string') keyword.value = q.kw
  if (typeof q.modality === 'string' && VALID_MODALITIES.includes(q.modality)) modalityFilter.value = q.modality
  if (typeof q.link === 'string' && (LINK_LEVELS as readonly string[]).includes(q.link)) linkFilter.value = q.link as (typeof LINK_LEVELS)[number]
  if (typeof q.upstream === 'string') upstreamFilter.value = q.upstream
  if (q.lifecycle === 'active' || q.lifecycle === 'off') lifecycleFilter.value = q.lifecycle
  await reload()
})

// 供模板与测试使用的最小编辑态（V1：新增/编辑弹窗共用）
const dialogVisible = ref(false)
const editing = ref<AdminCatalogEntry | null>(null)
const form = ref<CatalogEntryInput>({})
// paramsJson 与 form.params 的桥接：表单里编辑 JSON 文本，提交时解析回对象
const paramsJson = ref('{}')

function startCreate() {
  editing.value = null
  form.value = { modelKey: '', displayName: '', gatewayModelId: '', modality: 'text', providerBinding: 'gateway-openai-compat', params: {} }
  paramsJson.value = JSON.stringify(form.value.params)
  dialogVisible.value = true
}

function startEdit(row: AdminCatalogEntry) {
  editing.value = row
  form.value = {
    displayName: row.displayName,
    gatewayModelId: row.gatewayModelId,
    modality: row.modality,
    providerBinding: row.providerBinding,
    params: row.params,
    defaults: row.defaults,
    audioKind: row.audioKind,
  }
  paramsJson.value = JSON.stringify(row.params ?? {})
  dialogVisible.value = true
}

async function submitForm() {
  actionError.value = ''
  let parsedParams: Record<string, unknown>
  try {
    parsedParams = JSON.parse(paramsJson.value) as Record<string, unknown>
  } catch {
    actionError.value = 'params 不是合法 JSON'
    return
  }
  form.value.params = parsedParams
  try {
    if (editing.value) {
      await adminApi.updateCatalogEntry(editing.value.id, form.value)
      ElMessage.success('已保存')
    } else {
      await adminApi.createCatalogEntry(form.value)
      ElMessage.success('已新增（软删同 key 视为恢复上架）')
    }
    dialogVisible.value = false
    await reload()
  } catch (err) {
    actionError.value = err instanceof AdminApiError ? err.message : '保存失败'
  }
}

// 测试经 w.vm 数据驱动（script setup 顶层绑定默认不暴露）：ref 赋值即写 .value。
defineExpose({
  removeEntry,
  actionError,
  startCreate,
  startEdit,
  submitForm,
  linkOf,
  toggleSale,
  restoreEntry,
  batchOffboard,
  onSelectionChange,
  filtered,
  modalityFilter,
  linkFilter,
  upstreamFilter,
  lifecycleFilter,
  selected,
  activeSelectedCount,
  dialogVisible,
  form,
})
</script>

<template>
  <section class="p-2">
    <header class="mb-3 flex flex-wrap items-center gap-3">
      <h1 class="text-base font-semibold text-fg">模型目录</h1>
      <span class="text-sm text-fg-3">catalogVersion {{ version }}</span>
      <el-input v-model="keyword" placeholder="搜索 modelKey / 名称 / 网关 ID" class="w-56" clearable />
      <el-select v-model="lifecycleFilter" class="w-28" clearable placeholder="生命周期">
        <el-option label="在售" value="active" />
        <el-option label="已下架" value="off" />
      </el-select>
      <el-select v-model="modalityFilter" class="w-28" clearable placeholder="模态">
        <el-option v-for="m in VALID_MODALITIES" :key="m" :value="m" :label="m" />
      </el-select>
      <el-select v-model="upstreamFilter" class="w-36" clearable placeholder="归属上游">
        <el-option v-for="u in upstreamOptions" :key="u" :value="u" :label="u" />
      </el-select>
      <el-select v-model="linkFilter" class="w-28" clearable placeholder="链路状态">
        <el-option label="不可用（红）" value="red" />
        <el-option label="欠费（黄）" value="yellow" />
        <el-option label="正常（绿）" value="green" />
        <el-option label="未知（灰）" value="gray" />
      </el-select>
      <el-button type="danger" plain :disabled="activeSelectedCount === 0" @click="batchOffboard">
        批量下架{{ activeSelectedCount > 0 ? `（${activeSelectedCount}）` : '' }}
      </el-button>
      <el-button type="primary" @click="startCreate">新增条目</el-button>
      <el-button :loading="loading" @click="reload">刷新</el-button>
    </header>
    <p v-if="actionError" class="mb-2 rounded border border-danger-border bg-danger-bg p-2 text-sm text-danger">{{ actionError }}</p>
    <el-table :data="filtered" v-loading="loading" size="small" border @selection-change="onSelectionChange">
      <el-table-column type="selection" width="42" />
      <el-table-column prop="modelKey" label="modelKey" min-width="180" />
      <el-table-column prop="displayName" label="名称" min-width="140" />
      <el-table-column prop="modality" label="模态" width="80" />
      <el-table-column prop="providerBinding" label="绑定" min-width="160" />
      <el-table-column label="上游端点" min-width="200">
        <template #default="{ row }">
          <template v-if="row.deletedAt">
            <span class="text-fg-3">—</span>
          </template>
          <template v-else-if="opsByModel && opsByModel[row.modelKey]">
            <div class="font-mono text-xs text-fg">{{ opsByModel[row.modelKey]!.baseUrl ?? '端点未知' }}</div>
            <div class="text-xs text-fg-3">上游 {{ opsByModel[row.modelKey]!.upstream ?? '未路由' }}</div>
          </template>
          <span v-else class="text-fg-3">—</span>
        </template>
      </el-table-column>
      <el-table-column label="链路状态" width="110">
        <template #default="{ row }">
          <el-tooltip :content="linkOf(row).tooltip" placement="top">
            <span :class="LINK_LEVEL_TEXT_CLASS[linkOf(row).level]" class="cursor-help text-sm">● {{ linkOf(row).label }}</span>
          </el-tooltip>
        </template>
      </el-table-column>
      <el-table-column label="在售" width="80">
        <template #default="{ row }">
          <el-tooltip :content="row.deletedAt ? '已下架，拨回恢复上架' : '在售，拨回下架（软删）'" placement="top">
            <el-switch :model-value="row.deletedAt === null" @change="toggleSale(row)" />
          </el-tooltip>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="90" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="startEdit(row)">编辑</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialogVisible" :title="editing ? `编辑 ${editing.modelKey}` : '新增条目'" width="560px">
      <el-form label-width="120px">
        <el-form-item v-if="!editing" label="modelKey">
          <el-input v-model="form.modelKey" placeholder="稳定标识，创建后不可改" />
        </el-form-item>
        <el-form-item label="displayName"><el-input v-model="form.displayName" /></el-form-item>
        <el-form-item label="gatewayModelId"><el-input v-model="form.gatewayModelId" /></el-form-item>
        <el-form-item label="modality">
          <el-select v-model="form.modality">
            <el-option v-for="m in VALID_MODALITIES" :key="m" :value="m" :label="m" />
          </el-select>
        </el-form-item>
        <el-form-item label="providerBinding">
          <el-select v-model="form.providerBinding">
            <el-option v-for="b in VALID_BINDINGS" :key="b" :value="b" :label="b" />
          </el-select>
        </el-form-item>
        <el-form-item label="params (JSON)">
          <el-input v-model="paramsJson" type="textarea" :rows="3" placeholder='{"model":"native"}' />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitForm">保存</el-button>
      </template>
    </el-dialog>
  </section>
</template>
