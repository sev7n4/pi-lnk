/**
 * VoiceStudio MCP 桥四工具单测（P2，spec §5）。
 *
 * 覆盖面：env 门 / 纯文本模式 / 命名规范 / 入参校验 / VS {error} 契约显式报错 /
 * 连接单例复用与重连一次 / list_voices 截断。MCP 协议层正确性由 vendor 包自身
 * 测试 + 活体冒烟兜底（与 P1 同策略），本文件用 deps 注入替身。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { McpConnectionClosedError, type McpClient } from "@earendil-works/pi-mcp";
import { createVoiceStudioMcpTools, buildVoiceProfileName, loadVoiceStudioMcpEnv, __resetVoiceStudioMcpForTests, type VoiceStudioMcpEnv } from "./voicestudio-mcp.js";
import type { LnkpiTool, LnkpiToolContext } from "./types.js";
import type { NestClient } from "./nest-client.js";

const ENV: VoiceStudioMcpEnv = { url: "http://vs.test:3900/mcp/", apiKey: "k-test" };

/** 六参 execute 快捷调用（vendor AgentHarnessTool.execute 全参数必填）。 */
async function runTool(
	tool: LnkpiTool,
	params: Record<string, unknown>,
	tc: Partial<LnkpiToolContext> = {},
): Promise<Record<string, unknown>> {
	const out = (await tool.execute!("t", params as never, () => {}, tc as LnkpiToolContext, undefined as never, undefined as never)) as {
		content: Array<{ text: string }>;
	};
	return JSON.parse(out.content[0].text) as Record<string, unknown>;
}

/** NestClient 替身：按 path 记录请求并回固定值。 */
function fakeNestClient(handler: (path: string, body: unknown) => unknown): NestClient {
	return {
		post: async (path: string, body: unknown) => handler(path, body),
	} as unknown as NestClient;
}

/** McpClient 替身：可编程的 callTool + connect 计数。
 * throwOnCall 返回值非 undefined 才抛（哨兵语义），否则落到 onCall。 */
function fakeMcpClient(opts: {
	onCall?: (tool: string, args: Record<string, unknown>) => unknown;
	throwOnCall?: (tool: string, callIndex: number) => unknown;
} = {}) {
	let calls = 0;
	const connectCount = { n: 0 };
	const stub = {
		connect: async () => {
			connectCount.n += 1;
		},
		close: async () => {},
		callTool: async (tool: string, args: Record<string, unknown>) => {
			calls += 1;
			const thrown = opts.throwOnCall?.(tool, calls);
			if (thrown !== undefined) throw thrown;
			return opts.onCall?.(tool, args) ?? { content: [{ type: "text", text: "{}" }] };
		},
	};
	return { stub: stub as unknown as McpClient, connectCount, callCount: () => calls };
}

const mcpOk = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

const AUDIO_OK = { ok: true, base64: "YWJj", mimeType: "audio/mpeg", fileName: "ref.mp3" };

function buildTools(client: NestClient, deps: Parameters<typeof createVoiceStudioMcpTools>[1] = {}) {
	const tools = createVoiceStudioMcpTools(client, { env: ENV, ...deps });
	assert.ok(tools.length > 0, "env 注入后四工具必须注册");
	return tools;
}

/** 每测试独立连接槽位（连接单例按 url 键控——BYOK 多实例不串的判据本身也要在测试间成立）。 */
function envFor(name: string): VoiceStudioMcpEnv {
	return { url: `http://vs-${name}.test:3900/mcp/`, apiKey: "k-test" };
}

test("env 门：双 env 齐备才启用，缺任一返回空数组（零注册）", () => {
	assert.equal(loadVoiceStudioMcpEnv({ OMNIVOICE_MCP_URL: "http://x", OMNIVOICE_API_KEY: "k" } as NodeJS.ProcessEnv)?.url, "http://x");
	assert.equal(loadVoiceStudioMcpEnv({ OMNIVOICE_MCP_URL: "http://x" } as NodeJS.ProcessEnv), null);
	assert.equal(loadVoiceStudioMcpEnv({ OMNIVOICE_API_KEY: "k" } as NodeJS.ProcessEnv), null);
	assert.equal(loadVoiceStudioMcpEnv({} as NodeJS.ProcessEnv), null);
	assert.deepEqual(createVoiceStudioMcpTools(fakeNestClient(() => AUDIO_OK), { env: null }), []);
	assert.deepEqual(createVoiceStudioMcpTools(null, { env: ENV }), []);
	// 显式 env 覆盖（工厂不读 process.env）
	assert.equal(createVoiceStudioMcpTools(fakeNestClient(() => AUDIO_OK), { env: ENV }).length, 4);
});

