/** 参数捕获的**安全**边界测试：值不得进 label，未知 view 不得进 label。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractParamNames, extractViewName } from "./tool-args.js";

test("只取参数名，不取值", () => {
	const args = { view: "timeline", title: "沙丘", relation: "dependency" };
	const names = extractParamNames(args);
	assert.deepEqual(names, ["view", "title", "relation"]);
	// ⛔ 「沙丘」是用户可控文本，绝不能出现在任何可观测产物里
	assert.equal(JSON.stringify(names).includes("沙丘"), false);
});

test("非对象（null / 字符串 / 数组）返回空数组，不抛", () => {
	assert.deepEqual(extractParamNames(null), []);
	assert.deepEqual(extractParamNames("x"), []);
	assert.deepEqual(extractParamNames([1, 2]), []);
	assert.deepEqual(extractParamNames(undefined), []);
});

test("view 取值在枚举内 ⇒ 原样返回", () => {
	assert.equal(extractViewName({ view: "topology" }), "topology");
	assert.equal(extractViewName({ view: "table" }), "table");
});

test("⛔ view 取值不在枚举内 ⇒ undefined（不把模型自由文本写进监控面）", () => {
	assert.equal(extractViewName({ view: "沙丘" }), undefined);
	assert.equal(extractViewName({ view: "<script>" }), undefined);
});

test("view 缺失或类型不对 ⇒ undefined", () => {
	assert.equal(extractViewName({}), undefined);
	assert.equal(extractViewName({ view: 123 }), undefined);
	assert.equal(extractViewName(null), undefined);
});
