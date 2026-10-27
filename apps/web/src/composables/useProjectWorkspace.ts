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
 * ⭐ 2026-10-26 规格收敛 v2（D1/R2）：本模块成为**全站唯一列表源**（INV-10）。
 *    原「与 /canvases 管理态有意并存」的双源已删（管理动作通道见
 *    `useProjectManager` 文件头）；create 仍为本仓唯一 create 通道。
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
 *
 * ⚠️ 但它**不能**被当成「服务端慢」的解释：2026-10-25 生产实测，最重的账号
 *    （266 个项目）端点总耗时仅 **56ms**（容器内直测 DB+解析）。真正的失败形态是
 *    **请求根本没发出去**——画布页的 SSE/轮询把同域 HTTP/1.1 的 6 个连接占满
 *    （见 App.vue 注释：排队可达 55 秒），列表请求在浏览器队列里排着，
 *    15s 超时先到 ⇒ 假阳性失败（nginx 日志里连这条请求都没有）。
 */
export const PROJECT_LIST_TIMEOUT_MS = 15_000

/**
 * 列表「新鲜期」（毫秒）：这段时间内再要列表直接用内存里的，不发请求。
 *
 * ⭐ 为什么需要：打开项目抽屉若总是重新拉一次，就会在**连接已被 SSE 占满**的
 * 画布页上排一次队（然后 15s 超时）。而抽屉要的数据**刚刚已经拿到过**。
 */
export const PROJECT_LIST_FRESH_MS = 30_000

/** 最近项目记忆键：按 userId 分区 ⇒ 换号天然隔离，登出不主动清理。 */
function storageKey(userId: string): string {
  return `lnkpi:lastProjectId:${userId}`
}

// ⭐⭐ 模块级状态：项目列表是**全站唯一**的事实。
//
// 收敛前每个调用方各 `useProjectWorkspace()` 一次 ⇒ 各自一份 refs、各拉一次接口：
// 画布页上同时存在 ① 侧栏作品带 ② 项目抽屉 ③ PC 项目面板 ④ 进入创作解析。
// 而画布页的 SSE/轮询已把同域 6 个连接占满 ⇒ 这些**重复**的列表请求在浏览器
// 队列里排队 ⇒ 15s 超时先到 ⇒ 「项目加载失败」（2026-10-25 生产实证）。
// ⇒ 共享一份：一次请求，全站一份数据，抽屉开箱即用。
const projects = ref<ProjectCard[]>([])
const loading = ref(false)
const error = ref(false)
const lastProjectId = ref<string | null>(null)
/** 最近一次**成功**取到列表的时间戳（0 = 从未成功过） */
const loadedAt = ref(0)
/** 在途请求（single-flight）：并发调用共享同一个 promise，不重复打接口 */
let inflight: Promise<ProjectCard[]> | null = null

/**
 * 拉取项目列表。**这是全仓唯一的 `canvasApi.list` 调用点**（INV-10）。
 *
 * @param opts.timeoutMs 客户端超时（默认 15s，见 PROJECT_LIST_TIMEOUT_MS 的警告）。
 */
export function list(opts?: { timeoutMs?: number }): Promise<ProjectCard[]> {
  // single-flight：同一时刻只允许一个列表请求在途。
  // 收敛前抽屉打开与挂载两处各发一次 ⇒ 两个请求抢同一条被 SSE 占满的连接通道
  // ⇒ 先到的成功、后到的失败 ⇒ 失败方还会把已拿到的清单清空（见 catch 的注释）。
  if (inflight) return inflight
  loading.value = true
  error.value = false
  let p: Promise<ProjectCard[]>
  try {
    p = canvasApi
      .list({ timeout: opts?.timeoutMs ?? PROJECT_LIST_TIMEOUT_MS })
      .then((res) => {
        projects.value = (res.data?.data ?? []) as ProjectCard[]
        loadedAt.value = Date.now()
        return projects.value
      })
      .catch(() => {
        // ⛔ 失败**不再清空**已有清单。
        //    一次后台刷新失败不该把用户正在看的项目抹掉（2026-10-25 生产实证：
        //    抽屉里 8 个项目在「项目加载失败」出现时一起消失 ⇒ 用户既没得看也没得选）。
        //    ⚠️ `error=true` 仍是「这次没拿到」的信号：调用方**必须先判 error 再判空**
        //    （useEnterCreation 靠这个避免把「加载失败」误判成「零项目」⇒ 触发创建）。
        error.value = true
        return [] as ProjectCard[]
      })
      .finally(() => {
        loading.value = false
        inflight = null
      })
  } catch {
    // 同步抛错（极罕见）：按失败处理，不让调用方拿到未处理的异常
    error.value = true
    loading.value = false
    return Promise.resolve([] as ProjectCard[])
  }
  inflight = p
  return p
}

/**
 * 取列表，但**只在数据不新鲜时才真的发请求**（抽屉打开走这条）。
 * 目的：不要在「连接已被占满」的画布页上重复排队一次注定超时的请求。
 */
export function loadIfStale(opts?: { timeoutMs?: number }): Promise<ProjectCard[]> {
  if (
    projects.value.length > 0 &&
    loadedAt.value > 0 &&
    Date.now() - loadedAt.value < PROJECT_LIST_FRESH_MS
  ) {
    return Promise.resolve(projects.value)
  }
  return list(opts)
}

export function useProjectWorkspace() {
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
    // 新建的项目立刻进清单（否则用户新建完在抽屉里看不到自己刚建的项目）
    if (!projects.value.some((p) => p.id === created.id)) {
      projects.value = [created, ...projects.value]
    }
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
    loadedAt,
    list,
    loadIfStale,
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
  loadedAt: Ref<number>
}
