/**
 * 信号 listener 纯函数（P1 · spec 2026-10-12-tool-details-contract-design.md §4/§5/§6）。
 *
 * 锁定行为：
 * - 成功静默：status=ok 且无 truncated/coverage 告警 → undefined（零注入）。
 * - 异常才注入：尾部追加一行自解释短告警（15-30 token 预算），叠加序「正文→截断 marker→信号行」。
 * - ⭐ details 展开合并护栏：vendor 聚合是整字段替换（hooks.ts:315），patch 必须
 *   {...details, _signal} 展开——前序 listener 的 details 键（actions 等）绝不能被抹掉。
 * - retryable 三态语义：true=可退避重试；false=改参重试；缺省=未判明（hedge 文本）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendSignalLine, reconcileAffected } from "./result-signal-listener.js";

type Block = { type: string; text?: string };

describe("appendSignalLine", () => {
	it("ok 且无告警 → undefined（成功静默，零注入）", () => {
		const content: Block[] = [{ type: "text", text: "done" }];
		const out = appendSignalLine("gen_image", "gen", false, content, {
			ok: true,
			_signal: { status: "ok" },
		});
		assert.equal(out, undefined);
		// 原对象不被改动（纯函数）
		assert.deepEqual(content, [{ type: "text", text: "done" }]);
	});

	it("details 无有效 _signal → undefined（非契约工具零注入，isError 裸真不触发）", () => {
		assert.equal(appendSignalLine("ask_user", "lifecycle", false, [{ type: "text", text: "hi" }], {}), undefined);
		assert.equal(
			appendSignalLine("ask_user", "lifecycle", true, [{ type: "text", text: "boom" }], { some: "detail" }),
			undefined,
		);
		// details 非对象（契约外形态）→ 无法安全展开合并 → 零注入
		assert.equal(
			appendSignalLine("gen_image", "gen", true, [{ type: "text", text: "x" }], "raw-string", undefined),
			undefined,
		);
	});

	it("retryable:true → 尾部追加 ⚠️ 行（叠加序：正文→截断 marker→信号行）", () => {
		const out = appendSignalLine(
			"gen_image",
			"gen",
			true,
			[
				{ type: "text", text: '{"ok":false}' },
				{ type: "text", text: '正文…\n…（已截断：省略 500 字符）' },
			],
			{ ok: false, _signal: { status: "failed", retryable: true, errorCode: "rate_limited" } },
		);
		assert.ok(out, "异常结果必须有 patch");
		const last = out.content[out.content.length - 1];
		assert.equal(last.type, "text");
		assert.ok(last.text?.includes("⚠️[gen]"), `信号行应含 tier 标记：${last.text}`);
		assert.ok(last.text?.includes("rate_limited"), `信号行应含 errorCode：${last.text}`);
		assert.ok(last.text?.includes("可退避重试"), `retryable:true 应给退避提示：${last.text}`);
		// 叠加序：信号行在截断 marker 之后（同一文本块尾部追加）
		const markerAt = last.text?.indexOf("已截断") ?? -1;
		const signalAt = last.text?.indexOf("⚠️") ?? -1;
		assert.ok(markerAt !== -1 && signalAt > markerAt, `叠加序应为 正文→截断 marker→信号行：${last.text}`);
		// 信号行是追加不是替换：正文仍在
		assert.ok(last.text?.startsWith("正文…"));
	});

	it("未判明（无 retryable 字段）→ hedge 文本（不断言不禁止）", () => {
		const out = appendSignalLine("gen_video", "gen", true, [{ type: "text", text: "fail" }], {
			ok: false,
			_signal: { status: "failed", errorCode: "unknown" },
		});
		assert.ok(out);
		const text = out.content[out.content.length - 1].text ?? "";
		assert.ok(text.includes("未判明"), `hedge 应含「未判明」：${text}`);
		assert.ok(text.includes("换模型"), `hedge 应含「换模型」：${text}`);
	});

	it("retryable:false → 改参提示（不鼓励盲重试）", () => {
		const out = appendSignalLine("delete_nodes", "destructive", true, [{ type: "text", text: "bad" }], {
			ok: false,
			_signal: { status: "failed", retryable: false, errorCode: "invalid_params" },
		});
		assert.ok(out);
		const text = out.content[out.content.length - 1].text ?? "";
		assert.ok(text.includes("⚠️[destructive]"), `应含 tier 标记：${text}`);
		assert.ok(text.includes("参数"), `retryable:false 应提示改参：${text}`);
	});

	it("truncated（status ok）→ 截断告警行；coverage partial → coverage 告警行", () => {
		const t = appendSignalLine("read_doc", "read", false, [{ type: "text", text: "partial doc" }], {
			_signal: { status: "ok", truncated: true },
		});
		assert.ok(t);
		assert.ok(t.content[t.content.length - 1].text?.includes("截断"));

		const c = appendSignalLine("get_canvas_summary", "read", false, [{ type: "text", text: "summary" }], {
			coverage: "partial",
			scope: "visible nodes",
			_signal: { status: "ok", coverage: "partial" },
		});
		assert.ok(c);
		const ctext = c.content[c.content.length - 1].text ?? "";
		assert.ok(ctext.includes("partial") || ctext.includes("局部"), `coverage 告警应说明局部性：${ctext}`);
	});

	it("⭐ details 展开合并护栏：前序 listener 的 details patch 不被抹掉", () => {
		const actions = [{ type: "canvas_create_node", nodeId: "n1" }];
		const out = appendSignalLine("delete_nodes", "destructive", true, [{ type: "text", text: "err" }], {
			actions,
			affectedCount: 0,
			_signal: { status: "failed", retryable: false, errorCode: "invalid_params" },
		});
		assert.ok(out);
		// actions（Nest extractCanvasActions 前端实时通道，PR #65 踩过丢失）必须保留
		assert.deepEqual(out.details.actions, actions);
		assert.equal(out.details.affectedCount, 0);
		// _signal 为展开合并结果（原值保留）
		assert.deepEqual(out.details._signal, { status: "failed", retryable: false, errorCode: "invalid_params" });
	});

	it("content 无文本块 → 追加新 text 块（不破坏 JSON 块可解析性）", () => {
		const out = appendSignalLine("gen_image", "gen", true, [{ type: "image" }] as unknown as Block[], {
			ok: false,
			_signal: { status: "failed", retryable: true, errorCode: "rate_limited" },
		});
		assert.ok(out);
		assert.equal(out.content.length, 2);
		assert.equal(out.content[0].type, "image", "原块原样保留");
		assert.equal(out.content[1].type, "text");
		assert.ok(out.content[1].text?.includes("⚠️"));
	});

	it("extraLine（对账告警）与信号行一起尾部追加", () => {
		const out = appendSignalLine(
			"remove_edges",
			"destructive",
			false,
			[{ type: "text", text: "removed" }],
			{ ok: true, affectedCount: 3, _signal: { status: "partial" } },
			"⚠️ 部分生效：请求 5 项，实际生效 3 项",
		);
		assert.ok(out);
		const text = out.content[out.content.length - 1].text ?? "";
		assert.ok(text.includes("部分生效"), `对账行应被追加：${text}`);
		assert.ok(text.includes("⚠️[destructive]") || text.includes("partial"), `信号行也应存在：${text}`);
	});
});

describe("reconcileAffected", () => {
	it("请求 5 生效 3 → 部分生效告警行", () => {
		const line = reconcileAffected(5, 3);
		assert.ok(line);
		assert.ok(line.includes("5"), `应含请求数：${line}`);
		assert.ok(line.includes("3"), `应含生效数：${line}`);
		assert.ok(line.includes("部分生效") || line.includes("未全部生效"), `应说明部分生效：${line}`);
	});
	it("请求 5 生效 5 → undefined（完全生效不注入）", () => {
		assert.equal(reconcileAffected(5, 5), undefined);
	});
	it("缺任一侧 → undefined（无法对账不妄言）", () => {
		assert.equal(reconcileAffected(undefined, 3), undefined);
		assert.equal(reconcileAffected(5, undefined), undefined);
		assert.equal(reconcileAffected(undefined, undefined), undefined);
	});
});
