<script setup lang="ts">
/**
 * A3 · 移动端回访作品带（2026-10-22 v1；2026-10-23 IA v4 v2）
 *
 * 形态契约见《A3 回访作品带 · 封面与交互设计规范》：
 * - 落点：移动端【对话】页签滚动流顶部（**不是**空态下半屏 —— 实测移动端几乎
 *   不渲染空态：`/workflow` → `location.assign` 跳最近项目 → `loadHistory` ⇒
 *   `agent.messages.length > 0` ⇒ 空态判据不成立）
 * - ≤4 张横滑；88px 封面 + 单行标题 + 相对时间
 * - **不设「继续创作」按钮**：卡片本身即入口，多一个按钮 = 第二入口 = 注意力竞争
 * - 有产物图用真实图；无产物图用墨鱼默认封面（恒深底 + 品牌紫墨鱼 + 白色墨滴锚印记）
 * - 封面描边**双主题基线化**（v2）：`--lnk-border-subtle` 深浅成对，深色 8% 白环
 *   给恒深底封面一个可感知的实体边界——逆转 v1「深色不加、避免噪音」的决策
 *   （2026-10-23 真机走查：深色下封面与页面底只差 1 级，四张封面「浮」在页面上）
 *
 * IA v4（2026-10-23 用户裁决）新增：
 * - 首卡【新建项目】tile：88px 圆角框 + 圆盘加号 + 「新建项目」，不要墨鱼（简约）
 * - 标题行右侧「全部 N 个 ›」：一步给「带外还有」的信号 + 直达全量列表
 * - 手动收拢（⛔ 不做自动：移动端恒有历史 ⇒ 自动判据 = 恒收拢，A3 视觉白做），
 *   localStorage 持久化
 * - 右缘渐隐：仅非滚动末端时（横滑暗示；到端即消失，不常年糊在内容上）
 * - 底部 1px 发丝线（--lnk-border-subtle）：与消息流的边界（深色下两边皆深、
 *   原来完全糊在一起）
 *
 * 移动端专用呈现 ⇒ 落 components/mobile/（AGENTS.md「移动端呈现」第 4 条）。
 */
import { computed, onMounted, ref, watch } from 'vue'

export interface RecentWorkItem {
  id: string
  title: string
  /** 真实产物图 URL；null ⇒ 用墨鱼默认封面 */
  coverUrl: string | null
  /** 产物节点 id；点作品时据此定位到那张图 */
  coverNodeId: string | null
  updatedAt: string
}

const props = defineProps<{
  works: RecentWorkItem[]
  /** 相对时间的「现在」基准（测试可注入，避免依赖真实时钟） */
  now?: number
}>()

const emit = defineEmits<{
  /** 点作品 = 打开该项目；focusNodeId 非空时同时定位到那张产物图 */
  open: [payload: { id: string; focusNodeId: string | null }]
  /** 点首卡 = 新建项目（新画布＋首个对话） */
  create: []
  /** 点「全部 N 个 ›」= 打开全量项目列表（消费方接抽屉项目区） */
  'open-all': []
}>()

/** 规格上限：4 张（375pt 一屏露 3 张 + 第 4 张半露 ⇒ 横滑是必要动作） */
const MAX_ITEMS = 4

/** 88px：12 + 88×3 + 10×2 + 12 = 308 ≤ 375（设计规范 §3.1 推导值） */
const COVER_SIZE = 88

/** 墨鱼默认封面（恒深底 + 品牌紫墨鱼 + 白色墨滴锚印记 + 圆角 16%） */
const DEFAULT_COVER = '/brand/canvas-cover/default-128.png'

/** 收拢态持久化（localStorage 不可用时静默降级为不持久） */
const COLLAPSED_KEY = 'lnk.recentWorks.collapsed'

const items = computed(() => (props.works ?? []).slice(0, MAX_ITEMS))
const total = computed(() => props.works?.length ?? 0)

