/**
 * 分组工具组契约测试（2026-10-21）。
 *
 * 覆盖三类判据：
 * ① **命令载荷形状**：`group_nodes` / `ungroup_group` / `set_group_color` 必须
 *    下发前端能消费的 `canvas_command` 载荷（camelCase，与老链路 `definitions.py` 对齐）。
 * ② **写入口的拒绝语义**：非法色键、少于 2 个节点、空 group_id ⇒ 必须在**工具侧**
 *    就拒（返回 ok:false），不能把非法值发到前端让渲染层静默兜底。
 * ③ **group_id 的可回读性**：⭐ Agent 建组后必须能立刻用同一个 id 改色/解组 ——
 *    `canvas_command` 是单向 SSE 下发、**无回传通道**，所以 id 只能由 Agent 侧生成
 *    并随命令下发；这条判据就是防止「id 只在 Agent 脑子里、落库是另一个 id」的分叉。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCanvasGroupTools, GROUP_COLOR_KEYS } from "./canvas-group.js";
import { NestClient } from "./nest-client.js";
import type { LnkpiTool } from "./types.js";

const CTX = { sessionId: "s1" };

/** 对齐 harness execute 六参签名（同 arrange-nodes.test.ts）。 */
async function run(tool: LnkpiTool, params: unknown, ctx: unknown = CTX) {
	return tool.execute!(
		"tc1",
		params as never,
		() => {},
		ctx as never,
		{} as never,
		undefined as never,
	);
}

function setup(client?: NestClient) {
	const tools = createCanvasGroupTools(client);
	const byName = new Map(tools.map((t) => [t.name, t]));
	for (const n of ["group_nodes", "ungroup_group", "set_group_color"]) {
		assert.ok(byName.get(n), `${n} not registered`);
	}
	return {
		groupNodes: byName.get("group_nodes")!,
		ungroup: byName.get("ungroup_group")!,
		setColor: byName.get("set_group_color")!,
	};
}

/** 只读 NestClient 替身：把 get-canvas-layout 的响应固定为给定 layout。 */
function fakeClient(layout: unknown): NestClient {
	return new NestClient({
		baseUrl: "http://nest.test",
		token: "t",
		fetchImpl: (async () => ({
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => ({ code: 0, message: "ok", data: layout }),
		})) as never,
	});
}

/** 会抛错的替身（超时/熔断/包络错）——校验必须降级为「不校验」而不是让工具失败。 */
function brokenClient(): NestClient {
	return new NestClient({
		baseUrl: "http://nest.test",
		token: "t",
		fetchImpl: (async () => {
			throw new Error("network down");
		}) as never,
	});
}

function payloadOf(res: Awaited<ReturnType<typeof run>>): Record<string, unknown> {
	return JSON.parse((res.content[0] as { type: "text"; text: string }).text) as Record<string, unknown>;
}

function commandsOf(res: Awaited<ReturnType<typeof run>>): Array<Record<string, unknown>> {
	const d = res.details as { canvasCommands?: Array<Record<string, unknown>> };
	return d.canvasCommands ?? [];
}

const LAYOUT = {
	nodes: [{ id: "n1" }, { id: "n2" }, { id: "n3" }],
	groups: [{ id: "g1", title: "组一", childIds: ["n1", "n2"], colorKey: "moss" }],
};

