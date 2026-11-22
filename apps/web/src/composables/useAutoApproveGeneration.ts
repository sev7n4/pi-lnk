import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { providerApi } from '@/services/provider-api'
import { useProviderBootstrap } from './useProviderBootstrap'

/**
 * 模块级镜像：最近一次**服务端确认**的授权态。
 * bootstrap 未加载时用它呈现（写成功后立即生效，不等下一次 bootstrap）。
 * 服务端偏好一旦可用，一律以服务端为准（bootstrap 优先）。
 */
const lastConfirmedAuthorized = ref(false)

/**
 * 授权自动生成（规格 `docs/superpowers/specs/2026-11-22-generation-auto-approve-gate-design.md`
 * §3.2 / §4）。
 *
 * **账号级偏好，服务端 SSOT**：`manual` = 未授权（每次确认）；`auto` = 已授权。
 * 判定权在服务端（客户端不可传入 tier）——本 composable 只负责**读写偏好与呈现**，
 * 不做任何本地判定，也不缓存 localStorage（localStorage 只能做 UI 记忆，不能当裁决源）。
 *
 * 作用域 = 图片 / 音频卡片（`video` 不对用户级开放，成本放大归系统决策）。
 * 文案必须说清作用域，否则用户会误以为「所有写操作都免确认」。
 */
export function useAutoApproveGeneration() {
  const { preferences, patchPreferences } = useProviderBootstrap()

  /** 是否已授权（服务端返回的账号级偏好；未加载时回落到最近一次服务端确认结果）。 */
  const authorized = computed(() => {
    const pref = preferences.value?.autoApproveGenerations
    if (pref) return pref === 'auto'
    return lastConfirmedAuthorized.value
  })

  /**
   * 授权 / 收回授权。
   *
   * @param next true = 授权；false = 收回授权
   * @param opts.successMessage 自定义成功文案（场景内快捷项要说明「下次生效」）；
   * @param opts.silent         不弹 toast（由调用方自行呈现）
   */
  async function setAuthorized(
    next: boolean,
    opts?: { successMessage?: string; silent?: boolean },
  ): Promise<boolean> {
    const value = next ? 'auto' : 'manual'
    try {
      // 部分字段 PUT：服务端 updatePreferences 按字段判定，缺省字段不动。
      const prefs = await providerApi.updatePreferences({ autoApproveGenerations: value })
      lastConfirmedAuthorized.value = next
      patchPreferences(prefs)
      if (!opts?.silent) {
        ElMessage.success(
          opts?.successMessage ??
            (next ? '已授权自动生成' : '已收回授权 · 恢复每次确认'),
        )
      }
      return true
    } catch (err) {
      if (!opts?.silent) {
        ElMessage.error(err instanceof Error ? err.message : '设置失败')
      }
      return false
    }
  }

  return { authorized, setAuthorized }
}

/** 测试隔离：清掉模块级镜像（对齐 usePreferences.__resetForTest 范式）。 */
export function __resetAutoApproveForTest(): void {
  lastConfirmedAuthorized.value = false
}
