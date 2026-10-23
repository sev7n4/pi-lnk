<script setup lang="ts">
/**
 * 移动端应用骨架 · 发现页签（IA v4，2026-10-23 重做：发现 = 社区 / 分享）。
 *
 * 变更缘由（用户裁定）：
 * ① 原页是「资料库 / 专家 / 技能 / 连接器 / 项目空间」五行的功能清单（IA v3 整页照抄
 *    竞品截图），既不是社区也承载不了分享；IA v4 全链路定为「发现承载社区/分享」，
 *    且用户原话「【社区精选】放在移动端【发现】页会不会更好？」⇒ 这里直接是社区精选。
 * ② 删【资料库】行：它是画布资产库的跨页签入口（切回对话页签后展开资产库选择器），
 *    而资产库在画布页本身可达——composer 附件卡的「资产库」瓦片（AgentSideRail
 *    pickAssetLibrary，移动端同一张卡，无 isMobileLayout 分支）。跨页签跳转入口撤除
 *    后，DiscoverPane 的 goto-canvas emit 与壳层 onDiscoverGotoCanvas 一并退役（无死代码）。
 * ③ 删【项目空间】行：IA v4 里「项目 = 画布 + 对话」，项目入口归【对话】页签
 *    （作品带首卡「新建项目」+ 🕘 抽屉全量列表）；此处再挂一个「即将开放」的项目云空间
 *    是旧语义残留。
 * ④ 保留【专家 / 技能 / 连接器】三行置灰：它们是尚未定义的能力预留位，与社区语义
 *    不冲突，置于社区流之后的「敬请期待」区块（不与作品抢主位）。
 *
 * 数据源与 WEB 端【社区精选】同源：`GET /works`（search / category 两个参数），
 * 分类维度常量取 `@lnkpi/shared` 的 WORK_CATEGORIES（分类形状归 shared 真相）。
 */
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { Work } from '@lnkpi/shared'
import { WORK_CATEGORIES } from '@lnkpi/shared'
import { api } from '@/services/api'
import WorkCard from '@/components/works/WorkCard.vue'

const router = useRouter()
const works = ref<Work[]>([])
const search = ref('')
// 分类维度（type）筛选：2026-10-21 P1 起归社区职责（主页只留一行精选）
const activeCategory = ref<string>('全部')
// 初值 true ⇒ 首帧就是骨架屏：数据尚未到手时不该先闪一下「暂无作品」空态
// （CommunityPage 是 false + onMounted 拉取 ⇒ 首帧空态，本页不复制该闪烁）
const loading = ref(true)

async function fetchWorks() {
  loading.value = true
  try {
    const { data } = await api.get<{ data: { items: Work[] } }>('/works', {
      params: {
        search: search.value || undefined,
        // 「全部」传 undefined 而非空串：服务端按 params.category 判空，空串会漏进过滤分支
        category: activeCategory.value === '全部' ? undefined : activeCategory.value,
      },
    })
    works.value = data.data.items
  } catch {
    // ⚠️ 与 WEB 端同款诚实降级：失败即空态，不塞 mock 作品（用户会以为真有人发了这些）
    works.value = []
  } finally {
    loading.value = false
  }
}

function onCategoryChange(cat: string) {
  if (activeCategory.value === cat) return
  activeCategory.value = cat
  void fetchWorks()
}

// 五个路由与 WEB 端逐字一致（分享页 / 作者主页 / 创作过程页），两端同语义
function viewWork(workId: string) {
  router.push(`/share/${workId}`)
}

function viewWatch(workId: string) {
  router.push(`/share/${workId}`)
}

function viewProcess(workId: string) {
  router.push(`/share/${workId}/process`)
}

function viewAuthor(authorId: string) {
  router.push(`/creator/${authorId}`)
}

function viewShare(workId: string) {
  router.push(`/share/${workId}`)
}