test("命名规范：lnk-<userId8>-<清洗名>，清洗规则与空回退", () => {
	assert.equal(buildVoiceProfileName("老板娘", "abcdef1234567890"), "lnk-abcdef12-老板娘");
	assert.equal(buildVoiceProfileName("毒舌 老板娘!!", "u-87654321"), "lnk-u-876543-毒舌-老板娘");
	assert.equal(buildVoiceProfileName("   ", "abcdefgh"), "lnk-abcdefgh-voice");
	assert.equal(buildVoiceProfileName("n", undefined), "lnk-nosessio-n");
	const built = buildVoiceProfileName("啊".repeat(60), "u1");
	assert.ok(built.startsWith("lnk-u1-"));
	assert.ok(built.length <= "lnk-u1-".length + 40);
});

test("clone_voice：缺参结构化报错", async () => {
	const fake = fakeMcpClient();
	const [clone] = buildTools(fakeNestClient(() => AUDIO_OK), {
		env: envFor('clone-missing'),
		createClient: () => fake.stub,
		createTransport: () => ({}) as never,
	}).filter((t) => t.name === "clone_voice");
	const out = await runTool(clone, { url: "", name: "" });
	assert.equal(out.ok, false);
	assert.match(out.error as string, /url（uploads 音频引用）与 name/);
});

test("clone_voice：MCP 成功返回 profile_id 且带 lnk- 前缀调用；Nest 拒绝透传", async () => {
	const fake = fakeMcpClient({
		onCall: (tool, args) => {
			assert.equal(tool, "clone_voice");
			assert.match(args.name as string, /^lnk-abcdef12-老板娘$/);
			assert.equal(args.ref_audio_base64, "YWJj");
			assert.equal(args.language, "Auto");
			return mcpOk({ profile_id: "vp_1", name: args.name, kind: "clone" });
		},
	});
	const clone = buildTools(fakeNestClient((path, body) => {
		if (path === "/agent/internal/voice-profiles") return { ok: true }; // P3 台账登记成功
		assert.equal(path, "/agent/internal/read-audio");
		assert.deepEqual(body, { url: "/api/uploads/u1/ref.mp3" });
		return AUDIO_OK;
	}), { env: envFor('clone-ok'), createClient: () => fake.stub, createTransport: () => ({}) as never }).find((t) => t.name === "clone_voice")!;

	const ok = await runTool(clone, { url: "/api/uploads/u1/ref.mp3", name: "老板娘" }, { userId: "abcdef1234567890" });
	assert.equal(ok.ok, true);
	assert.equal(ok.profile_id, "vp_1");
	assert.equal(ok.registered, true, "P3：登记成功不带 warning");
	assert.match(ok.note as string, /voice 参数/);

	const bad = buildTools(fakeNestClient(() => ({ ok: false, error: "仅支持 uploads 引用" })), {
		env: envFor('clone-ok'), createClient: () => fake.stub, createTransport: () => ({}) as never,
	}).find((t) => t.name === "clone_voice")!;
	const out = await runTool(bad, { url: "https://evil/x.mp3", name: "n" });
	assert.equal(out.ok, false);
	assert.match(out.error as string, /仅支持 uploads 引用/);
});

test("clone_voice：VS {error} JSON 契约 → ok:false 显式报错（isError 不置位也要拦）", async () => {
	const fake = fakeMcpClient({ onCall: () => mcpOk({ error: "reference audio too short" }) });
	const clone = buildTools(fakeNestClient(() => AUDIO_OK), {
		env: envFor('clone-err'), createClient: () => fake.stub, createTransport: () => ({}) as never,
	}).find((t) => t.name === "clone_voice")!;
	const out = await runTool(clone, { url: "/api/uploads/u1/a.mp3", name: "n" });
	assert.equal(out.ok, false);
	assert.equal(out.error, "reference audio too short");
});

