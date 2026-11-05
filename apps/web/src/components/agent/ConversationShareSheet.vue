<script setup lang="ts">
/**
 * 分享面板（Task 4）：唯一基座 = `MobileSheet`。
 *
 * ⚠️ 设计变更（用户裁决 2026-11-05 · iOS 极简哲学）：
 * ① **点分享直接弹本面板**，不再需要「顶栏 ✓ 二次确认」——选择控件（☐ 全选 / ✕ 取消）
 *    直接落在面板顶部，用户一步完成「全选 / 取消」，不割裂。
 * ② **两屏结构（渐进披露）**：
 *    - L0 菜单：选择行（已选 N / M + 全选 / 取消）+ **4 个**动作
 *      （微信 / 复制链接 / 生成图片 / 离线打开）。
 *      朋友圈·QQ·企业微信首期与微信**行为完全相同**（规格 §2：均落地为「二维码+链接」），
 *      却占掉 4 个等权黄金位 ⇒ 收敛掉；其场景由「微信」视图里的大二维码覆盖
 *      （可长按转发给任意人），功能不丢、入口不冗余。
 *    - L1 结果视图：点动作后**替换**内容（二维码大图 / 图片预览），不再把结果
 *      追加在菜单下方（那是「选择器 + 结果同屏」的冗余）。
 * ③ **勾选集真相在页面层**：本面板只消费 `props.turns`（= 当前勾选集映射结果），
 *    并通过 `selectAll` / `clearAll` 事件请页面层改勾选集。
 *
 * ⚠️ 手势安全（spec §4）：复制链接的 `navigator.clipboard.writeText` 必须在点击
 *    同步回调里执行。故面板打开即**预先** upload 缓存托管 URL，点击时直接拿已解析 url
 *    走同步写入；勾选集变化 ⇒ 重新 upload（loading 期间动作禁用，避免用到旧 url）。
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
		/** 分享页可见标题（对话·项目名称）。 */
		title?: string
		/** 当前勾选条数（面板顶部计数）。 */
		selectedCount?: number
		/** 会话总条数（顶部「已选 N / M」）。 */
		totalCount?: number
		modelValue: boolean
	}>(),
	{},
)

const emit = defineEmits<{
	'update:modelValue': [boolean]
	/** 一键全选（页面层改勾选集）。 */
	'selectAll': []
	/** 一键取消全部勾选。 */
	'clearAll': []
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

// 勾选集变化 ⇒ 托管 URL 需重取（旧 url 对应旧集合）
watch(
	() => props.turns,
	() => {
		if (props.modelValue) reupload()
	},
)

async function onCopyLink() {
	if (!shareUrl.value) return
	// 同步手势内写入（composable 内部 await 前的 writeText 已处于手势中）
	await actions.copyLink(shareUrl.value)
	ElMessage.success('链接已复制')
}

/** 微信 / 生成二维码 ⇒ 进入二维码结果视图（替换菜单内容）。 */
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
	view.value === 'qr' ? '微信扫码分享' : view.value === 'image' ? '分享图片' : '分享对话',
)
const sheetSubtitle = computed(() => {
	if (view.value !== 'menu') return ''
	return selectedCount.value > 0 ? `已选 ${selectedCount.value} / ${totalCount.value} 条对话` : '未选择任何对话'
})
</script>

