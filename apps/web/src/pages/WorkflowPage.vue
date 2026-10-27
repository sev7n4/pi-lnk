<script setup lang="ts">
// 2026-10-26 规格收敛 v2（P3 主页品牌化）：「我的项目」网格与「社区精选」整体退场
// ——列表唯一真身 = 创作首页（/canvases 行卡），社区唯一入口 = /community（发现）。
// 主页回归：纯品牌 + 一个锚点 CTA（ADR-0012 点锚仪式，本页不承载内容）。
import { computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useSessionRedirect } from '@/composables/useSessionRedirect'
import { useAgentMobileLayout } from '@/composables/useAgentMobileLayout'
import { useEnterCreation } from '@/composables/useEnterCreation'
import { useProjectWorkspace } from '@/composables/useProjectWorkspace'
import { displayCanvasTitle } from '@/utils/displayCanvasTitle'
import SignatureHero from '@/components/workflow/SignatureHero.vue'

const auth = useAuthStore()
useSessionRedirect()

/** IA v4（2026-10-23 用户裁决）：移动端入口 = hero（品牌）优先、最近项目（效率）其次。
 *  已登录回访：有项目 → 整页进最近项目（list 按 updatedAt desc）；
 *  未登录 / 登录后 / 登出重登 / 已登录但无项目：留在 hero——品牌叙事 + 锚是唯一
 *  创作入口（点按即新建项目）。IA v3.1 的「无项目静默新建」分支已撤：项目是用户
 *  意图，不是入口的副作用（静默建出来的空项目进列表还得兜底编号）。
 *  ⚠️ 一次性分发语义：本标签页会话内只跳一次——首次进 /workflow 跳最近项目后，
 *  顶栏字标/回退再进 /workflow 落在 hero（否则「回 hero」按钮会被立刻弹走）。
 *  登录态对话内完成（openLogin 是模态，不换页）⇒ 登录后用户本就在 hero 上。
 *  持久化走 sessionStorage（新开标签页重新分发、刷新不重跳）；隐私模式等写入
 *  失败时静默降级为模块级一次性（同一语义的窄化版）。 */
const MOBILE_ENTRY_KEY = 'lnk.mobileEntry.dispatched'
let mobileEntryDispatchedFallback = false

function mobileEntryDispatched(): boolean {
  try {
    return sessionStorage.getItem(MOBILE_ENTRY_KEY) === '1'
  } catch {
    // 隐私模式等读取失败：回落模块级一次性（同一语义的窄化版）
    return mobileEntryDispatchedFallback
  }
}

function markMobileEntryDispatched(): void {
  try {
    sessionStorage.setItem(MOBILE_ENTRY_KEY, '1')
  } catch {
    // 隐私模式等写入失败：仅本次页面生命周期内不重复分发，功能不坏
    mobileEntryDispatchedFallback = true
  }
}

const { isMobileLayout } = useAgentMobileLayout()

// ⚠️ 必须声明在下面的 watch **之前**：watch 带 `immediate: true`，挂载即执行；
//    若把解构放在 watch 之后会撞 TDZ（"Cannot access 'enterCreation' before initialization"）。
const { enterCreation, entering, error } = useEnterCreation()

// D6 恢复（v2.2）：已登录回访用户的「继续：<上次项目名>」幽灵链接。
// 仅作便捷入口，不抢锚的唯一创作入口地位；未登录 / 无记忆项目 → 不渲染。
// 数据面复用 useProjectWorkspace 模块级单例（与创作首页同源）。
const { projects, loadIfStale, resolveLastProjectId } = useProjectWorkspace()
const router = useRouter()

const ghostProjectId = computed(() => (auth.isLoggedIn ? resolveLastProjectId() : null))
const ghostProject = computed(() =>
  ghostProjectId.value
    ? (projects.value.find((p) => p.id === ghostProjectId.value) ?? null)
    : null,
)
// 标题未知（list 未回 / 项目已删）时兜底「继续创作」，仍可凭记忆 id 跳回上次项目。
const ghostLabel = computed(() =>
  ghostProject.value ? `继续：${displayCanvasTitle(ghostProject.value.title)}` : '继续创作',
)
const showGhostLink = computed(() => !!ghostProjectId.value)

function continueProject() {
  if (ghostProjectId.value) router.push(`/workflow/${ghostProjectId.value}`)
}

