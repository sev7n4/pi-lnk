<script setup lang="ts">
/**
 * A3 · 移动端回访作品带（2026-10-22）
 *
 * 形态契约见《A3 回访作品带 · 封面与交互设计规范 v1》：
 * - 落点：移动端【对话】页签顶部（**不是**空态下半屏 —— 实测移动端几乎不渲染
 *   空态：`/workflow` → `location.assign` 跳最近项目 → `loadHistory` ⇒
 *   `agent.messages.length > 0` ⇒ 空态判据不成立）
 * - ≤4 张横滑；88px 封面 + 单行标题 + 相对时间
 * - **不设「继续创作」按钮**：卡片本身即入口，多一个按钮 = 第二入口 = 注意力竞争
 * - 有产物图用真实图；无产物图用墨鱼默认封面（恒深底 + 品牌紫墨鱼 + 白色墨滴锚印记）
 * - 浅色主题下封面加 1px 细描边（深色主题不加，否则变噪音）
 *
 * 移动端专用呈现 ⇒ 落 components/mobile/（AGENTS.md「移动端呈现」第 4 条）。
 */
import { computed } from 'vue'

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
  /** 点作品 = 打开该画布；focusNodeId 非空时同时定位到那张产物图 */
  open: [payload: { id: string; focusNodeId: string | null }]
}>()

/** 规格上限：4 张（375pt 一屏露 3 张 + 第 4 张半露 ⇒ 横滑是必要动作） */
const MAX_ITEMS = 4

/** 88px：12 + 88×3 + 10×2 + 12 = 308 ≤ 375（设计规范 §3.1 推导值） */
const COVER_SIZE = 88

/** 墨鱼默认封面（恒深底 + 品牌紫墨鱼 + 白色墨滴锚印记 + 圆角 16%） */
const DEFAULT_COVER = '/brand/canvas-cover/default-128.png'

const items = computed(() => (props.works ?? []).slice(0, MAX_ITEMS))

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
</script>

<template>
  <section
    v-if="items.length"
    class="recent-works"
    data-testid="recent-works-strip"
    aria-label="继续你的创作"
  >
    <p class="recent-works__title">继续你的创作</p>
    <ul class="recent-works__row">
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
  </section>
</template>

<style scoped>
.recent-works {
  padding: 8px 0 2px;
}

.recent-works__title {
  margin: 0 0 6px;
  padding: 0 12px;
  color: var(--lnk-text-secondary);
  font-size: var(--lnk-text-xs);
  line-height: var(--lnk-lh-xs);
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

.recent-works__cell {
  flex: 0 0 auto;
  margin: 0;
  padding: 0;
}

.recent-works__item {
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

/* 封面：恒深底（--lnk-surface-signature 同值），浅色主题下加 1px 细描边 ——
   否则在浅色面板上像「贴了个黑块」。深色主题不加，避免变噪音。 */
.recent-works__cover {
  display: block;
  border-radius: 10px;
  object-fit: cover;
  background: var(--lnk-surface-signature);
}

:global(:root[data-theme='light']) .recent-works__cover {
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