/** 能力预留位（置灰不可点）：尚未定义的能力，不与社区作品流抢主位 */
const soonRows = [
  { key: 'experts', label: '专家', icon: 'experts' },
  { key: 'skills', label: '技能', icon: 'skills' },
  { key: 'connectors', label: '连接器', icon: 'connectors' },
] as const

onMounted(fetchWorks)
</script>

<template>
  <div class="discover-pane">
    <header class="pane-head">
      <p class="pane-title">社区精选</p>
      <p class="pane-sub">看看别人怎么做出来的</p>
      <div class="search-row">
        <input
          v-model="search"
          class="search-input"
          type="search"
          placeholder="搜索作品…"
          aria-label="搜索作品"
          @keydown.enter="fetchWorks"
        >
        <button type="button" class="search-btn" @click="fetchWorks">搜索</button>
      </div>
    </header>

    <!-- 分类维度：横滑（窄屏一行放不下 WORK_CATEGORIES 全量） -->
    <div class="cats" role="group" aria-label="作品分类">
      <button
        v-for="cat in WORK_CATEGORIES"
        :key="cat"
        type="button"
        class="cat-chip"
        :class="{ 'is-active': activeCategory === cat }"
        :aria-pressed="activeCategory === cat"
        @click="onCategoryChange(cat)"
      >
        {{ cat }}
      </button>
    </div>

    <!-- 作品流：2 列（窄屏一行铺满会把封面撑得过宽，横向对比失真） -->
    <div v-if="loading" class="work-grid" data-testid="discover-skeleton">
      <div v-for="i in 4" :key="i" class="skeleton-card" />
    </div>

    <div
      v-else-if="works.length"
      class="work-grid"
      data-testid="discover-work-grid"
    >
      <WorkCard
        v-for="work in works"
        :key="work.id"
        :work="work"
        @view-work="viewWork"
        @view-watch="viewWatch"
        @view-process="viewProcess"
        @view-author="viewAuthor"
        @view-share="viewShare"
      />
    </div>

    <p v-else class="pane-empty" data-testid="discover-empty">
      {{ search ? '没有找到相关作品' : '暂无作品' }}
    </p>

    <!-- 能力预留：置于社区流之后，明确次位（社区是本页主叙事） -->
    <section class="soon" aria-labelledby="discover-soon-title">
      <p id="discover-soon-title" class="soon-title">敬请期待</p>
      <div class="row-group">
        <button
          v-for="row in soonRows"
          :key="row.key"
          type="button"
          class="row-item is-disabled"
          disabled
        >
          <span class="row-icon" aria-hidden="true">
            <!-- 专家：星徽 -->
            <svg v-if="row.icon === 'experts'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
              <circle cx="12" cy="12" r="8.5" />
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 7.5l1.4 2.9 3.1.4-2.3 2.2.6 3.1L12 14.6l-2.8 1.5.6-3.1-2.3-2.2 3.1-.4L12 7.5Z" />
            </svg>
            <!-- 技能：扳手 -->
            <svg v-else-if="row.icon === 'skills'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
              <path stroke-linecap="round" stroke-linejoin="round" d="M14.5 6.5a3.5 3.5 0 0 0-4.6 4.4L5 15.8a1.8 1.8 0 1 0 2.5 2.5l4.9-4.9a3.5 3.5 0 0 0 4.4-4.6l-2.2 2.2-2.1-.4-.4-2.1 2.4-2Z" />
            </svg>
            <!-- 连接器：链环 -->
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
              <path stroke-linecap="round" stroke-linejoin="round" d="M10 14a4 4 0 0 1 0-5.6l2.4-2.4a4 4 0 0 1 5.6 5.6l-1.4 1.4" />
              <path stroke-linecap="round" stroke-linejoin="round" d="M14 10a4 4 0 0 1 0 5.6l-2.4 2.4a4 4 0 0 1-5.6-5.6l1.4-1.4" />
            </svg>
          </span>
          <span class="row-label">{{ row.label }}</span>
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.discover-pane {
  position: fixed;
  inset: 0;
  z-index: 75;
  padding: calc(var(--lnk-topbar-h, 44px) + 12px) 12px calc(var(--lnk-tabbar-h, 56px) + 12px);
  background: var(--lnk-surface-canvas);
  overflow-y: auto;
}

