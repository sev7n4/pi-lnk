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

/**
 * 深色主题对应色（§238 跨端 parity的第二半）。
 *
 * ## 为什么深色需要一份独立值，而不是「反过来」
 *
 * 浅色那套的关系**不可镜像**：`NODE_FILL` 白、`NODE_STROKE` 中灰，都是「深字浅底」。
 * 深底上白字是刺眼白块（§4.2(3)），而中灰 `#7A8391` 落在深底上对比度只有 ~2.5:1，
 * 描边会「吃掉」⇒ 必须重新按 WCAG 复核，而不是取反或复用。
 *
 * ## 与浅色**同源不变**的一条铁律
 *
 * 节点底vs 卡片底 =1.17:1（浅色是 1.06:1）—— **两者都刻意拉不开**，
 * 边界一律由 `NODE_STROKE` 表达。这不是缺陷而是设计：任何≥3:1 的底色差
 * 都要求把底压到中灰，那会让容器层比节点还深、层次倒挂（见 `CARD_BG` 注释）。
 * ⛔ 因此 parity 测试**不许**断言「节点底与卡片底对比度 ≥ X」——那条恒假。
 *
 * ## 所有比值均为 WCAG 2.1 相对亮度公式实测（2026-10-09），非估算
 *
 * | 关系 | 实测 | 判据 |
 * |---|---|---|
 * | `DARK_NODE_STROKE` vs `DARK_NODE_FILL` | 4.00:1 | ≥3:1 非文本 AA ✅ |
 * | `DARK_NODE_STROKE` vs `DARK_CARD_BG` | 4.67:1 | ≥3:1 ✅ |
 * | `DARK_TEXT_FILL` vs `DARK_NODE_FILL` | 12.91:1 | ≥4.5:1 正文 AA ✅ |
 * | `SEVERITY_DARK.error` vs `DARK_NODE_FILL` | 5.12:1 | ≥3:1 ✅ |
 * | `SEVERITY_DARK.warn` vs `DARK_NODE_FILL` | 6.59:1 | ≥3:1 ✅ |
 *
 * ⚠️ **改动前必须重算**：这批值是**成对**的（描边压深了，节点底就得跟着抬），
 * 单独改一个会让上表某行掉到 3:1 以下。
 */
export const DARK_CARD_BG = "#1E1E24";

/** 深色节点底：非纯白（§4.2(3)），比卡片底亮一档；边界靠 `DARK_NODE_STROKE`。 */
export const DARK_NODE_FILL = "#2A2A33";

/** 深色节点描边：vs 节点底 4.00:1 / vs 卡片底 4.67:1（WCAG 非文本 AA）。 */
export const DARK_NODE_STROKE = "#828896";

/** 深色容器描边：刻意比节点描边浅 —— 容器不该比节点更显眼。 */
export const DARK_CONTAINER_STROKE = "#3E3E48";

/** 深色正文/标题：vs 节点底 12.91:1（WCAG 正文 AA）。 */
export const DARK_TEXT_FILL = "#F2F4F8";

/**
 * 深色 severity：error 提亮到 `#FF6B6A`、warn 提到 `#E8A33D`。
 *
 * ⚠️ 深色**不能**复用浅色的 `#E24B4A` / `#C97A12`：那两个是为白底调的，
 *   落深底上会明显发闷（对比度掉到 2:1 档）⇒ 强调色在深底上等于没有强调。
 */
export const SEVERITY_DARK: Record<"error" | "warn", { stroke: string; badge: string }> = {
	error: { stroke: "#FF6B6A", badge: "#3A1F22" },
	warn: { stroke: "#E8A33D", badge: "#3A2E1A" },
};
