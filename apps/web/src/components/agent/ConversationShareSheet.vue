<script setup lang="ts">
/**
 * 分享面板（2026-11-05 真机走查六问 · iOS 极简重构）。
 *
 * 唯一基座 = `MobileSheet`。信息架构（HIG：模态、单一退出、状态可点、一次一屏一件事）：
 *  ① 对话页零选择态：本体页只留「分享」入口，☐ 勾选列 / 顶栏 ✕ 全部退役；
 *     卡片头部 ✕ 是全局唯一退出口，任何层级点它都直接回对话页。
 *  ② 选择行：计数在视野内只出现一次（不再有 MobileSheet subtitle 重复）；
 *     「全选 ⇄ 取消全选」是**永远可点**的状态切换，不用 disabled 灰块；
 *     清空后仍可一键恢复，不会把用户锁死在 0 条。
 *  ③ 一个主行动 + 四个等权工具：主行动是系统分享（navigator.share，转发箭头），
 *     工具区保留生成二维码 / 复制链接 / 生成图片 / 离线打开。渠道名（微信）退役为
 *     功能名（生成二维码），品牌色圆底退役为中性线性图标。
 *  ④ L1 结果视图**替换** L0 菜单，不与菜单同屏堆叠；返回回菜单，✕ 仍直接回对话页。
 *
 * ⚠️ 手势安全（spec §4）：复制链接 / 系统分享都必须在点击同步回调内触发。
 *    面板打开即预先 upload 缓存托管 URL，勾选集变化即重取；点击时绝不 await 上传。
 */
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import MobileSheet from '@/components/mobile/MobileSheet.vue'
import { useShareActions } from '@/composables/useShareActions'
import type { ShareTurn } from '@lnkpi/shared/shareTemplate'

const props = withDefaults(
	defineProps<{
		turns: ShareTurn[]
		sessionId: string
		/** 分享页可见标题（对话·项目名称），同时作为系统分享的标题。 */
		title?: string
		/** 当前纳入分享的条数（范围行计数）。 */
		selectedCount?: number
		/** 会话总条数。 */
		totalCount?: number
		/** 回合级分享（单轮）隐藏范围行：没有可切换的范围，留着就是点了没反应的无效控件。 */
		showScope?: boolean
		modelValue: boolean
	}>(),
	{ showScope: true },
)

const emit = defineEmits<{
	'update:modelValue': [boolean]
	/** 范围切换：true=纳入全部，false=清空（页面层持有勾选集真相）。 */
	toggleAll: [boolean]
}>()

const actions = useShareActions()

const busy = ref(false)
const uploading = ref(false)
const shareUrl = ref<string | null>(null)
/** L0 菜单 / L1 二维码 / L1 图片（结果视图替换内容，不与菜单同屏） */
const view = ref<'menu' | 'qr' | 'image'>('menu')
const imagePreview = ref<string | null>(null)

const selectedCount = computed(() => props.selectedCount ?? props.turns.length)
const totalCount = computed(() => props.totalCount ?? props.turns.length)
const allSelected = computed(() => selectedCount.value > 0 && selectedCount.value === totalCount.value)
const canShare = computed(() => selectedCount.value > 0)
const linkReady = computed(() => !!shareUrl.value && !uploading.value && !busy.value)
const linkActionDisabled = computed(() => !linkReady.value || !canShare.value)
const localActionDisabled = computed(() => busy.value || !canShare.value)

function reset() {
	view.value = 'menu'
	imagePreview.value = null
	shareUrl.value = null
}

function reupload() {
	if (!props.turns.length) {
		shareUrl.value = null
		return
	}
	uploading.value = true
	actions
		.upload(props.turns, props.sessionId, props.title)
		.then((res) => {
			shareUrl.value = res.url
		})
		.catch(() => {
			shareUrl.value = null
			ElMessage.error('生成分享链接失败，链接/二维码类分享暂不可用')
		})
		.finally(() => {
			uploading.value = false
		})
}

/** 卡片 ✕ / 点遮罩：一次关闭，页面层负责把上下文完整复原。 */
function close() {
	emit('update:modelValue', false)
}

watch(
	() => props.modelValue,
	(open) => {
		if (open) {
			reset()
			reupload()
		}
	},
	{ immediate: true },
)

// 范围变化 ⇒ 托管 URL 需重取（旧 url 对应旧集合）
watch(
	() => props.turns,
	() => {
		if (props.modelValue) reupload()
	},
)

function onToggleAll() {
	emit('toggleAll', !allSelected.value)
}

async function onCopyLink() {
	if (!shareUrl.value) return
	await actions.copyLink(shareUrl.value)
	ElMessage.success('链接已复制')
}

/** 主行动：系统分享。调用发生在点击同步栈内，composable 内部不 await 前置操作。 */
async function onShareToSystem() {
	if (!shareUrl.value || !canShare.value) return
	const result = await actions.shareViaSystem({
		title: props.title ?? '对话分享',
		url: shareUrl.value,
	})
	if (result === 'copied') ElMessage.success('已复制链接，可粘贴发送')
	else if (result === 'failed') ElMessage.error('分享失败，请试试「复制链接」')
}