/* ===== 头部（标题 + 搜索）===== */
.pane-head {
  margin-bottom: 12px;
}

/* 用 p 而非 h1：本 pane 挂在画布页壳层内（页签名「发现」已在页签栏），
   页面级 h1 归属工作台 hero，pane 内不另立标题级 */
.pane-title {
  color: var(--lnk-text-primary);
  font-size: var(--lnk-text-lg, 17px);
  font-weight: 600;
  line-height: var(--lnk-lh-lg, 26px);
}

.pane-sub {
  margin-top: 2px;
  color: var(--lnk-text-muted);
  font-size: var(--lnk-text-xs);
  line-height: var(--lnk-lh-xs);
}

.search-row {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.search-input {
  min-width: 0;
  flex: 1 1 auto;
  border: 1px solid var(--lnk-border-subtle);
  border-radius: 12px;
  padding: 9px 12px;
  background: var(--lnk-surface-raised);
  color: var(--lnk-text-primary);
  font-size: var(--lnk-text-sm);
  line-height: var(--lnk-lh-sm);
  outline: none;
}

.search-input::placeholder {
  color: var(--lnk-text-muted);
}

.search-input:focus {
  border-color: var(--lnk-accent);
}

.search-btn {
  flex: 0 0 auto;
  border: 0;
  border-radius: 12px;
  padding: 9px 14px;
  background: var(--lnk-accent);
  color: var(--lnk-text-on-accent, #fff);
  font-size: var(--lnk-text-sm);
  line-height: var(--lnk-lh-sm);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

/* ===== 分类 chips（横滑）===== */
.cats {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
  overflow-x: auto;
  scrollbar-width: none;
}

.cats::-webkit-scrollbar {
  display: none;
}

.cat-chip {
  flex: 0 0 auto;
  border: 0;
  border-radius: 999px;
  padding: 6px 12px;
  background: transparent;
  color: var(--lnk-text-muted);
  font-size: var(--lnk-text-xs);
  line-height: var(--lnk-lh-xs);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.cat-chip.is-active {
  background: var(--lnk-accent-subtle);
  color: var(--lnk-accent-text);
}

/* ===== 作品流 ===== */
.work-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.skeleton-card {
  aspect-ratio: 3 / 4;
  border-radius: 16px;
  background: var(--lnk-surface-raised);
}

.pane-empty {
  padding: 32px 0;
  color: var(--lnk-text-muted);
  font-size: var(--lnk-text-sm);
  text-align: center;
}

/* ===== 能力预留（次位区块）===== */
.soon {
  margin-top: 28px;
  padding-bottom: 8px;
}

.soon-title {
  margin-bottom: 8px;
  color: var(--lnk-text-muted);
  font-size: var(--lnk-text-2xs);
  line-height: var(--lnk-lh-2xs);
  letter-spacing: 0.08em;
}

.row-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.row-item {
  display: flex;
  align-items: center;
  gap: 12px;
  border: 0.5px solid var(--lnk-border-subtle);
  border-radius: 14px;
  padding: 15px 14px;
  background: var(--lnk-surface-raised);
  color: var(--lnk-text-primary);
  font-size: var(--lnk-text-base, 14px);
  text-align: left;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: background-color var(--lnk-duration-fast, 120ms) var(--lnk-ease-standard, ease);
}

.row-item.is-disabled {
  opacity: 0.4;
  cursor: default;
}

.row-icon {
  display: flex;
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
}

.row-icon svg {
  width: 20px;
  height: 20px;
}

.row-label {
  flex: 1 1 auto;
}
</style>