describe("group_nodes：命令载荷 + 拒绝语义", () => {
	it("下发 group_nodes 命令，nodeIds 用 canvas node id", async () => {
		const { groupNodes } = setup(fakeClient(LAYOUT));
		const res = await run(groupNodes, { node_ids: ["n1", "n2"] });
		const cmds = commandsOf(res);
		assert.equal(cmds.length, 1);
		assert.equal(cmds[0]!.type, "group_nodes");
		assert.deepEqual(cmds[0]!.nodeIds, ["n1", "n2"]);
	});

	it("⭐ group_id 由 Agent 侧生成并随命令下发（canvas_command 无回传通道）", async () => {
		const { groupNodes } = setup(fakeClient(LAYOUT));
		const res = await run(groupNodes, { node_ids: ["n1", "n2"] });
		const cmds = commandsOf(res);
		const payload = payloadOf(res);
		const gid = cmds[0]!.groupId;
		assert.equal(typeof gid, "string", "group_nodes 命令必须带 groupId");
		assert.ok((gid as string).length > 0);
		// ⭐ 回包里的 groupId 必须与命令里的**同一个** —— 否则 Agent 拿回包 id 去
		// 改色，前端按命令 id 建的组却对不上 ⇒ 「建组→改色」静默失效。
		assert.equal(payload.groupId, gid, "回包 groupId 必须与命令 groupId 一致");
	});

	it("title 随命令下发；空标题按无标题处理（不传空串）", async () => {
		const { groupNodes } = setup(fakeClient(LAYOUT));
		const withTitle = commandsOf(await run(groupNodes, { node_ids: ["n1", "n2"], title: "  组一  " }));
		assert.equal(withTitle[0]!.title, "组一", "title 应 trim");
		const blank = commandsOf(await run(groupNodes, { node_ids: ["n1", "n2"], title: "   " }));
		assert.ok(!("title" in blank[0]!), "空标题不该下发 title 字段");
	});

	it("少于 2 个节点 ⇒ 工具侧就拒（不下发命令）", async () => {
		const { groupNodes } = setup(fakeClient(LAYOUT));
		const res = await run(groupNodes, { node_ids: ["n1"] });
		assert.equal(payloadOf(res).ok, false);
		assert.equal(commandsOf(res).length, 0, "被拒时不该下发任何命令");
		assert.equal((res.details as { _signal?: { reason?: string } })._signal?.reason, "below_two_nodes");
	});

	it("重复 id 去重后仍不足 2 个 ⇒ 拒（模型常重复传同一 id）", async () => {
		const { groupNodes } = setup(fakeClient(LAYOUT));
		const res = await run(groupNodes, { node_ids: ["n1", "n1"] });
		assert.equal(payloadOf(res).ok, false);
		assert.equal(commandsOf(res).length, 0);
	});

	it("不存在的 node id 进 missing 且不进命令（可纠错结论）", async () => {
		const { groupNodes } = setup(fakeClient(LAYOUT));
		const res = await run(groupNodes, { node_ids: ["n1", "n2", "ghost"] });
		const payload = payloadOf(res);
		assert.deepEqual(payload.missing, ["ghost"]);
		assert.deepEqual(commandsOf(res)[0]!.nodeIds, ["n1", "n2"], "ghost 不该进命令");
	});

	it("⛔ 过滤后实际可用节点不足 2 个 ⇒ 拒（不能回 ok:true 让模型以为建好了）", async () => {
		// 模型给了 3 个 id，但 2 个在画布上不存在 ⇒ 实际能组的只有 1 个。
		// 若照发命令，前端会因「少于 2 个」静默拒绝，而模型拿到 ok:true、grouped:1
		// ⇒ 下一轮改色必然扑空。
		const { groupNodes } = setup(fakeClient(LAYOUT));
		const res = await run(groupNodes, { node_ids: ["n1", "ghostA", "ghostB"] });
		const payload = payloadOf(res);
		assert.equal(payload.ok, false);
		assert.equal(commandsOf(res).length, 0, "不足 2 个可组节点时不该下发命令");
		assert.deepEqual(payload.missing, ["ghostA", "ghostB"]);
		assert.deepEqual(payload.available, ["n1"], "应回实际可用的节点让模型自我纠错");
		assert.equal((res.details as { _signal?: { reason?: string } })._signal?.reason, "below_two_nodes");
	});

	it("只读校验失败（网络断）⇒ 仍下发命令、标 verified=false（不因校验失败拖死单向命令）", async () => {
		const { groupNodes } = setup(brokenClient());
		const res = await run(groupNodes, { node_ids: ["n1", "n2"] });
		assert.equal(payloadOf(res).verified, false);
		assert.equal(commandsOf(res).length, 1, "校验失败不应阻止命令下发");
	});
});