/** 生成二维码 ⇒ 进入二维码结果视图（替换菜单内容）。 */
function onOpenQr() {
	if (!shareUrl.value) return
	actions.showQr(shareUrl.value)
	view.value = 'qr'
}

async function onOpenOffline() {
	busy.value = true
	try {
		await actions.openOffline(props.turns, props.title)
	} finally {
		busy.value = false
	}
}

async function onMakeImage() {
	busy.value = true
	try {
		imagePreview.value = await actions.toImage(props.turns, props.title)
		view.value = 'image'
	} finally {
		busy.value = false
	}
}

function onBack() {
	view.value = 'menu'
}

const sheetTitle = computed(() =>
	view.value === 'qr' ? '扫码分享' : view.value === 'image' ? '分享图片' : '分享对话',
)
</script>

<template>
	<MobileSheet v-if="modelValue" :title="sheetTitle" @close="close">
		<!-- ============ L0 菜单 ============ -->
		<template v-if="view === 'menu'">
			<!-- 范围行：唯一计数 + 永远可点的状态切换（HIG：不用 disabled 表达二元状态） -->
			<div v-if="showScope" class="share-scope" data-testid="share-select-row">
				<span class="share-scope__count" data-testid="share-selected-count">
					已选 {{ selectedCount }} / {{ totalCount }} 条
				</span>
				<button
					type="button"
					class="share-toggle"
					data-testid="share-select-all"
					:aria-pressed="allSelected"
					@click="onToggleAll"
				>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
						<rect x="4" y="4" width="16" height="16" rx="4" />
						<path v-if="allSelected" stroke-linecap="round" stroke-linejoin="round" d="M7 12h10" />
						<path v-else stroke-linecap="round" stroke-linejoin="round" d="M8 12.4l2.8 2.8L16 9.6" />
					</svg>
					<span>{{ allSelected ? '取消全选' : '全选' }}</span>
				</button>
			</div>

			<div v-if="uploading" class="share-hint">正在生成分享链接…</div>
			<div v-else-if="!canShare" class="share-hint">点「全选」加入全部对话</div>

			<!-- 主行动：系统分享（iOS 分享表单等价物，转发箭头） -->
			<button
				type="button"
				class="share-primary"
				data-testid="share-primary"
				:disabled="linkActionDisabled"
				@click="onShareToSystem"
			>
				<span class="share-primary__icon">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
						<path stroke-linecap="round" stroke-linejoin="round" d="M4 20c0-7 5-12 12-12h3 M14 4l5 4-5 4" />
					</svg>
				</span>
				<span class="share-primary__label">分享到…</span>
				<svg class="share-primary__chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
					<path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
				</svg>
			</button>

			<!-- 四个等权工具：功能名（不伪装成渠道）+ 中性线性图标 -->
			<div class="share-tools" data-testid="share-menu">
				<button
					type="button"
					class="share-tool"
					:disabled="linkActionDisabled"
					data-testid="mode-qr"
					@click="onOpenQr"
				>
					<span class="share-tool__icon">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
							<path stroke-linecap="round" stroke-linejoin="round" d="M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h2v2h-2z M18 14h2v2h-2z M14 18h2v2h-2z M18 18h2v2h-2z" />
						</svg>
					</span>
					<span class="share-tool__label">二维码</span>
				</button>
				<button
					type="button"
					class="share-tool"
					:disabled="linkActionDisabled"
					data-testid="mode-link"
					@click="onCopyLink"
				>
					<span class="share-tool__icon">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
							<path stroke-linecap="round" stroke-linejoin="round" d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 1 0-5.66-5.66l-1 1 M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 1 0 5.66 5.66l1-1" />
						</svg>
					</span>
					<span class="share-tool__label">复制链接</span>
				</button>
				<button
					type="button"
					class="share-tool"
					:disabled="localActionDisabled"
					data-testid="mode-image"
					@click="onMakeImage"
				>
					<span class="share-tool__icon">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
							<path stroke-linecap="round" stroke-linejoin="round" d="M4 5h16v14H4z M4 15l4-4 4 4 3-3 5 5 M9 9a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z" />
						</svg>
					</span>
					<span class="share-tool__label">生成图片</span>
				</button>
				<button
					type="button"
					class="share-tool"
					:disabled="localActionDisabled"
					data-testid="mode-offline"
					@click="onOpenOffline"
				>
					<span class="share-tool__icon">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
							<path stroke-linecap="round" stroke-linejoin="round" d="M12 3v12 M8 11l4 4 4-4 M5 21h14" />
						</svg>
					</span>
					<span class="share-tool__label">离线打开</span>
				</button>
			</div>
		</template>

		<!-- ============ L1 二维码结果视图（替换菜单） ============ -->
		<template v-else-if="view === 'qr'">
			<div class="share-result" data-testid="share-qr">
				<img v-if="actions.qrDataUrl.value" :src="actions.qrDataUrl.value" alt="分享二维码" class="share-result__qr" />
				<p class="share-result__tip">用手机扫码打开分享页（长按二维码可发给任意好友）</p>
				<div class="share-result__ops">
					<button type="button" class="share-chip" data-testid="qr-back" @click="onBack">返回</button>
					<button type="button" class="share-chip" data-testid="qr-copy" @click="onCopyLink">复制链接</button>
				</div>
			</div>
		</template>

		<!-- ============ L1 图片结果视图（替换菜单） ============ -->
		<template v-else>
			<div class="share-result" data-testid="share-img">
				<img v-if="imagePreview" :src="imagePreview" alt="对话图片" class="share-result__img" />
				<div class="share-result__ops">
					<button type="button" class="share-chip" data-testid="img-back" @click="onBack">返回</button>
					<a
						v-if="imagePreview"
						:href="imagePreview"
						download="conversation.png"
						class="share-chip"
						data-testid="img-dl"
						>保存到相册</a
					>
				</div>
			</div>
		</template>
	</MobileSheet>