test("P3 合规台账：clone 成功即登记（source/refUrl/userId 留痕），registered:true", async () => {
	const fake = fakeMcpClient({ onCall: () => mcpOk({ profile_id: "vp_9", name: "lnk-abcdef12-n" }) });
	const regBodies: Array<Record<string, unknown>> = [];
	const clone = buildTools(
		fakeNestClient((path, body) => {
			if (path === "/agent/internal/read-audio") return AUDIO_OK;
			if (path === "/agent/internal/voice-profiles") {
				regBodies.push(body as Record<string, unknown>);
				return { ok: true };
			}
			throw new Error(`unexpected path: ${path}`);
		}),
		{ env: envFor('p3-clone-reg'), createClient: () => fake.stub, createTransport: () => ({}) as never },
	).find((t) => t.name === "clone_voice")!;
	const out = await runTool(clone, { url: "/api/uploads/u1/ref.mp3", name: "n" }, { userId: "abcdef1234567890" });
	assert.equal(out.ok, true);
	assert.equal(out.registered, true);
	assert.equal(out.warning, undefined);
	assert.equal(regBodies.length, 1);
	assert.deepEqual(regBodies[0], {
		userId: "abcdef1234567890",
		profileId: "vp_9",
		profileName: "lnk-abcdef12-n",
		displayName: "n",
		source: "cloned",
		refUrl: "/api/uploads/u1/ref.mp3",
	});
});

test("P3 合规台账：登记失败不谎报克隆失败——ok:true + registered:false + warning（profile 已存在是事实）", async () => {
	const fake = fakeMcpClient({ onCall: () => mcpOk({ profile_id: "vp_10", name: "x" }) });
	const clone = buildTools(
		fakeNestClient((path) => {
			if (path === "/agent/internal/read-audio") return AUDIO_OK;
			throw new Error("registry down");
		}),
		{ env: envFor('p3-clone-regfail'), createClient: () => fake.stub, createTransport: () => ({}) as never },
	).find((t) => t.name === "clone_voice")!;
	const out = await runTool(clone, { url: "/api/uploads/u1/ref.mp3", name: "n" }, { userId: "u-12345678" });
	assert.equal(out.ok, true, "profile 已创建，报 ok:false 会误导 agent");
	assert.equal(out.registered, false);
	assert.match(out.warning as string, /合规登记失败.*registry down/);
	assert.match(out.warning as string, /管理员补登/);
	assert.equal(out.profile_id, "vp_10");
});

test("P3 合规台账：design_voice 也走 lnk- 审计命名 + source:designed 登记（无 refUrl）", async () => {
	const fake = fakeMcpClient({
		onCall: (_tool, args) => {
			assert.match(args.name as string, /^lnk-u-876543-毒舌-老板娘$/);
			return mcpOk({ profile_id: "vp_d", name: args.name, attrs: {}, unmatched: [] });
		},
	});
	const regBodies: Array<Record<string, unknown>> = [];
	const design = buildTools(
		fakeNestClient((path, body) => {
			if (path === "/agent/internal/voice-profiles") {
				regBodies.push(body as Record<string, unknown>);
				return { ok: true };
			}
			throw new Error(`unexpected path: ${path}`);
		}),
		{ env: envFor('p3-design'), createClient: () => fake.stub, createTransport: () => ({}) as never },
	).find((t) => t.name === "design_voice")!;
	const out = await runTool(design, { name: "毒舌 老板娘", description: "中年女性，语速快" }, { userId: "u-87654321" });
	assert.equal(out.ok, true);
	assert.equal(out.registered, true);
	assert.equal(regBodies.length, 1);
	assert.deepEqual(regBodies[0], {
		userId: "u-87654321",
		profileId: "vp_d",
		profileName: "lnk-u-876543-毒舌-老板娘",
		displayName: "毒舌 老板娘",
		source: "designed",
	});
	assert.ok(!("refUrl" in regBodies[0]), "designed 不带 refUrl");
});

test("transcribe：双传报错；node_id/url 分别走对应 source；返回 text", async () => {
	const fake = fakeMcpClient({
		onCall: (tool, args) => {
			assert.equal(tool, "transcribe");
			assert.equal(args.audio_base64, "YWJj");
			return mcpOk({ text: "你好世界", language: "zh", duration: 1.5 });
		},
	});
	const seen: unknown[] = [];
	const tr = buildTools(fakeNestClient((_path, body) => {
		seen.push(body);
		return AUDIO_OK;
	}), { env: envFor('transcribe'), createClient: () => fake.stub, createTransport: () => ({}) as never }).find((t) => t.name === "transcribe")!;

	const both = await runTool(tr, { node_id: "n1", url: "/api/uploads/u1/a.mp3" }, { sessionId: "s1" });
	assert.equal(both.ok, false);
	assert.match(both.error as string, /只能传一个/);

	const none = await runTool(tr, {});
	assert.equal(none.ok, false);
	assert.match(none.error as string, /二选一/);

	const byNode = await runTool(tr, { node_id: "n1" }, { sessionId: "s1" });
	assert.deepEqual(seen[0], { sessionId: "s1", nodeId: "n1" });
	assert.equal(byNode.ok, true);
	assert.equal(byNode.text, "你好世界");

	const byUrl = await runTool(tr, { url: "/api/uploads/u1/a.mp3" });
	assert.deepEqual(seen[1], { url: "/api/uploads/u1/a.mp3" });
	assert.equal(byUrl.ok, true);
});

