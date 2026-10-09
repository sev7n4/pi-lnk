/**
 * D3-3 视觉语言 · **单一调色板来源**（规范层，不由模型选）。
 *
 * 复用 #282（neowow-tokens.css）已定的色相，结构按 §4.2 重排：
 * 节点中性白底 + 顶部类型色条（主色）、虚框容器、severity 强调描边。
 * 这是 pi-runtime 侧的唯一真相源；前端 `neowow-tokens.css` 必须引用同一组 hex
 * （§238：静态 SVG 与节点图不得漂移两套逻辑）。
 *
 * 三层配色（PPT 式分工，各层职责不重叠，见 §4.2(1)）：
 * - 主色（类型）：顶部 4px 色条 + 图例。色相见 `expressive.ts` 的 `NODE_PALETTE`。
 * - 强调色（severity）：error 红 / warn 琥珀，仅用于被 `visualRoles` 选中的 ≤10% 节点描边。
 * - 点缀色：图标井底色（当前 SVG 未画图标井，预留常量）。
 */

/** 节点底色：白色，比卡片底亮一档（§4.2(3) 对比度）。 */
export const NODE_FILL = "#FFFFFF";

/**
 * 画布卡片底：白节点的背景。
 *
 * ⛔ **不要指望它与节点底色拉开对比**。实测白底与任何浅灰的天花板只有
 *   1.24:1（#E1E6EC 是我能找到的最深浅灰），任何 ≥3:1 的方案都要把底压到中灰，
 *   那会让容器层（#EEF1F5）比节点还深、层次倒挂。
 *   ⇒ **节点边界靠 `NODE_STROKE` 描边表达，不靠底色差** —— 这是浅色主题下
 *     唯一达标的路径（3.77:1）。底色只负责「白底不至于直接贴在白页上」。
 */
export const CARD_BG = "#F7F8FA";

/** 节点描边（中性）：vs 节点白底 3.77:1、vs 容器底 3.35:1（WCAG 非文本 AA）。 */
export const NODE_STROKE = "#7A8391";

/** 容器（分组/阶段/泳道/矩阵格）填充：比卡片底略深，配虚框。 */
export const CONTAINER_FILL = "#EEF1F5";

/** 容器描边色：刻意比 `NODE_STROKE` 浅 —— 容器不该比节点更显眼。 */
export const CONTAINER_STROKE = "#C9CED6";

/** 容器一律虚线（§4.2(2)：实线会被误读成节点）。 */
export const CONTAINER_DASH = "4 3";

/**
 * 强调色（severity）：仅 error / warn 两档。
 *
 * - `stroke` 用于节点强调描边：error 4.52:1 / warn 4.05:1（on 白底，AA）。
 *   ⚠️ warn 原为 `#E0922A`（3.03:1，贴线）⇒ 已压深。
 * - `badge` 为未来徽章底色，当前未使用。
 *
 * ⚠️ 两档**亮度接近**（互相对比 1.12），靠色相而非亮度区分 —— 这是红/琥珀的
 *   业界惯例（如 GitHub / Jenkins 通知徽标）。断言只要求「色相可分」，
 *   不要用亮度差当验收判据（会逼出一个又暗又看不出是黄色的 warn）。
 */
export const SEVERITY: Record<"error" | "warn", { stroke: string; badge: string }> = {
	error: { stroke: "#E24B4A", badge: "#FCEBEB" },
	warn: { stroke: "#C97A12", badge: "#FDF1E0" },
};

/** 正文/标题文本色：#33414D on #FFFFFF ≥ 4.5:1（WCAG AA，§4.2(3)）。 */
export const TEXT_FILL = "#33414D";

/** 类型色相的「强档」（用于顶部 4px 色条）；取自 NODE_PALETTE 的 strong。 */
export function topBarColorOf(strong: string | undefined, stroke: string): string {
	return strong ?? stroke;
}