describe("ungroup_group：命令载荷 + 拒绝语义", () => {
	it("下发 ungroup_group 命令，带 groupId", async () => {
		const { ungroup } = setup(fakeClient(LAYOUT));
		const cmds = commandsOf(await run(ungroup, { group_id: "g1" }));
		assert.equal(cmds[0]!.type, "ungroup_group");
		assert.equal(cmds[0]!.groupId, "g1");
	});

	it("空 group_id ⇒ 拒（不下发命令）", async () => {
		const { ungroup } = setup(fakeClient(LAYOUT));
		const res = await run(ungroup, { group_id: "" });
		assert.equal(payloadOf(res).ok, false);
		assert.equal(commandsOf(res).length, 0);
	});

	it("分组不存在 ⇒ 拒并回可用分组列表（让模型能自我纠错）", async () => {
		const { ungroup } = setup(fakeClient(LAYOUT));
		const res = await run(ungroup, { group_id: "ghost" });
		const payload = payloadOf(res);
		assert.equal(payload.ok, false);
		assert.equal(commandsOf(res).length, 0);
		assert.ok(Array.isArray(payload.availableGroups), "应回可用分组列表");
	});

	it("分组存在 ⇒ 回 releasedNodes 数量（模型能确认解出会放出几个节点）", async () => {
		const { ungroup } = setup(fakeClient(LAYOUT));
		const payload = payloadOf(await run(ungroup, { group_id: "g1" }));
		assert.equal(payload.releasedNodes, 2);
	});
});

describe("set_group_color：命令载荷 + 色键白名单", () => {
	it("下发 set_group_color 命令，带 groupId 与 colorKey", async () => {
		const { setColor } = setup(fakeClient(LAYOUT));
		const cmds = commandsOf(await run(setColor, { group_id: "g1", color_key: "moss" }));
		assert.equal(cmds[0]!.type, "set_group_color");
		assert.equal(cmds[0]!.groupId, "g1");
		assert.equal(cmds[0]!.colorKey, "moss");
	});

	it("⛔ 非法色键在工具侧就拒（不发到前端让渲染层静默落 neutral）", async () => {
		const { setColor } = setup(fakeClient(LAYOUT));
		const res = await run(setColor, { group_id: "g1", color_key: "hacker666" });
		const payload = payloadOf(res);
		assert.equal(payload.ok, false);
		assert.equal(commandsOf(res).length, 0, "非法色键不该下发命令");
		assert.ok(Array.isArray(payload.available), "应回可用色键列表");
	});

	it("省略 color_key / 传 null ⇒ 复位默认色（colorKey: null）", async () => {
		const { setColor } = setup(fakeClient(LAYOUT));
		const omitted = commandsOf(await run(setColor, { group_id: "g1" }));
		assert.equal(omitted[0]!.colorKey, null, "省略应等于复位");
		const explicitNull = commandsOf(await run(setColor, { group_id: "g1", color_key: null }));
		assert.equal(explicitNull[0]!.colorKey, null);
	});

	it("8 个合法色键全部放行（白名单不能误杀）", async () => {
		const { setColor } = setup(fakeClient(LAYOUT));
		for (const key of GROUP_COLOR_KEYS) {
			const res = await run(setColor, { group_id: "g1", color_key: key });
			assert.equal(payloadOf(res).ok, true, `色键 ${key} 应放行`);
			assert.equal(commandsOf(res)[0]!.colorKey, key);
		}
	});

	it("分组不存在 ⇒ 拒并回可用分组列表", async () => {
		const { setColor } = setup(fakeClient(LAYOUT));
		const res = await run(setColor, { group_id: "ghost", color_key: "moss" });
		assert.equal(payloadOf(res).ok, false);
		assert.equal(commandsOf(res).length, 0);
	});
});

describe("分组工具的发现口径（description 承担发现能力）", () => {
	it("三个工具的 description 都不指向延迟工具 get_canvas_layout", () => {
		// ⚠️ get_canvas_layout 在 tiering 的延迟集里（tool_search 触发率实测 0），
		// 描述若指向它 ⇒ 模型按名字直调会吃 "Tool get_canvas_layout is unavailable"。
		// 唯一可达的读入口是常驻的 get_canvas_summary。
		const { groupNodes, ungroup, setColor } = setup();
		for (const t of [groupNodes, ungroup, setColor]) {
			assert.ok(
				!t.description.includes("get_canvas_layout"),
				`${t.name} 的 description 不该指向延迟工具 get_canvas_layout`,
			);
		}
	});

	it("三个工具的 description 都指明 group_id / node_ids 从 get_canvas_summary 读", () => {
		const { groupNodes, ungroup, setColor } = setup();
		assert.ok(groupNodes.description.includes("get_canvas_summary"));
		assert.ok(ungroup.description.includes("get_canvas_summary"));
		assert.ok(setColor.description.includes("get_canvas_summary"));
	});
});
