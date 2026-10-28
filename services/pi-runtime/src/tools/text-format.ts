/**
 * 文本节点格式白名单（runtime 本地副本）。
 * ⚠️ pi-runtime 无 @lnkpi/shared 依赖（有意决策，见 agent-canvas-tools.service.ts:1462 注释）。
 * SSOT 在 packages/shared/src/textNodeFormat.ts；两侧一致性由
 * canvas-write.contract-mirror.test.ts 的镜像断言守卫（漂移即红），改任一侧必须同步另一侧。
 */
export const TEXT_NODE_FORMATS = ["plain", "markdown", "html"] as const;
export type TextNodeFormat = (typeof TEXT_NODE_FORMATS)[number];

const FORMAT_SET: ReadonlySet<string> = new Set(TEXT_NODE_FORMATS);

/** 写入侧白名单 fail-closed：非法值 throw，错误信息列合法值（与 shared assertTextNodeFormat 同语义）。 */
export function assertTextNodeFormat(v: unknown): asserts v is TextNodeFormat {
	if (typeof v !== "string" || !FORMAT_SET.has(v)) {
		throw new Error(`invalid text node format "${String(v)}" (allowed: ${TEXT_NODE_FORMATS.join(", ")})`);
	}
}
