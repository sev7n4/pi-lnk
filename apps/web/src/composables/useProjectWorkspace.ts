import { ref } from 'vue'
import type { Ref } from 'vue'
import { canvasApi } from '@/services/canvas-api'
import { sessionsApi } from '@/services/sessions-api'
import { useAuthStore } from '@/stores/auth'

/**
 * 项目（画布）生命周期 + 最近项目记忆。
 *
 * ⭐ 本 composable 是**项目 CRUD 的单一真源**，也是全仓**唯一 create 通道**：
 *    收敛前，create 分散在 5 处且两条 service 混用（`canvasApi.create` 与
 *    `sessionsApi.create` 并存），标题还会一边传死「未命名画布」、一边不传 ⇒
 *    两端语义漂移 + 项目列表堆积的直接成因。落地后只允许本文件内出现一次 create。
 *
 * ⚠️ 通道边界（2026-10-25 开工前核实，**不是疏漏**）：
 *    - list / create / update 走 `canvasApi`（`/agent/canvas/*`）
 *    - **remove 走 `sessionsApi.remove`** —— `canvas.controller.ts` 只有
 *      list/create/update/material 四个端点，**没有删除端点**；删除只存在于
 *      `sessions.controller.ts` 的 `@Delete(':id')`。⇒ 这不是分裂，是后端现状。
 *
 * ⚠️ 与 `useMySessions`（/canvases 管理态）**有意并存**：它走 `GET /sessions`
 *    全量列表，本模块走瘦身的 `/agent/canvas/list`。管理页要全量可管，入口要
 *    轻量可览；强行统一会把 /canvases 拖进回归面。
 */

/**
 * 项目卡片。
 *
 * ⚠️ 类型来源：`AgentSideRail.vue` 原有一个只含 id/title/updatedAt 的本地
 *    `ProjectCard`，作品带用的是内联的含 coverUrl/coverNodeId 的匿名类型。
 *    本接口是两者的**并集**；收敛时那两处本地定义改为 import 本类型
 *    （消灭第三份定义）。
 */
export interface ProjectCard {
  id: string
  title: string
  updatedAt: string
  coverUrl: string | null
  coverNodeId: string | null
}

/**
 * 列表超时（毫秒）。
 *
 * ⚠️ 与 AgentSideRail 的 `PROJECT_LIST_TIMEOUT_MS` 同值同义，**不新造数字**：
 * 2026-10-19 事故的形态是「弱网/代理路径下 body 永不落地 ⇒ axios promise
 * 不 settle ⇒『项目加载中』转不完」。删这个兜底 = 事故回归。
 */
export const PROJECT_LIST_TIMEOUT_MS = 15_000

/** 最近项目记忆键：按 userId 分区 ⇒ 换号天然隔离，登出不主动清理。 */
function storageKey(userId: string): string {
  return `lnkpi:lastProjectId:${userId}`
}