function coverSrc(item: RecentWorkItem): string {
  return item.coverUrl && item.coverUrl.trim() ? item.coverUrl : DEFAULT_COVER
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / M 月 N 日 */
function relativeTime(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const base = typeof props.now === 'number' ? props.now : Date.now()
  const diff = Math.max(0, base - t)
  const min = Math.floor(diff / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day} 天前`
  const d = new Date(t)
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

function onOpen(item: RecentWorkItem) {
  emit('open', { id: item.id, focusNodeId: item.coverNodeId })
}

// ── 手动收拢（IA v4）──
const collapsed = ref(readCollapsed())

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

function toggleCollapsed() {
  collapsed.value = !collapsed.value
  try {
    localStorage.setItem(COLLAPSED_KEY, collapsed.value ? '1' : '0')
  } catch {
    /* 隐私模式等写入失败：仅本次会话不持久，功能不坏 */
  }
}

// ── 右缘渐隐：仅非滚动末端（IA v4 横滑暗示）──
const rowRef = ref<HTMLElement | null>(null)
const atEnd = ref(true)

function syncFade() {
  const el = rowRef.value
  if (!el) return
  atEnd.value = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1
}

onMounted(syncFade)
// 作品异步到达后重算（首帧 works 为空时不渲染行，到位后要补一次判定）
watch(() => props.works.length, syncFade)
</script>

<template>
  <section
    v-if="items.length"
    class="recent-works"
    data-testid="recent-works-strip"
    aria-label="继续你的创作"
  >
    <!-- 收拢态：一行入口（点它展开；「全部」入口在展开态头部）。
         与「全部 N 个」合并成一行，收拢也不丢「带外还有」的信号。 -->
    <button
      v-if="collapsed"
      type="button"
      class="recent-works__collapsed"
      data-testid="recent-works-expand"
      @click="toggleCollapsed"
    >
      <span class="recent-works__collapsed-chev" aria-hidden="true">›</span>
      继续你的创作 · 全部 {{ total }} 个
    </button>
    <template v-else>
      <div class="recent-works__head">
        <p class="recent-works__title">继续你的创作</p>
        <div class="recent-works__actions">
          <button
            type="button"
            class="recent-works__all"
            data-testid="recent-works-all"
            @click="emit('open-all')"
          >
            全部 {{ total }} 个 <span aria-hidden="true">›</span>
          </button>
          <button
            type="button"
            class="recent-works__toggle"
            data-testid="recent-works-collapse"
            aria-label="收拢作品带"
            aria-expanded="true"
            @click="toggleCollapsed"
          >
            <span aria-hidden="true">⌄</span>
          </button>
        </div>
      </div>
      <ul
        ref="rowRef"
        class="recent-works__row"
        :class="{ 'is-fading': !atEnd }"
        @scroll.passive="syncFade"
      >
        <!-- 首卡【新建项目】（IA v4）：88px 圆角框 + 圆盘加号，不要墨鱼 -->
        <li class="recent-works__cell">
          <button
            type="button"
            class="recent-works__create"
            data-testid="recent-work-create"
            aria-label="新建项目"
            @click="emit('create')"
          >
            <span class="recent-works__create-box" aria-hidden="true">
              <span class="recent-works__create-disc">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25">
                  <path stroke-linecap="round" d="M12 5v14M5 12h14" />
                </svg>
              </span>
            </span>
            <span class="recent-works__name">新建项目</span>
            <!-- 空 meta 占位：与作品卡两行文字同高，行内对齐 -->
            <span class="recent-works__meta" />
          </button>
        </li>
        <li v-for="item in items" :key="item.id" class="recent-works__cell">
          <button
            type="button"
            class="recent-works__item"
            data-testid="recent-work-item"
            :aria-label="`打开 ${item.title}`"
            @click="onOpen(item)"
          >
            <img
              class="recent-works__cover"
              data-testid="recent-work-cover"
              :src="coverSrc(item)"
              :alt="item.title"
              :style="{ width: `${COVER_SIZE}px`, height: `${COVER_SIZE}px` }"
              loading="lazy"
            />
            <span class="recent-works__name">{{ item.title }}</span>
            <span class="recent-works__meta">{{ relativeTime(item.updatedAt) }}</span>
          </button>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
/* v2：底部 1px 发丝线 = 作品带与消息流的边界（深色下两边皆深，原来完全糊在一起） */
.recent-works {
  padding: 8px 0 10px;
  border-bottom: 1px solid var(--lnk-border-subtle);
}

.recent-works__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 12px;
}

.recent-works__title {
  margin: 0 0 6px;
  color: var(--lnk-text-secondary);
  font-size: var(--lnk-text-xs);
  line-height: var(--lnk-lh-xs);
}

.recent-works__head .recent-works__title {
  margin-bottom: 0;
}

.recent-works__actions {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-bottom: 6px;
}

/* 「全部 N 个 ›」：文字钮（不占卡片位）——一步给信号 + 直达全量列表 */
.recent-works__all {
  padding: 2px 4px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--lnk-text-muted);
  font-size: var(--lnk-text-2xs);
  line-height: var(--lnk-lh-2xs);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.recent-works__all:active {
  color: var(--lnk-text-secondary);
}

/* 收拢 chevron：与「全部」同族同色，量级更轻 */
.recent-works__toggle {
  display: flex;
  width: 24px;
  height: 24px;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--lnk-text-muted);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

/* 收拢态一行入口（与「全部 N 个」合并，收拢也不丢「带外还有」的信号） */
.recent-works__collapsed {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  border: 0;
  background: transparent;
  color: var(--lnk-text-secondary);
  font-size: var(--lnk-text-xs);
  line-height: var(--lnk-lh-xs);
  text-align: left;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.recent-works__collapsed-chev {
  color: var(--lnk-text-muted);
}

.recent-works__row {
  display: flex;
  gap: 10px;
  margin: 0;
  padding: 0 12px;
  list-style: none;
  overflow-x: auto;
  scrollbar-width: none;
  -webkit-overflow-scrolling: touch;
}

.recent-works__row::-webkit-scrollbar {
  display: none;
}

/* 右缘渐隐：仅非滚动末端（is-fading 由 scroll 位置驱动，到端类摘除）。
   ⚠️ 用 black/transparent 关键字而非 hex/rgba —— theme-usage 棘轮扫 .vue 内
   任意 rgba( 与深色 hex，遮罩渐变的颜色字面量会撞基线（只许减少）。 */
.recent-works__row.is-fading {
  -webkit-mask-image: linear-gradient(to right, black calc(100% - 28px), transparent);
  mask-image: linear-gradient(to right, black calc(100% - 28px), transparent);
}

.recent-works__cell {
  flex: 0 0 auto;
  margin: 0;
  padding: 0;
}

.recent-works__item,
.recent-works__create {
  display: flex;
  width: 88px;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

/* 首卡【新建项目】：虚线圆角框 + 居中圆盘加号（create-card/FAB 同族语言，
   36px 小一档——它在 88px tile 里，不抢封面）。 */
.recent-works__create-box {
  display: flex;
  width: 88px;
  height: 88px;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  border: 1px dashed var(--lnk-border-subtle);
}

.recent-works__create-disc {
  display: flex;
  width: 36px;
  height: 36px;
  align-items: center;
  justify-content: center;
  border-radius: var(--lnk-radius-full);
  background: var(--lnk-accent-gradient);
  color: var(--lnk-text-on-accent);
}

.recent-works__create-disc svg {
  width: 18px;
  height: 18px;
}

/* 封面：恒深底（--lnk-surface-signature 同值）。
   v2 双主题基线化：深浅共用同一 1px 环（--lnk-border-subtle 深浅成对：
   深 8% 白 / 浅 10% 黑）——深色也给恒深底封面一个可感知的实体边界。 */
.recent-works__cover {
  display: block;
  border-radius: 10px;
  object-fit: cover;
  background: var(--lnk-surface-signature);
  box-shadow: 0 0 0 1px var(--lnk-border-subtle);
}

.recent-works__name {
  display: block;
  width: 88px;
  overflow: hidden;
  color: var(--lnk-text-primary);
  font-size: var(--lnk-text-2xs);
  line-height: var(--lnk-lh-2xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recent-works__meta {
  display: block;
  width: 88px;
  overflow: hidden;
  color: var(--lnk-text-muted);
  font-size: var(--lnk-text-2xs);
  line-height: var(--lnk-lh-2xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