watch(
  isMobileLayout,
  (mobile) => {
    if (!mobile || mobileEntryDispatched()) return
    markMobileEntryDispatched()
    if (!auth.isLoggedIn) return
    // 一次性穿透（既有语义，本次不改）：已登录 ⇒ 直接进目标项目。
    // ⚠️ `replace: true` —— 自动分发不该在浏览器历史里留「返回即回品牌页」的记录
    //    （2026-10-24 性能修复的结论，push 会让用户按返回键又弹回品牌页）。
    // ⚠️ `allowImplicitCreate: false` —— 无手势，零项目 ⇒ 留品牌页，不创建（IA v4）。
    void enterCreation({ allowImplicitCreate: false, replace: true })
  },
  { immediate: true },
)

/**
 * 点锚 / 滑动解锁 = **进入创作**（D-3：回到创作现场，不是新建）。
 *
 * ⭐ 两端同一条路径（INV-5）：PC 与移动端都走 `useEnterCreation().enterCreation()`。
 *    收敛前 PC 走"UI 动作触发创建"（每次点锚 `sessionsApi.create` ⇒ 项目堆积的直接
 *    成因）、移动端走"自动路由 + 点锚进最近"，两套实现各改各的。
 *
 * ⚠️ `allowImplicitCreate: true`：这是**用户手势**，零项目时建 1 个默认项目
 *    是「把意图落地」；与之相对的移动端自动进入（无手势）传 false ⇒ 留品牌页。
 */

onMounted(() => {
  // 2026-10-24 性能修复（**二次修正**）：⛔ **不再在此立即预热**。
  //
  // 初版「品牌页挂载即预热画布页」是生产事故的元凶：它在 4166ms 拉起
  // 画布页整棵依赖树（338KB + 24 个 chunk），与首屏资源抢同域 6 个连接 ⇒
  // 535KB 的品牌 logo 被从 2.1 秒拖到 13 秒、API 排队 ⇒
  // 用户报「品牌页出不来 + 连登录都出问题」。
  //
  // ✅ 改为**用户意图触发**：指针移到锚 / 焦点进入 / 触摸滑条时才预热。
  //    此刻用户已明确表达意图，且首屏早已就绪 ⇒ 不抢任何连接。
  //    兜底那一路（首屏 load 之后预热）在 App.vue。
  // 2026-10-26 P3：主页品牌化后无列表消费方，fetchWorks/listProjects 一并退场。
  // 2026-10-27 v2.2（D6）：已登录时取最近项目标题供幽灵链接显示；
  //   loadIfStale 命中新鲜缓存时不发请求，避免重复排队（连接饥饿纪律）。
  if (auth.isLoggedIn) void loadIfStale()
})
</script>

<template>
  <div class="brand-page-root">
    <!-- 2026-10-22 用户裁定「霸屏铺满」：hero 是全宽首屏。
         2026-10-26 规格收敛 v2（P3）：滚动区已清空——「我的项目」唯一真身 = 创作首页
         （/canvases），「社区精选」唯一入口 = /community（发现，与移动端同构）；
         「发布作品」回归画布内 chrome 与移动端菜单。主页 = 纯品牌 + 一个锚点 CTA。 -->
    <!-- 2026-10-25 PR-0：`error` 承载入口分发失败的内联反馈（INV-6）。
         点那行「重试」会再发一次 create ⇒ 走 enterCreation ⇒ 未登录则弹登录，
         已登录则重跑一次进入。重试与点锚同一意图，故共用 create 事件。 -->
    <SignatureHero :creating="entering" :error="error ?? undefined" @create="() => enterCreation({ allowImplicitCreate: true })" />
    <!-- D6 恢复（v2.2）：已登录回访的「继续：<上次项目名>」幽灵链接。
         浮动在 hero 底部、不抢锚的唯一创作入口地位；未登录 / 无记忆项目 → 不渲染。 -->
    <a
      v-if="showGhostLink"
      data-testid="brand-ghost-continue"
      class="brand-ghost-continue"
      role="button"
      tabindex="0"
      @click.prevent="continueProject"
      @keydown.enter.prevent="continueProject"
    >
      {{ ghostLabel }}
    </a>
  </div>
</template>

<style scoped>
.brand-page-root {
  position: relative;
}
/* 幽灵链接：刻意弱于锚（一行小字、低对比、无边框），仅作便捷续作入口。
   ⛔ 只用 on-signature 家族令牌（浮在恒深签名底上，主题不变式）。 */
.brand-ghost-continue {
  position: absolute;
  bottom: 1.75rem;
  left: 50%;
  transform: translateX(-50%);
  padding: 4px 12px;
  font-size: var(--lnk-text-sm);
  line-height: var(--lnk-lh-sm);
  letter-spacing: 0.02em;
  white-space: nowrap;
  color: var(--lnk-text-on-signature-muted);
  text-decoration: none;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
  transition: color 0.15s ease;
}
.brand-ghost-continue:hover,
.brand-ghost-continue:focus-visible {
  color: var(--lnk-text-on-signature);
  outline: none;
}
</style>