export function useProjectWorkspace() {
  const projects = ref<ProjectCard[]>([])
  const loading = ref(false)
  const error = ref(false)

  const lastProjectId = ref<string | null>(null)

  /**
   * 拉取项目列表。**这是全仓唯一的 `canvasApi.list` 调用点**（INV-10）——
   * 收敛前 `loadProjects()` 与 `loadRecentWorks()` 各拉一遍同一个接口、
   * 存进两个 ref，纯浪费（254 项目时尤其明显）。
   */
  async function list(opts?: { timeoutMs?: number }): Promise<ProjectCard[]> {
    loading.value = true
    error.value = false
    try {
      const res = await canvasApi.list({ timeout: opts?.timeoutMs ?? PROJECT_LIST_TIMEOUT_MS })
      projects.value = (res.data?.data ?? []) as ProjectCard[]
      return projects.value
    } catch {
      // INV-6：失败不创建、不跳转；是否重试交给调用方（抽屉显式报错，
      // 作品带静默降级——两种容错策略见 spec §3.6）
      error.value = true
      projects.value = []
      return []
    } finally {
      loading.value = false
    }
  }

  /**
   * 新建项目（**唯一 create 通道**）。
   *
   * ⛔ 不传 title：标题由后端默认值决定（IA v4 = 「未命名项目」）。
   *    前端传死「未命名画布」是 IA v4 之前的旧行为，且会让后端 list 的
   *    「未命名 → 项目 N」编号兜底对新建项失效（`canvas.service.ts:37-43`）。
   *
   * @param opts.timeoutMs 客户端超时（毫秒）。**调用方应显式带上**：axios 默认
   *    120s，弱网下会让用户「上百秒零反馈」（10-24 修复要求明确报错 + 20s 超时）。
   *    收敛通道时最容易丢的就是这个超时 ⇒ 做成参数而不是藏在调用点。
   */
  async function create(opts?: { timeoutMs?: number }): Promise<ProjectCard> {
    // ⛔ 默认路径**零参数**调 canvasApi.create：契约「不传 title」= title 不进请求体
    //    （IA v4 标题由后端默认值决定）。下游守卫锁的就是这个零参调用 ⇒ 不要为了
    //    塞 config 而把 title 位显式写成 undefined（那会让调用变成「两个参数」）。
    const res = opts?.timeoutMs
      ? await canvasApi.create(undefined, { timeout: opts.timeoutMs })
      : await canvasApi.create()
    const created = res.data?.data as ProjectCard | undefined
    if (!created?.id) throw new Error('create project failed: no id in response')
    rememberProject(created.id)
    return created
  }

  async function rename(id: string, title: string): Promise<void> {
    await canvasApi.update(id, { title })
    const hit = projects.value.find((p) => p.id === id)
    if (hit) hit.title = title
  }

  /** 删除走 `sessionsApi.remove` —— canvas 侧无删除端点（见文件头通道边界）。 */
  async function remove(id: string): Promise<void> {
    await sessionsApi.remove(id)
    projects.value = projects.value.filter((p) => p.id !== id)
  }

  function rememberProject(id: string): void {
    const uid = useAuthStore().user?.id
    if (!uid) return
    lastProjectId.value = id
    localStorage.setItem(storageKey(uid), id)
  }

  /**
   * 读取最近项目记忆（**纯读取，不校验是否仍在列表中**）。
   *
   * ⚠️ 2026-10-25 Task 1 设计修正（TDD 暴露）：初版在这里做「仍在 projects 中」
   *    的校验，于是 `create()` 刚建完（还没刷新 list）时读不回自己刚建的项目，
   *    换号后再读也因新实例的 projects 为空而失真。
   *    ⇒ 校验必须放在 `resolveTarget()`：只有它手里有 list 数据。
   *       这里只负责「按 userId 分区读出来」这一件事。
   */
  function resolveLastProjectId(): string | null {
    const uid = useAuthStore().user?.id
    if (!uid) return null
    return localStorage.getItem(storageKey(uid))
  }

  /**
   * 解析目标项目（spec §3.0.2 环节 3）：
   *   ① 记忆有效（本机、按 userId 分区、**且仍在 list 中**）
   *   ② 最近**有产物**的（coverUrl 非空）—— 最近更新的可能是个刚建的空项目，
   *      穿透进去用户看不到任何产物
   *   ③ list[0]（updatedAt desc）
   *   ④ list 为空 ⇒ null（调用方据此走「零项目」分支）
   */
  function resolveTarget(): ProjectCard | null {
    if (!projects.value.length) return null
    const remembered = resolveLastProjectId()
    if (remembered) {
      const hit = projects.value.find((p) => p.id === remembered)
      if (hit) return hit
    }
    return projects.value.find((p) => p.coverUrl) ?? projects.value[0]!
  }

  return {
    projects,
    loading,
    error,
    lastProjectId,
    list,
    create,
    rename,
    remove,
    rememberProject,
    resolveLastProjectId,
    resolveTarget,
  }
}

export type UseProjectWorkspace = ReturnType<typeof useProjectWorkspace>
export type ProjectWorkspaceRefs = {
  projects: Ref<ProjectCard[]>
  loading: Ref<boolean>
  error: Ref<boolean>
  lastProjectId: Ref<string | null>
}
