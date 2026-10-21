/**
 * 画布分组工具组（2026-10-21）：`group_nodes` / `ungroup_group` / `set_group_color`。
 *
 * ## ⛔ 为什么走 canvas_command（前端执行）而不是 Nest 端点
 *
 * 服务端**已经有**完整的三个端点（`/agent/internal/group-nodes` 等，
 * `agent-canvas-tools.controller.ts:1468/1474/1480`，service `:2590/2606/2620`），
 * 但本工具**刻意不直接调它们写库**，原因是一条会静默丢数据的整份覆盖语义：
 *
 *   `saveCanvas()` 是**整份替换**（`CanvasPage.vue:4310-4353`：foldGroups → PUT
 *   `/sessions/:id`；`sessions.service.ts:88` 同样整份 update）。而服务端
 *   `groupNodes` 返回 `actions: []` —— 不发 SSE、不通知前端，前端内存态里
 *   **永远不会出现这个 group 节点**。
 *   ⇒ Agent 建组成功后，用户做任何一次编辑（拖个节点、改个字）触发保存，
 *     前端用自己那份「没有该组」的内存态整份覆盖 ⇒ **Agent 刚建的组被无声抹掉**。
 *
 * 同理 `ungroup_group`：服务端拆了组，但前端内存里那个 group 节点还在，
 * 下次保存 `foldGroups` 又把它**重建**回去。
 *
 * 正解（= `arrange_nodes` 的既定范式）：命令下发到前端，前端算完写自己活动态
 * `nodes.value` 再 `persistUserEdit()`，天然落 undo 栈 + 落库，与用户手动操作同一条路。
 *
 * ## L2 只读校验（尽力而为，不阻断）
 *
 * 注入**只读** NestClient，execute 内先 `get_canvas_layout` 校验：
 *   - node_ids 是否真实存在（不存在的不进命令，missing 回给模型）；
 *   - 打组是否够 2 个未分组节点（前端 `createGroupFromSelection` 也会判，
 *     这里提前判是为了让模型拿到**可纠错**的结论而不是"点了没反应"）；
 *   - group_id 是否真实存在。
 * Nest 读失败（超时/熔断/包络错）一律**按入参原样下发并标 verified=false**，
 * 绝不因校验把单向 UI 命令拖成阻塞或失败（同 arrange_nodes 的纪律）。
 *
 * ## 参数命名口径
 *
 * 工具参数一律 snake_case（`node_ids`），Nest DTO 用 camelCase，转换在 execute 内手写
 * —— 与 canvas-write.ts 全系列一致。`sessionId`/`userId` 只从 `tc` 取，**绝不让模型传**
 * （防越权）。色键 8 键白名单在本地就收（`GROUP_COLOR_KEYS`），不把非法值发到前端。
 */
import { Type } from "typebox";
import type { LnkpiTool, LnkpiToolContext } from "./types.js";
import type { NestClient } from "./nest-client.js";

/** get_canvas_layout 只取用到的字段。 */
interface CanvasLayoutSnapshot {
	nodes?: Array<{ id?: string }>;
	groups?: Array<{ id?: string; title?: string; childIds?: string[]; colorKey?: string }>;
}

/**
 * 分组色键白名单（与 `packages/shared/src/canvasGroup.ts` 的 GROUP_COLOR_KEYS 同源）。
 *
 * 这里是**镜像**而非 import：pi-runtime 的依赖面刻意不含 `@lnkpi/shared`
 * （见 services/pi-runtime/package.json），加进来会拖入整个 zod 依赖树。
 * `canvas-group.contract.test.ts` 会断言两份列表逐项一致，防漂移。
 */
export const GROUP_COLOR_KEYS = [
	"neutral",
	"moss",
	"dusk",
	"clay",
	"celadon",
	"graphite",
	"rose",
	"plum",
] as const;

