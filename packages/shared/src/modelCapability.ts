import { decodeChannelModel } from './providerChannels'

/**
 * pi 链路「thinkingLevel 是否生效」的判定（= vendored pi 的 `model.reasoning`）。
 *
 * ⚠️ 语义边界（勿与老链路混淆）：
 *  - 这里判的是 **pi-runtime 链路**：`vendor/pi` 的 `models.ts` 有 `if (!model.reasoning) return ["off"]`，
 *    即本函数返回 false 时，前端即便开了「深度思考」，`thinkingLevel` 也会被强制降级为 off（开关无效）。
 *  - **不是**老链路 studio 的 DeepSeek V4 thinking（那条走 `thinking:{type:"enabled"}` + `reasoning_effort`，
 *    由前端 `TextDockPanel` 的 `isDeepSeekV4Model` 单独判定，与本表无关，不要合并）。
 *
 * 红线：判错为 true 会让 pi 给非 reasoning 模型发 `reasoning_effort` → 网关 400，
 * 所以只收「确定支持」的系，拿不准一律 false。
 */
const THINKING_LEVEL_PATTERNS: RegExp[] = [
	/^o[1-9]/i, // o1 / o3 / o4 系
	/^gpt-5/i,
	/deepseek-r1/i,
	/deepseek-reasoner/i,
]

/**
 * @param modelRef `ch_xxx::model-name` 或裸模型名
 */
export function supportsThinkingLevel(modelRef?: string | null): boolean {
	const raw = modelRef?.trim() ?? ''
	if (!raw) return false
	const name = (decodeChannelModel(raw)?.modelName ?? raw).trim().toLowerCase()
	if (!name) return false
	return THINKING_LEVEL_PATTERNS.some((re) => re.test(name))
}
