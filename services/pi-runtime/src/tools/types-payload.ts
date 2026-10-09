/**
 * tier="present" 工具产出的只读可视投影载荷（spec §4.2/§4.3）。
 *
 * 独立成文件是为载荷契约面（前端 `svg_card` 通道）单独成层，**不是**为了避开与
 * `types.ts` 的循环依赖——`types.ts` 只 import vendor 的 `AgentHarnessTool`，
 * 两者之间不存在环。
 */
export interface SvgCardPayload {
	type: "svg_card";
	svg: string;
	title?: string;
	annotations?: Array<{ nodeId: string; text: string; severity: "info" | "warn" }>;
	/**
	 * D4 §4.5：本轮**该呈现哪一种**（`presentResultDual` 双写时两条都带同一个值）。
	 *
	 * 🔴 **必须挂在 command 上，不能只写在 `content` 文本里**——Nest 侧
	 * `extractCanvasCommands` 只从 `result.details.canvasCommands` 提取命令，
	 * 前端 SSE 与落库 `executionEvents` 都只走这条通道（PR #321 的教训：
	 * 写进 `content[0].text` 等于没下发，而当时测试全绿）。
	 *
	 * ⭐ **两条都带同一个 winner 值**（而不是一条 `true` 一条 `false`）：
	 * 前端规则退化成「`preferredKind && preferredKind !== type` ⇒ 跳过」一句，
	 * 无状态、无顺序依赖；而「一条 true 一条 false」在两条都 false 的脏数据下
	 * 会**双双被跳过 ⇒ 静默空白**。当前写法下任一条缺失/非法都只会让那一条退回
	 * 既有优先级，**永远至少渲染一个**。
	 */
	preferredKind?: "svg_card" | "node_graph";
}