<template>
	<MobileSheet v-if="modelValue" :title="sheetTitle" :subtitle="sheetSubtitle" @close="close">
		<!-- ============ L0 菜单 ============ -->
		<template v-if="view === 'menu'">
			<!-- 选择行：一键全选 / 一键取消（不割裂到二级） -->
			<div class="share-select" data-testid="share-select-row">
				<span class="share-select__count" data-testid="share-selected-count">
					已选 {{ selectedCount }} / {{ totalCount }} 条
				</span>
				<span class="share-select__ops">
					<button
						type="button"
						class="share-chip"
						data-testid="share-select-all"
						:disabled="allSelected || !canShare"
						@click="emit('selectAll')"
					>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
							<rect x="4" y="4" width="16" height="16" rx="4" />
							<path stroke-linecap="round" stroke-linejoin="round" d="M8 12.4l2.8 2.8L16 9.6" />
						</svg>
						<span>全选</span>
					</button>
					<button
						type="button"
						class="share-chip"
						data-testid="share-select-clear"
						:disabled="!canShare"
						@click="emit('clearAll')"
					>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
							<path stroke-linecap="round" d="M6 6l12 12M18 6L6 18" />
						</svg>
						<span>取消</span>
					</button>
				</span>
			</div>

			<div v-if="uploading" class="share-hint">正在生成分享链接…</div>
			<div v-else-if="!canShare" class="share-hint">请先在对话页勾选要分享的对话</div>

			<!-- 4 个动作（2×2）：微信 / 复制链接 / 生成图片 / 离线打开 -->
			<div class="share-grid" data-testid="share-menu">
				<button
					type="button"
					class="share-action share-action--wechat"
					:disabled="!linkReady"
					data-testid="mode-wechat"
					@click="onOpenQr"
				>
					<span class="share-action__icon">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
							<path stroke-linecap="round" stroke-linejoin="round" d="M4 5h16v11H8l-4 4V5z M8 9h8 M8 12h5" />
						</svg>
					</span>
					<span class="share-action__label">微信</span>
				</button>
				<button
					type="button"
					class="share-action"
					:disabled="!linkReady"
					data-testid="mode-link"
					@click="onCopyLink"
				>
					<span class="share-action__icon">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
							<path stroke-linecap="round" stroke-linejoin="round" d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 1 0-5.66-5.66l-1 1 M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 1 0 5.66 5.66l1-1" />
						</svg>
					</span>
					<span class="share-action__label">复制链接</span>
				</button>
				<button
					type="button"
					class="share-action"
					:disabled="busy || !canShare"
					data-testid="mode-image"
					@click="onMakeImage"
				>
					<span class="share-action__icon">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
							<path stroke-linecap="round" stroke-linejoin="round" d="M4 5h16v14H4z M4 15l4-4 4 4 3-3 5 5 M9 9a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z" />
						</svg>
					</span>
					<span class="share-action__label">生成图片</span>
				</button>
				<button
					type="button"
					class="share-action"
					:disabled="busy || !canShare"
					data-testid="mode-offline"
					@click="onOpenOffline"
				>
					<span class="share-action__icon">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
							<path stroke-linecap="round" stroke-linejoin="round" d="M12 3v12 M8 11l4 4 4-4 M5 21h14" />
						</svg>
					</span>
					<span class="share-action__label">离线打开</span>
				</button>
			</div>
		</template>

		<!-- ============ L1 二维码结果视图（替换菜单） ============ -->
		<template v-else-if="view === 'qr'">
			<div class="share-result" data-testid="share-qr">
				<img v-if="actions.qrDataUrl.value" :src="actions.qrDataUrl.value" alt="分享二维码" class="share-result__qr" />
				<p class="share-result__tip">微信扫码打开分享页（长按二维码可发给任意好友）</p>
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

/* 选择行：计数 + 一键全选/取消 */
.share-select {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 10px;
	padding: 8px 0 10px;
	border-bottom: 1px solid var(--lnk-border-subtle);
	margin-bottom: 4px;
}

.share-select__count {
	font-size: var(--lnk-text-sm);
	color: var(--lnk-text-secondary);
}

.share-select__ops {
	display: inline-flex;
	gap: 8px;
}

.share-chip {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	padding: 6px 10px;
	border-radius: 999px;
	border: 1px solid var(--lnk-accent-border);
	background: var(--lnk-surface-raised);
	color: var(--lnk-text-primary);
	font-size: var(--lnk-text-xs);
	cursor: pointer;
}

.share-chip svg {
	width: 14px;
	height: 14px;
}

.share-chip:disabled {
	opacity: 0.45;
	cursor: not-allowed;
}

/* 动作网格：2×2（同权动作 ≤4） */
.share-grid {
	display: grid;
	grid-template-columns: repeat(2, 1fr);
	gap: 10px;
	margin: 12px 0 4px;
}

.share-action {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 6px;
	padding: 12px 0 10px;
	background: var(--lnk-surface-raised);
	border: 1px solid var(--lnk-accent-border);
	border-radius: 12px;
	cursor: pointer;
	color: var(--lnk-text-primary);
}

.share-action:disabled {
	opacity: 0.45;
	cursor: not-allowed;
}

.share-action__icon {
	width: 40px;
	height: 40px;
	border-radius: 50%;
	display: flex;
	align-items: center;
	justify-content: center;
	background: var(--lnk-surface-sunken);
	color: var(--lnk-text-primary);
}

.share-action__icon svg {
	width: 20px;
	height: 20px;
}

/* 微信渠道：品牌色（identity 色，非主题令牌），收敛为唯一渠道入口 */
.share-action--wechat .share-action__icon {
	background: #07c160;
	color: #fff;
}

.share-action__label {
	font-size: var(--lnk-text-xs);
	color: var(--lnk-text-secondary);
}

/* 结果视图：一次一屏一件事 */
.share-result {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 10px;
	padding: 8px 0 4px;
}

.share-result__qr {
	width: 220px;
	height: 220px;
	border-radius: 12px;
	background: #fff;
	padding: 8px;
}

.share-result__img {
	max-width: 100%;
	border-radius: 12px;
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
