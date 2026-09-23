import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "./session-manager.js";

describe("SessionManager harnessFactory 注入缝", () => {
	it("create() 把 tools/toolContext/systemPrompt 原样传给 harnessFactory", async () => {
		let captured: unknown = null;
		const fakeHarnessFactory = async (cfg: unknown) => {
			captured = cfg;
			return {
				harness: {
					events: { on: () => () => {} },
					lane: async () => ({ prompt: async () => ({ ok: true }) }),
					close: async () => {},
				},
			} as never;
		};
		const sm = new SessionManager([{ name: "t_probe" } as never], "", undefined, fakeHarnessFactory);
		await sm.create("s1", {
			userId: "u1",
			systemPrompt: "SYS",
			attachments: [{ url: "https://x/a.png", mediaType: "image" }],
			mentionedKeys: ["I1"],
			refOrder: ["I1"],
			focusNodeId: "node-1",
		});
		const cfg = captured as { systemPrompt: string; toolContext: Record<string, unknown> };
		assert.equal(cfg.systemPrompt, "SYS");
		assert.equal(cfg.toolContext.userId, "u1");
		assert.equal(cfg.toolContext.sessionId, "s1");
		assert.deepEqual(cfg.toolContext.mentionedKeys, ["I1"]);
		assert.equal(cfg.toolContext.focusNodeId, "node-1");
		assert.deepEqual((cfg.toolContext.attachments as unknown[])[0], {
			url: "https://x/a.png",
			mediaType: "image",
		});
	});
});
