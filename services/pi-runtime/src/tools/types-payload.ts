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
}
