/** isError 语义补正（spec 2026-11-14-iserror-rejection-flag-design.md）。
 *
 * 根因：vendor 0.99.2 `harness/execution/tools.ts:148` 的 `executeToolCall` 恒返回
 * `{result, isError:false}`，**不消费 `AgentToolResult.isError`**；`createToolResultMessage`
 * 只从 `finalizeToolCall` 的 `patch?.isError ?? executed.isError` 取值（`:178/:202`）。
 * ⇒ `todo_write` 的硬拒虽然语义上是错误，transcript / `tool_execution_end` 事件里却是
 * `isError:false`，前端把「调用被拒绝」显示成一次成功工具调用。
 *
 * 补正：用 vendor 一等机制 `after_tool` 的 patch 能力（`hooks.ts:316` 聚合 `isError`），
 * 在 `drive/tools.ts:412-433` 的时序里（patch 早于 message 生成）把标志打成 true。
 *
 * ⚠️ 收益定位：生产走 `openai-completions`（`model-assembly.ts:88/102`），该适配器
 * `openai-completions.ts:1398+` 把 toolResult 转成 `role:"tool"` 时**只取 content 文本**、
 * 丢弃 isError ⇒ **模型看不到本补正**。硬拒对模型生效靠的是 content 拒绝文本
 * （A-2' 生产自纠 1/1 已证），本刀不宣称改善模型行为、不改任何文案。
 */
import { readBooleanField, readRecord } from "./hook-contract.js";

/** 窄面注册器（同 result-signal-wiring.ts 范式）：不依赖 AgentHarness 泛型，
 *  真实 HookRegistry 与测试 FakeHooks 都可结构赋值；本机陈旧 0.85.1 类型亦兼容。 */
export interface RejectionFlagToolEvent {
	toolName: string;
	details?: unknown;
}
export interface RejectionFlagHooksRegistrar {
	on(name: "after_tool", handler: (event: RejectionFlagToolEvent) => unknown): () => void;
}

/** kill switch：off = 不注册 listener，transcript/事件/前端逐字节回到本刀前行为。 */
export function isToolRejectionFlagEnabled(): boolean {
	return process.env.PI_RUNTIME_REJECTION_FLAG !== "off";
}

/** 纯判定：唯一的硬拒信号是 `details.todo.rejected === true`（rejectionResult 单点写入）。
 *  不用 content 文本匹配（文案属模型行为契约），不用 `diff.updates=[]` 推断（合法清空也命中）。
 *  形态不符一律 fail-soft 返回 false。 */
export function shouldFlagRejection(details: unknown): boolean {
	const rec = readRecord(details, "after_tool.details");
	if (!rec.ok) return false;
	const todo = readRecord(rec.value.todo, "after_tool.details.todo");
	if (!todo.ok) return false;
	const flag = readBooleanField(todo.value, "rejected", "after_tool.details.todo.rejected");
	return flag.ok && flag.value === true;
}

/** ⭐ 注册序即正确性：必须在 `registerCanvasIdBindingHooks` 及所有既有 after_tool
 *  listener **之前**调用 —— HookMap 多 listener 链式 replace（`hooks.ts:310/322`），
 *  后注册者才会看到 `event.isError=true` 并让自身的 `!event.isError` 分支正确短路。 */
export function registerToolRejectionFlag(hooks: RejectionFlagHooksRegistrar | undefined): void {
	if (!isToolRejectionFlagEnabled()) return;
	// fail-soft：测试注入的 fake harness 可能只有 events 没有 hooks（session-manager.ts:1710 同款纪律）
	if (!hooks) return;
	hooks.on("after_tool", (event) => {
		if (event.toolName !== "todo_write") return undefined;
		return shouldFlagRejection(event.details) ? { isError: true } : undefined;
	});
}