/** 单向 UI 命令的统一返回形态（与 arrange_nodes 的 uiResult 同构）。 */
function uiResult(payload: Record<string, unknown>, commands: unknown[]): {
	content: [{ type: "text"; text: string }];
	details: { ok: true; canvasCommands: unknown[]; affectedCount: number; _signal: { status: "ok" } };
} {
	return {
		content: [{ type: "text", text: JSON.stringify({ ok: true, ...payload, canvasCommands: commands }) }],
		details: { ok: true, canvasCommands: commands, affectedCount: 1, _signal: { status: "ok" } },
	};
}

/** 清洗模型给的 node_ids：去非字符串、去空、去重（模型经常重复传同一个 id）。 */
function cleanIds(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	return [...new Set(raw.filter((id): id is string => typeof id === "string" && id.length > 0))];
}

/**
 * Agent 侧生成分组 id。
 *
 * ⭐ 为什么 Agent 必须自己生成（2026-10-21）：
 * `canvas_command` 是**单向 SSE 下发**（pi-runtime → Nest pi-events → 前端 SSE），
 * **没有回传通道**。而分组 id 原本由前端生成（`group-${Date.now().toString(36)}`）
 * ⇒ Agent 建完组**永远拿不到自己的组 id** ⇒ 后续 `set_group_color` / `ungroup_group`
 * 无从下手（「建组→改色」这条最自然的链路直接断掉）。
 *
 * ⇒ 由 Agent 侧生成并随命令下发，前端照用（前端对撞号/空串会自行回退，
 * 见 `useCanvasGrouping.ts` 的 `createGroupFromSelection`）。
 *
 * 格式与前端口径一致（`group-` + base36 时间戳），但**多带一个随机后缀**：
 * 同一毫秒内连建两个组时纯时间戳会撞号。
 */
