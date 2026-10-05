/**
 * hook event 自由形态字段读取守卫的验收。
 *
 * 每条「ok:false」用例都对应一种原本会静默降级的上游形态变化：
 * 原来靠 `as` 强转，读到 undefined 就走「字段不存在」分支，不报错也不留痕。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readRecord, readStringField, readBooleanField } from "./hook-contract.js";

describe("readRecord", () => {
	it("对象 → ok，原样返回引用", () => {
		const src = { messages: [], model: "x" };
		const r = readRecord(src, "payload");
		assert.equal(r.ok, true);
		if (r.ok) assert.equal(r.value, src);
	});

	it("null / undefined → ok:false（否则会被 spread 成 {} 而静默丢字段）", () => {
		for (const bad of [null, undefined]) {
			const r = readRecord(bad, "payload");
			assert.equal(r.ok, false);
			if (!r.ok) assert.match(r.reason, /payload: is (null|undefined), expected object/);
		}
	});

	it("字符串 / 数字 → ok:false（不是对象就是契约漂移）", () => {
		const r = readRecord("oops", "payload");
		assert.equal(r.ok, false);
		if (!r.ok) assert.match(r.reason, /is string/);
	});

	it("数组 → ok:false（spread 数组会变成带索引键的对象，必须拦住）", () => {
		const r = readRecord([{ a: 1 }], "payload");
		assert.equal(r.ok, false);
		if (!r.ok) assert.match(r.reason, /is array/);
	});
});

describe("readStringField", () => {
	it("非空字符串 → ok", () => {
		const r = readStringField({ node_id: "n-1" }, "node_id", "event.args");
		assert.deepEqual(r, { ok: true, value: "n-1" });
	});

	it("空串 → ok:false（空 node_id 会让 gate 记到空键上）", () => {
		const r = readStringField({ node_id: "" }, "node_id", "event.args");
		assert.equal(r.ok, false);
	});

	it("字段缺失 → ok:false，而不是静默 undefined", () => {
		const r = readStringField({ other: 1 }, "node_id", "event.args");
		assert.equal(r.ok, false);
		if (!r.ok) assert.match(r.reason, /event\.args\.node_id/);
	});

	it("字段类型变成数字（上游漂移）→ ok:false", () => {
		const r = readStringField({ node_id: 42 }, "node_id", "event.args");
		assert.equal(r.ok, false);
	});

	it("args 本身不是对象 → ok:false（源头就是坏的）", () => {
		const r = readStringField(null, "node_id", "event.args");
		assert.equal(r.ok, false);
	});
});

describe("readBooleanField", () => {
	it("true / false 都能取到（false 不能退化成「缺失」）", () => {
		assert.deepEqual(readBooleanField({ confirmed: true }, "confirmed", "event.details"), {
			ok: true,
			value: true,
		});
		assert.deepEqual(readBooleanField({ confirmed: false }, "confirmed", "event.details"), {
			ok: true,
			value: false,
		});
	});

	it("字符串 'true' → ok:false（不做隐式转换，避免误判为已确认）", () => {
		const r = readBooleanField({ confirmed: "true" }, "confirmed", "event.details");
		assert.equal(r.ok, false);
	});

	it("details 缺失 → ok:false", () => {
		const r = readBooleanField(undefined, "confirmed", "event.details");
		assert.equal(r.ok, false);
	});
});

describe("为什么不能用 as + spread", () => {
	// 这条固化的是被本模块替换掉的旧写法的行为，防止有人改回去。
	it("{ ...payload } 在 payload=null 时静默产出 {}，只留下 messages —— 旧写法会静默丢字段", () => {
		const payload: unknown = null;
		const legacy = { ...(payload as Record<string, unknown>), messages: ["kept"] };
		assert.deepEqual(legacy, { messages: ["kept"] });
		// 判读：旧写法拿不到「payload 是坏的」这个事实，新写法可以。
		assert.equal(readRecord(payload, "payload").ok, false);
	});

	it("{ ...payload } 在 payload 是字符串时把字符拆成索引键", () => {
		const legacy = { ...("ab" as unknown as Record<string, unknown>), messages: [] };
		assert.deepEqual(Object.keys(legacy).sort(), ["0", "1", "messages"]);
		assert.equal(readRecord("ab", "payload").ok, false);
	});
});
