import assert from "node:assert/strict";
import { test } from "node:test";
import { governImagePayload } from "./payload-images.js";

/** OpenAI 兼容格式构造器。 */
const oaiImage = (data: string) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${data}` } });
const oaiText = (text: string) => ({ type: "text", text });

const MB8 = 8 * 1024 * 1024;

test("无图片 payload：引用相等（零拷贝）", () => {
	const payload = { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };
	const r = governImagePayload(payload, 2, 4);
	assert.equal(r.messages, (payload as { messages: unknown }).messages);
	assert.equal(r.trims.length, 0);
});

test("未知格式（无 messages）：原样返回", () => {
	const payload = { prompt: "raw", something: 1 };
	const r = governImagePayload(payload, 2, 4);
	assert.equal(r.messages, undefined); // 未知格式不产出 messages
	assert.equal(r.trims.length, 0);
});

test("历史图片（2 轮前）→ 文本占位（history_image）", () => {
	const payload = {
		messages: [
			{ role: "user", content: [oaiText("[I1=a.png] 看图"), oaiImage("AAAA")] },
			{ role: "assistant", content: [{ type: "text", text: "好的" }] },
			{ role: "user", content: [oaiText("第一轮追问")] },
			{ role: "assistant", content: [{ type: "text", text: "答" }] },
			{ role: "user", content: [oaiText("第二轮追问")] },
			{ role: "assistant", content: [{ type: "text", text: "答2" }] },
			{ role: "user", content: [oaiText("当前轮问题")] },
		],
	};
	const messages = governImagePayload(payload, 2, 4).messages as Array<{ content: unknown[] }>;
	const first = messages[0].content as Array<{ type: string; text?: string }>;
	assert.equal(first.filter((p) => p.type === "image_url").length, 0);
	assert.ok(first.some((p) => p.type === "text" && p.text?.includes("已从上下文移除")), JSON.stringify(first));
	assert.ok(first.some((p) => p.type === "text" && p.text?.includes("read_document")));
});

test("最近 2 轮内的图片保留", () => {
	const img = oaiImage("BBBB");
	const payload = {
		messages: [
			{ role: "user", content: [oaiText("上轮带图"), img] },
			{ role: "assistant", content: [{ type: "text", text: "答" }] },
			{ role: "user", content: [oaiText("当前轮")] },
		],
	};
	const messages = governImagePayload(payload, 2, 4).messages as Array<{ content: unknown[] }>;
	assert.equal(messages[0].content.includes(img), true);
});

test("6 张图 > maxImages：本轮优先、新→旧回填，不得取前 4", () => {
	const old1 = oaiImage("C1");
	const old2 = oaiImage("C2");
	const old3 = oaiImage("C3");
	const old4 = oaiImage("C4");
	const cur1 = oaiImage("D1");
	const cur2 = oaiImage("D2");
	const payload = {
		messages: [
			{ role: "user", content: [oaiText("上一轮"), old1, old2, old3, old4] },
			{ role: "assistant", content: [{ type: "text", text: "答" }] },
			{ role: "user", content: [oaiText("本轮"), cur1, cur2] },
		],
	};
	const messages = governImagePayload(payload, 2, 4).messages as Array<{ content: unknown[] }>;
	const keptOld = (messages[0].content as Array<{ type?: string; image_url?: { url: string } }>)
		.filter((p) => p.type === "image_url")
		.map((p) => p.image_url?.url);
	// 上一轮 4 张按新→旧回填 2 张（old4、old3），最旧两张降级
	assert.equal(keptOld.filter((u) => u?.includes("C4")).length, 1, "old4 保留（消息内最新）");
	assert.equal(keptOld.filter((u) => u?.includes("C3")).length, 1, "old3 保留");
	assert.equal(keptOld.filter((u) => u?.includes("C1")).length, 0, "old1 降级");
	assert.equal(keptOld.filter((u) => u?.includes("C2")).length, 0, "old2 降级");
	const cur = messages[2].content as Array<{ type: string }>;
	assert.equal(cur.filter((p) => p.type === "image_url").length, 2, "当前轮 2 张全保留");
});

test("无标记文件名的占位不抛错（Review Focus 3）", () => {
	const payload = {
		messages: [
			{ role: "user", content: [oaiText("很早的问题"), oaiImage("EEEE")] },
			{ role: "user", content: [oaiText("一轮")] },
			{ role: "user", content: [oaiText("二轮")] },
		],
	};
	const messages = governImagePayload(payload, 2, 4).messages as Array<{ content: unknown[] }>;
	const parts = messages[0].content as Array<{ type: string; text?: string }>;
	assert.ok(parts.every((p) => p.type !== "image_url"));
	assert.ok(parts.some((p) => p.type === "text" && p.text?.includes("图片")));
});

test("单图 data 超 8MB：剔除+占位，不炸请求", () => {
	const payload = {
		messages: [{ role: "user", content: [oaiText("看"), oaiImage("A".repeat(MB8 + 1)), oaiImage("small")] }],
	};
	const r = governImagePayload(payload, 2, 4);
	const parts = (r.messages as Array<{ content: unknown[] }>)[0].content as Array<{
		type: string;
		image_url?: { url: string };
		text?: string;
	}>;
	assert.equal(parts.filter((p) => p.type === "image_url").length, 1);
	assert.ok(parts.some((p) => p.type === "text" && p.text?.includes("已从上下文移除")));
	assert.ok(r.trims.some((t) => t.reason === "overflow" && t.count >= 1));
});

test("text part >200k chars 截断（text_overflow）", () => {
	const big = "x".repeat(200_001);
	const payload = { messages: [{ role: "user", content: [oaiText(big)] }] };
	const r = governImagePayload(payload, 2, 4);
	const parts = (r.messages as Array<{ content: unknown[] }>)[0].content as Array<{ type: string; text?: string }>;
	assert.equal(parts[0].text?.length, 200_000);
	assert.ok(r.trims.some((t) => t.reason === "text_overflow"));
});

test("Anthropic 格式：历史图片同样降级", () => {
	const payload = {
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "老图" },
					{ type: "image", source: { type: "base64", data: "FFFF", media_type: "image/png" } },
				],
			},
			{ role: "assistant", content: [{ type: "text", text: "答" }] },
			{ role: "user", content: [{ type: "text", text: "一轮" }] },
			{ role: "user", content: [{ type: "text", text: "二轮" }] },
		],
	};
	const r = governImagePayload(payload, 2, 4);
	const parts = (r.messages as Array<{ content: unknown[] }>)[0].content as Array<{ type: string; text?: string }>;
	assert.equal(parts.filter((p) => p.type === "image").length, 0);
	assert.ok(parts.some((p) => p.type === "text" && p.text?.includes("已从上下文移除")));
});