test("连接管理：同 env 复用单例；连接类错误销毁旧连接重连一次成功；reset 归零", async () => {
	__resetVoiceStudioMcpForTests();
	let clients = 0;
	const f1 = fakeMcpClient({ onCall: () => mcpOk({ id: "v1" }) });
	const lv = buildTools(fakeNestClient(() => AUDIO_OK), {
		env: envFor('conn-reuse'),
		createClient: () => (clients += 1, f1.stub), createTransport: () => ({}) as never,
	}).find((t) => t.name === "list_voices")!;
	await runTool(lv, {});
	await runTool(lv, {});
	assert.equal(clients, 1, "两次调用必须复用同一 client");
	assert.equal(f1.connectCount.n, 1);
	__resetVoiceStudioMcpForTests();

	let created = 0;
	const f2 = fakeMcpClient({
		// list_voices 的合法返回是数组（第一次调用被连接类错误打断，重连后成功）
		onCall: () => mcpOk([{ id: "v2", name: "v2" }]),
		throwOnCall: (_tool, idx) => {
			if (idx === 1) throw new McpConnectionClosedError("stream dropped");
			return undefined;
		},
	});
	const lv2 = buildTools(fakeNestClient(() => AUDIO_OK), {
		env: envFor('conn-reconnect'),
		createClient: () => (created += 1, f2.stub), createTransport: () => ({}) as never,
	}).find((t) => t.name === "list_voices")!;
	const out = await runTool(lv2, {});
	assert.equal(out.ok, true);
	assert.equal(out.total, 1);
	assert.equal((out.voices as Array<{ id: string }>)[0].id, "v2");
	assert.equal(created, 2, "旧 client 销毁后应重建一次");
	__resetVoiceStudioMcpForTests();
});

test("VS 不可达（连接类错误两次）→ unavailable 显式文案，不静默换道", async () => {
	__resetVoiceStudioMcpForTests();
	const f = fakeMcpClient({ throwOnCall: () => new McpConnectionClosedError("down") });
	let created = 0;
	const lv = buildTools(fakeNestClient(() => AUDIO_OK), {
		env: envFor('conn-dead'),
		createClient: () => (created += 1, f.stub), createTransport: () => ({}) as never,
	}).find((t) => t.name === "list_voices")!;
	const out = await runTool(lv, {});
	assert.equal(out.ok, false);
	assert.match(out.error as string, /本地声纹引擎/);
	assert.match(out.error as string, /云端/);
	assert.ok(created >= 2, "重试一次后仍败");
	__resetVoiceStudioMcpForTests();
});

test("list_voices：截断到 50 条并带 note；非数组结构报错", async () => {
	__resetVoiceStudioMcpForTests();
	const big = Array.from({ length: 62 }, (_, i) => ({ id: `v${i}`, name: `voice-${i}` }));
	const f = fakeMcpClient({ onCall: () => mcpOk(big) });
	const lv = buildTools(fakeNestClient(() => AUDIO_OK), {
		env: envFor('list'),
		createClient: () => f.stub, createTransport: () => ({}) as never,
	}).find((t) => t.name === "list_voices")!;
	const out = await runTool(lv, {});
	assert.equal(out.ok, true);
	assert.equal(out.total, 62);
	assert.equal(out.shown, 50);
	assert.equal(out.truncated, true);
	assert.match(out.note as string, /仅展示前 50 条/);
	__resetVoiceStudioMcpForTests();

	const f2 = fakeMcpClient({ onCall: () => mcpOk({ not: "array" }) });
	const lv2 = buildTools(fakeNestClient(() => AUDIO_OK), {
		env: envFor('list-bad'),
		createClient: () => f2.stub, createTransport: () => ({}) as never,
	}).find((t) => t.name === "list_voices")!;
	const out2 = await runTool(lv2, {});
	assert.equal(out2.ok, false);
	assert.match(out2.error as string, /非数组/);
	__resetVoiceStudioMcpForTests();
});
