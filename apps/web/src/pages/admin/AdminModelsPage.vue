<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  adminApi,
  AdminApiError,
  type AdminCatalogEntry,
  type AdminCatalogLinkOps,
  type CatalogEntryInput,
} from '@/services/admin-api'
import { linkStatusOf, LINK_LEVEL_TEXT_CLASS } from './modelLinkStatus'

const loading = ref(false)
const version = ref(0)
const entries = ref<AdminCatalogEntry[]>([])
/** modelKey → 链路原料（服务端 fail-soft 时为 null → 灯色全灰「未知」）。 */
const opsByModel = ref<Record<string, AdminCatalogLinkOps> | null>(null)
const keyword = ref('')
const actionError = ref('')

const VALID_MODALITIES = ['text', 'image', 'video', 'audio']
const VALID_BINDINGS = ['gateway-openai-compat', 'fal-http', 'minimax-http', 'zhipu-http']

const filtered = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  if (!k) return entries.value
  return entries.value.filter(
    (e) => e.modelKey.toLowerCase().includes(k) || e.displayName.toLowerCase().includes(k),
  )
})

/** 单行链路状态（灯色 + 文案 + tooltip）；供模板与测试使用。 */
function linkOf(row: AdminCatalogEntry) {
  return linkStatusOf(opsByModel.value?.[row.modelKey] ?? null, row.deletedAt !== null)
}
defineExpose({ removeEntry, actionError, startCreate, startEdit, submitForm, linkOf })

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

onMounted(reload)

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

// defineExpose 见上方 linkOf 处（一并暴露 removeEntry/actionError/startCreate/startEdit/submitForm）
</script>

<template>
  <section class="p-2">
    <header class="mb-3 flex items-center gap-3">
      <h1 class="text-base font-semibold text-fg">模型目录</h1>
      <span class="text-sm text-fg-3">catalogVersion {{ version }}</span>
      <el-input v-model="keyword" placeholder="搜索 modelKey / 名称" class="w-56" clearable />
      <el-button type="primary" @click="startCreate">新增条目</el-button>
      <el-button :loading="loading" @click="reload">刷新</el-button>
    </header>
    <p v-if="actionError" class="mb-2 rounded border border-danger-border bg-danger-bg p-2 text-sm text-danger">{{ actionError }}</p>
    <el-table :data="filtered" v-loading="loading" size="small" border>
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
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <span v-if="row.deletedAt" class="text-warning">已下架</span>
          <span v-else class="text-success">在架</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="150" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="startEdit(row)">编辑</el-button>
          <el-button link type="danger" :disabled="row.deletedAt !== null" @click="removeEntry(row.id, row.modelKey)">下架</el-button>
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
