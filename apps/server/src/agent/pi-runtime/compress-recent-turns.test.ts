import { describe, expect, it } from "vitest";
import { compressRecentTurns, type TurnMessage } from "./compress-recent-turns";

describe("compressRecentTurns（recent_turns.py 语义平移）", () => {
	it("按 user 切轮取末 4 轮，助手 160 / 工具结果 120 截断", () => {
		const long = "x".repeat(200);
		const out = compressRecentTurns([
			{ role: "user", content: "u1" },
			{ role: "assistant", content: long, toolNames: ["get_canvas_summary"] },
			{ role: "tool", content: long },
			{ role: "user", content: "u2" },
			{ role: "assistant", content: "a2" },
		]);
		const lines = out.split("\n");
		expect(lines[0]).toBe("用户: u1");
		expect(lines[1]).toBe("助手工具: get_canvas_summary");
		expect(lines[2]).toBe("助手: " + "x".repeat(159) + "…");
		expect(lines[3]).toBe("工具结果: " + "x".repeat(119) + "…");
		expect(lines[4]).toBe("用户: u2");
		expect(lines[5]).toBe("助手: a2");
	});

	it("空输入返回空串；maxTurns=0 返回空串", () => {
		expect(compressRecentTurns([], 4)).toBe("");
		expect(compressRecentTurns([{ role: "user", content: "u" }] as TurnMessage[], 0)).toBe("");
	});

	it("前导 assistant 消息自成首轮（对齐 py 语义）", () => {
		const out = compressRecentTurns([
			{ role: "assistant", content: "hi" },
			{ role: "user", content: "u" },
		]);
		expect(out.split("\n")[0]).toBe("助手: hi");
	});

	it("只取末 maxTurns 轮，更早轮次丢弃", () => {
		const msgs: TurnMessage[] = [];
		for (let i = 0; i < 6; i++) {
			msgs.push({ role: "user", content: `u${i}` });
			msgs.push({ role: "assistant", content: `a${i}` });
		}
		const out = compressRecentTurns(msgs, 4);
		expect(out).not.toContain("u0");
		expect(out).not.toContain("u1");
		expect(out).toContain("u2");
		expect(out).toContain("u5");
	});

	it("空 content 的行跳过；toolNames 过滤空名", () => {
		const out = compressRecentTurns([
			{ role: "user", content: "  " },
			{ role: "assistant", content: "", toolNames: ["", "t1"] },
			{ role: "tool", content: "" },
		]);
		expect(out).toBe("助手工具: t1");
	});
});
