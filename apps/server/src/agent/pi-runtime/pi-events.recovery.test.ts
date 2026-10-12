import { describe, expect, it } from "vitest";
import { mapPiEventToUiEvent, type PiRuntimeEvent } from "./pi-events";

describe("recovery 透传（P2：会话恢复中 vs 真上游超时）", () => {
	it("PiRuntimeEvent recovery → UI 事件 recovery（不加 pi_ 前缀，避免前端按 type 分支消费时静默丢弃）", () => {
		const evt = { type: "recovery", ts: 1, data: {} } as never as PiRuntimeEvent;
		expect(mapPiEventToUiEvent(evt)).toEqual({ type: "recovery", data: {} });
	});
});
