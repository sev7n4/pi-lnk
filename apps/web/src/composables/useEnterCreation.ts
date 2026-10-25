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
   */
  async function enterCreation(opts?: { allowImplicitCreate?: boolean }): Promise<void> {
    // INV-8 必须放最前：list 超时 15s，没有这个标志连点会并发 router.push
    if (entering.value) return
    if (!auth.isLoggedIn) {
      // 只弹登录，不标记、不自动进项目（D-1 由模态登录天然保证）
      auth.openLogin()
      return
    }
    entering.value = true
    error.value = null
    try {
      const projects = await ws.list()
      // ⛔ 必须先判 error 再判空：list 失败时 projects 也是空数组，
      //    先判空会把「加载失败」误判成「零项目」⇒ 触发创建 ⇒ 违反 INV-6。
      if (ws.error.value) {
        error.value = '项目加载失败'
        return
      }
      if (!projects.length) {
        if (opts?.allowImplicitCreate === false) return // 穿透路径 ⇒ 留品牌页
        try {
          const created = await ws.create()
          await router.push({ path: `/workflow/${created.id}`, query: { openAgent: '1' } })
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
      await router.push({ path: `/workflow/${target.id}`, query: { openAgent: '1' } })
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