function makeGroupId(): string {
	return `group-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 只读画布快照（尽力而为）。读失败返回 null，调用方按 verified=false 处理。
 * ⛔ 只调 GET 语义的 get-canvas-layout，绝不在这里写库。
 */
async function readLayout(client: NestClient | undefined, tc: LnkpiToolContext | undefined) {
	if (!client || !tc?.sessionId) return null;
	try {
		return (await client.post("/agent/internal/get-canvas-layout", {
			sessionId: tc.sessionId,
		})) as CanvasLayoutSnapshot | null;
	} catch {
		// 校验失败不阻断：单向 UI 命令不因读失败而失败
		return null;
	}
}

export function createCanvasGroupTools(client?: NestClient): LnkpiTool[] {
	return [
		{
			tier: "ui_command" as const,
			name: "group_nodes",
			label: "打组",
			description:
				"把若干个画布节点框进一个分组框（分组是围绕节点的框，可整体拖动/改色/解组）。" +
				"【何时该用】用户想把一批节点归到一起、或给这批节点起个名字当一个整体管理时，" +
				"例如「把这几个节点打组」「把选中的节点归到一个组」「框起来」——" +
				"只要用户想对**多个已有节点做集合化管理**就用本工具。" +
				"至少 2 个节点才成立；已分组节点会被归并进同名组。**只圈住现有节点、不改坐标**。" +
				"【何时不该用】要新建节点用 upsert_media_node；要改单节点文字用 set_node_text；" +
				"只是想调整位置用 arrange_nodes（打组不动坐标）——" +
				"⚠️ 分组不是节点类型，所以**不能用 add_node / upsert_media_node 建组**，只能走本工具。" +
				"node_ids 从 get_canvas_summary 的 nodes[].id 读。" +
				"【建组之后】返回值里的 groupId 就是这个组的 id，后续改色用 set_group_color、解组用 ungroup_group。",
			parameters: Type.Object({
				node_ids: Type.Array(Type.String(), {
					description: "Canvas node ids to put into one group; at least 2 required",
				}),
				title: Type.Optional(Type.String({ description: "Optional group title; defaults to 未命名分组" })),
			}),
			execute: async (_id, p: { node_ids: string[]; title?: string }, _onUpdate, tc?: LnkpiToolContext) => {
				const requested = cleanIds(p.node_ids);
				// 命令侧硬下限：前端 createGroupFromSelection 也会判，但提前拒能让模型拿到明确结论
				if (requested.length < 2) {
					return {
						content: [{ type: "text", text: JSON.stringify({
							ok: false,
							error: "至少需要 2 个节点才能打组",
							received: requested.length,
						}) }],
						details: { ok: false, canvasCommands: [], affectedCount: 0, _signal: { status: "rejected", reason: "below_two_nodes" } },
					};
				}

				const layout = await readLayout(client, tc);
				let nodeIds = requested;
				let missing: string[] = [];
				let verified = false;
				if (layout) {
					const known = new Set(
						(layout.nodes ?? []).map((n) => n?.id).filter((id): id is string => typeof id === "string"),
					);
					missing = requested.filter((id) => !known.has(id));
					nodeIds = requested.filter((id) => known.has(id));
					verified = true;
					// ⛔ 过滤后不足 2 个 ⇒ **不满足打组条件**。
					// 硬下限只查了「模型给了几个」，但模型可能给了 3 个 id、其中 2 个
					// 在画布上不存在 ⇒ 实际能组的只有 1 个。此时若照发命令，
					// 前端会因「少于 2 个」静默拒绝，Agent 却拿到 ok:true、grouped:1
					// ⇒ 模型以为「组建好了但只组进 1 个」，下一轮改色会扑空。
					// 这里给出可纠错结论（缺哪些、还差几个）。
					if (nodeIds.length < 2) {
						return {
							content: [{ type: "text", text: JSON.stringify({
								ok: false,
								error: `可分组的节点不足 2 个（请求 ${requested.length} 个，其中 ${missing.length} 个在画布上不存在，实际可用 ${nodeIds.length} 个）`,
								requested,
								missing,
								available: nodeIds,
							}) }],
							details: { ok: false, canvasCommands: [], affectedCount: 0, _signal: { status: "rejected", reason: "below_two_nodes" } },
						};
					}
				}

				const title = typeof p.title === "string" && p.title.trim() ? p.title.trim() : undefined;
				// ⭐ Agent 侧生成 group_id 并随命令下发 —— canvas_command 无回传通道，
				// 前端自生成的 id Agent 拿不到 ⇒ 「建组→改色/解组」会断链。
				// 返回值里也带上它，模型同一轮就能接着调 set_group_color / ungroup_group。
				const groupId = makeGroupId();
				return uiResult(
					{
						requested: requested.length,
						grouped: nodeIds.length,
						missing,
						verified,
						groupId,
						...(title ? { title } : {}),
					},
					[{ type: "group_nodes", nodeIds, groupId, ...(title ? { title } : {}) }],
				);
			},
		},
		{
			tier: "ui_command" as const,
			name: "ungroup_group",
			label: "解组",
			description:
				"解散一个分组框（框消失，里面的节点保持原位、留在画布上）。" +
				"【何时该用】用户想取消分组、或把组里的节点放回画布自由编辑时，" +
				"例如「解组」「取消分组」「把组散开」。" +
				"⚠️ 解组**不会删除节点**，只是去掉外框、节点留在画布原位；要删节点用 delete_nodes。" +
				"group_id 从 get_canvas_summary 返回的 groups[].id 读。",
			parameters: Type.Object({
				group_id: Type.String({ description: "Group id from get_canvas_summary groups[].id" }),
			}),
			execute: async (_id, p: { group_id: string }, _onUpdate, tc?: LnkpiToolContext) => {
				const groupId = typeof p.group_id === "string" ? p.group_id : "";
				if (!groupId) {
					return {
						content: [{ type: "text", text: JSON.stringify({ ok: false, error: "group_id 不能为空" }) }],
						details: { ok: false, canvasCommands: [], affectedCount: 0, _signal: { status: "rejected", reason: "missing_group_id" } },
					};
				}

				const layout = await readLayout(client, tc);
				let verified = false;
				let exists = false;
				let childIds: string[] = [];
				if (layout) {
					const g = (layout.groups ?? []).find((x) => x?.id === groupId);
					exists = Boolean(g);
					childIds = Array.isArray(g?.childIds) ? g.childIds.filter((c): c is string => typeof c === "string") : [];
					verified = true;
					if (!exists) {
						// 分组确实不存在 ⇒ 不发命令（前端会静默返回，模型拿不到结论）
						return {
							content: [{ type: "text", text: JSON.stringify({
								ok: false,
								error: `分组不存在：${groupId}`,
								availableGroups: (layout.groups ?? []).map((x) => ({ id: x?.id, title: x?.title })),
							}) }],
							details: { ok: false, canvasCommands: [], affectedCount: 0, _signal: { status: "rejected", reason: "group_not_found" } },
						};
					}
				}

				return uiResult(
					{ groupId, exists, releasedNodes: childIds.length, verified },
					[{ type: "ungroup_group", groupId }],
				);
			},
		},
		{
			tier: "ui_command" as const,
			name: "set_group_color",
			label: "改分组色",
			description:
				"设置一个分组框的背景颜色（8 种低饱和预设色之一）。" +
				"【何时该用】用户要给分组框换个颜色做区分时，例如「把这个组设成红色」「组框改成绿色」。" +
				`可用色键：${GROUP_COLOR_KEYS.join(" / ")}。` +
				"⚠️ 省略 color_key 或传 null 表示**复位默认色**（中性灰），不是不变。" +
				"group_id 从 get_canvas_summary 返回的 groups[].id 读。" +
				"改完立刻可见（框的底色与虚线边都会变）。",
			parameters: Type.Object({
				group_id: Type.String({ description: "Group id from get_canvas_summary groups[].id" }),
				color_key: Type.Optional(
					Type.Union([Type.String(), Type.Null()], {
						description: `One of: ${GROUP_COLOR_KEYS.join(" / ")}. Omit or null resets to the default neutral color.`,
					}),
				),
			}),
			execute: async (_id, p: { group_id: string; color_key?: string | null }, _onUpdate, tc?: LnkpiToolContext) => {
				const groupId = typeof p.group_id === "string" ? p.group_id : "";
				if (!groupId) {
					return {
						content: [{ type: "text", text: JSON.stringify({ ok: false, error: "group_id 不能为空" }) }],
						details: { ok: false, canvasCommands: [], affectedCount: 0, _signal: { status: "rejected", reason: "missing_group_id" } },
					};
				}

				// 色键白名单在**工具侧**就拒：非法键不该发到前端让渲染层静默落 neutral
				// （那正是 2026-10-21 修掉的「设了没反应」缺陷）。此处拒绝能给出可纠错结论。
				const raw = p.color_key;
				const isReset = raw === null || raw === undefined || raw === "";
				const colorKey = raw === undefined || raw === null ? null : String(raw).trim();
				if (!isReset && !(GROUP_COLOR_KEYS as readonly string[]).includes(colorKey as string)) {
					return {
						content: [{ type: "text", text: JSON.stringify({
							ok: false,
							error: `非法的分组色键「${colorKey}」`,
							available: [...GROUP_COLOR_KEYS],
						}) }],
						details: { ok: false, canvasCommands: [], affectedCount: 0, _signal: { status: "rejected", reason: "invalid_color_key" } },
					};
				}

				const layout = await readLayout(client, tc);
				let verified = false;
				if (layout) {
					verified = true;
					if (!(layout.groups ?? []).some((g) => g?.id === groupId)) {
						return {
							content: [{ type: "text", text: JSON.stringify({
								ok: false,
								error: `分组不存在：${groupId}`,
								availableGroups: (layout.groups ?? []).map((x) => ({ id: x?.id, title: x?.title })),
							}) }],
							details: { ok: false, canvasCommands: [], affectedCount: 0, _signal: { status: "rejected", reason: "group_not_found" } },
						};
					}
				}

				return uiResult(
					{ groupId, colorKey: isReset ? null : colorKey, reset: isReset, verified },
					[{ type: "set_group_color", groupId, colorKey: isReset ? null : colorKey }],
				);
			},
		},
	];
}