import { ref } from 'vue'
import type { Ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useProjectWorkspace } from './useProjectWorkspace'

/**
 * 进入创作（spec §3.1）：一次用户手势 = 回到创作现场，不产生数据
 * （唯一例外：零项目时建 1 个默认项目，且仅限**点锚手势**路径）。
 *
 * ⭐ 本 composable 是 web 与移动端**唯一**的进入逻辑（INV-5），不得存在第二份。
 *    收敛前移动端靠「进 /workflow 自动路由」、PC 靠「UI 动作触发创建」，
 *    两套实现各改各的 ⇒ 语义漂移 + 项目堆积的直接成因。
 *
 * ⚠️ 与 `useEnterCreation` 相关的两个"天然保证"，不要用代码重复实现：
 *    - **D-1（登录后必走点锚仪式）**：`auth.openLogin()` 弹的是模态、不换页，
 *      登录成功只做 `applySession()`（置 token/user + 关弹窗）⇒ 用户必然停在
 *      品牌页自己再点一次锚。**不需要任何 `justLoggedIn` 类标记**（该机制已删除）。
 *    - **落点形态按壳分（D5=B）**：本函数只负责"进哪个项目"，
 *      "要不要自动进"由调用方决定 —— PC 不调（品牌页常驻），
 *      移动端在一次性分发 watch 里调。
 */
export function useEnterCreation() {
  const router = useRouter()
  const auth = useAuthStore()
  const ws = useProjectWorkspace()

  const entering = ref(false) // INV-8：防连点，进入中再次调用直接 return
  const error = ref<string | null>(null) // INV-6：list/create 失败文案

  /**
   * @param opts.allowImplicitCreate 零项目时是否隐式创建 1 个默认项目。
   *   - `true`（默认）：**点锚手势路径** —— 用户已明确表达创作意图，
   *     此刻创建是「把意图落地」（D-3）。
   *   - `false`：**自动进入路径**（移动端一次性分发）—— 没有用户手势，
   *     创建就是「入口副作用」⇒ 留品牌页，不创建（IA v4，10-23 撤销了静默新建）。
   *   ⚠️ 这个参数是 spec §3.2「隐式创建只发生在手势之后」的唯一实现载体，
   *     删了它就会退回 IA v3.1 的静默新建。
   * @param opts.replace 用 `router.replace` 而非 `router.push`。
   *   - `true`：**自动分发**专用 —— 这是系统替用户做的跳转，不该在浏览器历史里
   *     留一条「返回即回品牌页」的记录（2026-10-24 性能修复的结论；
   *     `push` 会让用户按返回键又弹回品牌页）。
   *   - `false`（默认）：**用户手势**（点锚 / 点新建卡）—— 用户主动发起，
   *     理应能返回。
   */
  async function enterCreation(opts?: {
    allowImplicitCreate?: boolean
    replace?: boolean
  }): Promise<void> {
    // INV-8 必须放最前：list 超时 15s，没有这个标志连点会并发 router.push
    if (entering.value) return
    if (!auth.isLoggedIn) {
      // 只弹登录，不标记、不自动进项目（D-1 由模态登录天然保证）
      auth.openLogin()
      return
    }
    const navigate = opts?.replace ? router.replace.bind(router) : router.push.bind(router)
    entering.value = true
    error.value = null
    try {
      const projects = await ws.list()
      // ⛔ 必须先判 error 再判空：list 失败时 projects 也是空数组，
      //    先判空会把「加载失败」误判成「零项目」⇒ 触发创建 ⇒ 违反 INV-6。
      if (ws.error.value) {
        // ⭐ 2026-10-26 生产事故修复：**list 失败时用「记忆的项目」兜底**。
        //
        // 事故形态：品牌页点锚 →「正在进入画布…」→ 15 秒 →「项目加载失败 · 重试」，
        //   重试依旧失败。DevTools：4 条 `GET /api/agent/canvas/list` 全部 15s
        //   超时被取消、**已传输 0 B**；同窗口 nginx access.log 里**一条都没有**
        //   ⇒ 请求根本没离开浏览器（排在浏览器的连接队列里）。
        // 根因：会话级常驻订阅占满同源 HTTP/1.1 的 6 个连接 ⇒ 普通请求排队饿死。
        //
        // ✅「记忆的项目」来自 localStorage（按 userId 分区）⇒ **不需要任何请求**
        //   ⇒ list 拿不到时仍能进画布，而不是把用户堵在错误态。
        //
        // ⚠️ 两条既有契约**不动**：
        //   ① 「优先进最近有产物的项目」依赖 list 数据 ⇒ 正常路径仍先 list 再择优；
        //   ② 移动端**自动分发**路径（allowImplicitCreate=false）list 失败时不跳转
        //      且必须有可见反馈 ⇒ 兜底**只对手势路径**生效。
        const remembered = opts?.allowImplicitCreate === false ? null : ws.resolveLastProjectId()
        if (remembered) {
          await navigate({ path: `/workflow/${remembered}`, query: { openAgent: '1' } })
          return
        }
        error.value = '项目加载失败'
        return
      }
      if (!projects.length) {
        if (opts?.allowImplicitCreate === false) return // 穿透路径 ⇒ 留品牌页
        try {
          const created = await ws.create()
          await navigate({ path: `/workflow/${created.id}`, query: { openAgent: '1' } })
        } catch {
          // 不跳转、不进 demo-（spec §3.6）：失败要让用户看见并能重试
          error.value = '创建画布失败，请检查网络后重试'
        }
        return
      }
      const target = ws.resolveTarget() ?? projects[0]!
      ws.rememberProject(target.id)
      // ⚠️ openAgent=1 两条路径都带（INV-9）：其真实作用是
      //    `agentRailRef.openPanel()`（PC 左栏 agent 面板）。不带 ⇒ 老项目不进
      //    对话态，D-3「默认切到对话页」在 PC 上假绿。
      await navigate({ path: `/workflow/${target.id}`, query: { openAgent: '1' } })
    } finally {
      entering.value = false
    }
  }

  return { enterCreation, entering, error }
}

export type UseEnterCreation = ReturnType<typeof useEnterCreation>
export type EnterCreationState = {
  entering: Ref<boolean>
  error: Ref<string | null>
}
