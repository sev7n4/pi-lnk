/** tier="present" 工具产出的只读可视投影载荷（spec §4.2/§4.3）。 */
export interface SvgCardPayload {
	type: "svg_card";
	svg: string;
	title?: string;
	annotations?: Array<{ nodeId: string; text: string; severity: "info" | "warn" }>;
}