</template>

<style scoped>
.share-hint {
	font-size: var(--lnk-text-xs);
	color: var(--lnk-text-muted);
	text-align: center;
	margin: 4px 0;
}

/* 范围行：唯一计数 + 可点切换 */
.share-scope {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 10px;
	padding: 4px 0 12px;
	border-bottom: 1px solid var(--lnk-border-subtle);
}

.share-scope__count {
	font-size: var(--lnk-text-sm);
	color: var(--lnk-text-secondary);
}

.share-toggle {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	min-height: 34px;
	padding: 6px 12px;
	border-radius: 999px;
	border: 1px solid var(--lnk-accent-border);
	background: var(--lnk-surface-raised);
	color: var(--lnk-text-primary);
	font-size: var(--lnk-text-xs);
	cursor: pointer;
	touch-action: manipulation;
	-webkit-tap-highlight-color: transparent;
}

.share-toggle:active {
	background: var(--lnk-accent-subtle);
}

.share-toggle svg {
	width: 14px;
	height: 14px;
}

/* 主行动：整行强调，唯一一级动作 */
.share-primary {
	display: flex;
	align-items: center;
	gap: 12px;
	width: 100%;
	min-height: var(--lnk-touch-target);
	margin: 14px 0 4px;
	padding: 8px 12px;
	border: 1px solid var(--lnk-accent-border);
	border-radius: var(--lnk-radius-lg);
	background: var(--lnk-accent-subtle);
	color: var(--lnk-accent-text);
	cursor: pointer;
	touch-action: manipulation;
	-webkit-tap-highlight-color: transparent;
}

.share-primary:disabled {
	opacity: 0.45;
	cursor: not-allowed;
}

.share-primary__icon {
	display: flex;
	width: 36px;
	height: 36px;
	flex: none;
	align-items: center;
	justify-content: center;
	border-radius: 50%;
	background: var(--lnk-surface-raised);
}

.share-primary__icon svg {
	width: 20px;
	height: 20px;
}

.share-primary__label {
	flex: 1;
	text-align: left;
	font-size: var(--lnk-text-sm);
	font-weight: var(--lnk-weight-medium);
}

.share-primary__chevron {
	width: 16px;
	height: 16px;
	flex: none;
	color: var(--lnk-text-muted);
}

/* 工具区：四个等权线性图标，单行横排 */
.share-tools {
	display: grid;
	grid-template-columns: repeat(4, 1fr);
	gap: 6px;
	margin: 14px 0 4px;
}

.share-tool {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 8px;
	min-height: var(--lnk-touch-target);
	padding: 6px 0;
	background: none;
	border: none;
	color: var(--lnk-text-secondary);
	cursor: pointer;
	touch-action: manipulation;
	-webkit-tap-highlight-color: transparent;
}

.share-tool:disabled {
	opacity: 0.45;
	cursor: not-allowed;
}

.share-tool__icon {
	display: flex;
	width: 40px;
	height: 40px;
	align-items: center;
	justify-content: center;
	border-radius: 50%;
	background: var(--lnk-surface-sunken);
	color: var(--lnk-text-primary);
}

.share-tool__icon svg {
	width: 20px;
	height: 20px;
}

.share-tool__label {
	font-size: var(--lnk-text-2xs);
	white-space: nowrap;
}

.share-chip {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	min-height: var(--lnk-touch-target);
	padding: 6px 14px;
	border-radius: 999px;
	border: 1px solid var(--lnk-accent-border);
	background: var(--lnk-surface-raised);
	color: var(--lnk-text-primary);
	font-size: var(--lnk-text-xs);
	text-decoration: none;
	cursor: pointer;
}

/* 结果视图：一次一屏一件事 */
.share-result {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 12px;
	padding: 8px 0 4px;
}

.share-result__qr {
	width: 220px;
	height: 220px;
	border-radius: var(--lnk-radius-lg);
	background: #fff;
	padding: 8px;
}

.share-result__img {
	max-width: 100%;
	border-radius: var(--lnk-radius-lg);
}

.share-result__tip {
	font-size: var(--lnk-text-xs);
	color: var(--lnk-text-muted);
	text-align: center;
}

.share-result__ops {
	display: inline-flex;
	gap: 10px;
}
</style>
