<script setup lang="ts">
/**
 * 分享面板（Task 4）：唯一基座 = `MobileSheet`。
 * 两行网格：行1 品牌渠道（微信/朋友圈/QQ/企业微信，首期同落「二维码+链接」）；
 *           行2 功能（生成图片/复制链接/生成二维码/离线打开）。
 *
 * ⚠️ 设计变更（用户裁决）：**本面板不再内联可选对话记录**。勾选集合由「对话页面本体」
 * 上的操作入口决定 —— 回合级分享钮（每条助手消息操作栏的「分享」）即「单选」操作：
 * 点哪条，就把哪条作为唯一选中项带入本面板；会话级「分享会话」则带入全部回合。
 * 因此本面板直接消费 `props.turns`（已是页面侧选定的最终集合），不再二次筛选。
 *
 * ⚠️ 手势安全（spec §4）：复制链接的 `navigator.clipboard.writeText` 必须在点击
 *    同步回调里执行。故面板打开即**预先** `upload` 缓存托管 URL，
 *    点击时直接拿已解析 url 走同步写入，避免 `await` 后丢失 iOS 手势。
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
		modelValue: boolean
	}>(),
	{},
)

const emit = defineEmits<{ 'update:modelValue': [boolean] }>()

const actions = useShareActions()

const busy = ref(false)
const uploading = ref(false)
const shareUrl = ref<string | null>(null)
const qrVisible = ref(false)
const imagePreview = ref<string | null>(null)

const linkReady = computed(() => !!shareUrl.value && !uploading.value && !busy.value)

function reset() {
	qrVisible.value = false
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
		.upload(props.turns, props.sessionId)
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

async function onCopyLink() {
	if (!shareUrl.value) return
	// 同步手势内写入（composable 内部 await 前的 writeText 已处于手势中）
	await actions.copyLink(shareUrl.value)
	ElMessage.success('链接已复制')
}

function onShareViaQr() {
	if (!shareUrl.value) return
	actions.showQr(shareUrl.value)
	qrVisible.value = true
}

async function onOpenOffline() {
	busy.value = true
	try {
		await actions.openOffline(props.turns)
	} finally {
		busy.value = false
	}
}

async function onMakeImage() {
	busy.value = true
	try {
		imagePreview.value = await actions.toImage(props.turns)
	} finally {
		busy.value = false
	}
}

// 行1 品牌渠道：首期一律走二维码+链接
const brandModes = [
	{ key: 'wechat', label: '微信', color: 'var(--brand-wechat)', onClick: onShareViaQr },
	{ key: 'moments', label: '朋友圈', color: 'linear-gradient(135deg,#FFCD41,#FB7299)', onClick: onShareViaQr },
	{ key: 'qq', label: 'QQ', color: 'var(--brand-qq)', onClick: onShareViaQr },
	{ key: 'workwx', label: '企业微信', color: 'var(--brand-workwx)', onClick: onShareViaQr },
]
</script>

<template>
	<MobileSheet v-if="modelValue" title="分享对话" :subtitle="`将分享 ${props.turns.length} 条对话`" @close="close">
		<div v-if="uploading" class="share-hint">正在生成分享链接…</div>

		<!-- 行1 品牌渠道 -->
		<div class="share-row" data-testid="share-row-brand">
			<button
				v-for="m in brandModes"
				:key="m.key"
				type="button"
				class="share-mode"
				:disabled="!linkReady"
				:data-testid="`mode-${m.key}`"
				@click="m.onClick"
			>
				<span class="share-icon" :style="{ background: m.color }">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							d="M4 5h16v11H8l-4 4V5z M8 9h8 M8 12h5"
						/>
					</svg>
				</span>
				<span class="share-label">{{ m.label }}</span>
			</button>
		</div>

		<!-- 行2 功能 -->
		<div class="share-row" data-testid="share-row-func">
			<button type="button" class="share-mode" :disabled="busy" data-testid="mode-image" @click="onMakeImage">
				<span class="share-icon share-icon-func">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
						<path stroke-linecap="round" stroke-linejoin="round" d="M4 5h16v14H4z M4 15l4-4 4 4 3-3 5 5 M9 9a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z" />
					</svg>
				</span>
				<span class="share-label">生成图片</span>
			</button>
			<button type="button" class="share-mode" :disabled="!linkReady" data-testid="mode-link" @click="onCopyLink">
				<span class="share-icon share-icon-func">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
						<path stroke-linecap="round" stroke-linejoin="round" d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 1 0-5.66-5.66l-1 1 M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 1 0 5.66 5.66l1-1" />
					</svg>
				</span>
				<span class="share-label">复制链接</span>
			</button>
			<button type="button" class="share-mode" :disabled="!linkReady" data-testid="mode-qr" @click="onShareViaQr">
				<span class="share-icon share-icon-func">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
						<path stroke-linecap="round" stroke-linejoin="round" d="M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h2v2h-2z M18 14h2v2h-2z M14 18h2v2h-2z M18 18h2v2h-2z" />
					</svg>
				</span>
				<span class="share-label">生成二维码</span>
			</button>
			<button type="button" class="share-mode" :disabled="busy" data-testid="mode-offline" @click="onOpenOffline">
				<span class="share-icon share-icon-func">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
						<path stroke-linecap="round" stroke-linejoin="round" d="M12 3v12 M8 11l4 4 4-4 M5 21h14" />
					</svg>
				</span>
				<span class="share-label">离线打开</span>
			</button>
		</div>

		<!-- 二维码展开区 -->
		<div v-if="qrVisible && actions.qrDataUrl.value" class="share-qr" data-testid="share-qr">
			<img :src="actions.qrDataUrl.value" alt="分享二维码" class="share-qr-img" />
			<p class="share-qr-tip">微信扫码打开分享页，或点击下方复制链接</p>
			<button
				v-if="shareUrl"
				type="button"
				class="share-qr-copy"
				data-testid="qr-copy"
				@click="onCopyLink"
			>
				复制链接
			</button>
		</div>

		<!-- 图片预览区 -->
		<div v-if="imagePreview" class="share-img" data-testid="share-img">
			<img :src="imagePreview" alt="对话图片" />
			<a :href="imagePreview" download="conversation.png" class="share-img-dl" data-testid="img-dl">保存到相册</a>
		</div>
	</MobileSheet>
</template>

<style scoped>
.share-hint {
	font-size: var(--lnk-text-xs);
	color: var(--lnk-text-muted);
	text-align: center;
	margin: 4px 0;
}
.share-row {
	display: grid;
	grid-template-columns: repeat(4, 1fr);
	gap: 10px;
	margin: 10px 0;
}
/* 品牌色仅用于社交渠道图标（identity 色，非主题令牌），收敛到本行作用域 */
.share-row[data-testid='share-row-brand'] {
	--brand-wechat: #07c160;
	--brand-qq: #12b7f5;
	--brand-workwx: #2e7fff;
}
.share-mode {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 6px;
	background: none;
	border: none;
	cursor: pointer;
	color: var(--lnk-text-secondary);
}
.share-mode:disabled {
	opacity: 0.45;
	cursor: not-allowed;
}
.share-icon {
	width: 44px;
	height: 44px;
	border-radius: 50%;
	display: flex;
	align-items: center;
	justify-content: center;
	color: #fff;
}
.share-icon svg {
	width: 22px;
	height: 22px;
}
.share-icon-func {
	background: var(--lnk-surface-raised);
	color: var(--lnk-text-primary);
	border: 1px solid var(--lnk-accent-border);
}
.share-label {
	font-size: var(--lnk-text-xs);
}
.share-qr {
	text-align: center;
	padding: 12px 0;
}
.share-qr-img {
	width: 180px;
	height: 180px;
	border-radius: 12px;
	background: #fff;
	padding: 8px;
}
.share-qr-tip {
	font-size: var(--lnk-text-xs);
	color: var(--lnk-text-muted);
	margin: 8px 0;
}
.share-qr-copy {
	background: var(--lnk-accent);
	color: var(--lnk-text-on-accent);
	border: none;
	border-radius: 8px;
	padding: 8px 16px;
	font-size: var(--lnk-text-sm);
	cursor: pointer;
}
.share-img {
	text-align: center;
	padding: 12px 0;
}
.share-img img {
	max-width: 100%;
	border-radius: 12px;
}
.share-img-dl {
	display: inline-block;
	margin-top: 8px;
	color: var(--lnk-accent-text);
	font-size: var(--lnk-text-sm);
}
</style>
