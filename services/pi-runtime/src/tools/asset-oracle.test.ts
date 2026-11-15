// services/pi-runtime/src/tools/asset-oracle.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { judgeAuthorityRef, judgeDurationBudget, judgeIdClosure } from "./asset-oracle.js";

test("idClosure: 孤儿引用 ⇒ reject 且证据带合法 ID 清单", () => {
  const v = judgeIdClosure({ registeredIds: ["hero", "scene-1"], referencedIds: ["hero", "ghost"] });
  assert.equal(v.verdict, "reject");
  assert.deepEqual(v.evidence?.unknownIds, ["ghost"]);
  assert.deepEqual(v.evidence?.registeredIds, ["hero", "scene-1"]);
});
test("idClosure: 一名多实体（registered 重复）⇒ reject", () => {
  const v = judgeIdClosure({ registeredIds: ["hero", "hero"], referencedIds: ["hero"] });
  assert.equal(v.verdict, "reject");
});
test("idClosure: 全部引用已登记 ⇒ pass；空引用 ⇒ pass（非故障）", () => {
  assert.equal(judgeIdClosure({ registeredIds: ["hero"], referencedIds: ["hero"] }).verdict, "pass");
  assert.equal(judgeIdClosure({ registeredIds: [], referencedIds: [] }).verdict, "pass");
});

test("authorityRef: 同维度多权威 ⇒ reject（spec §6.1-2）", () => {
  const v = judgeAuthorityRef({
    authorities: [
      { dimension: "face", materialId: "m1", accepted: true, pinned: true },
      { dimension: "face", materialId: "m2", accepted: true, pinned: true },
    ],
  });
  assert.equal(v.verdict, "reject");
  assert.deepEqual(v.evidence?.conflicts, ["face"]);
});
test("authorityRef: 未验收或未钉版本 ⇒ reject；合法唯一 ⇒ pass", () => {
  assert.equal(judgeAuthorityRef({
    authorities: [{ dimension: "face", materialId: "m1", accepted: false, pinned: true }],
  }).verdict, "reject");
  assert.equal(judgeAuthorityRef({
    authorities: [{ dimension: "face", materialId: "m1", accepted: true, pinned: true }],
  }).verdict, "pass");
});

test("durationBudget: 中文台词字数 > durationSec×4.5 ⇒ reject（判据读 Shot 结构化 durationMs，禁自报数）", () => {
  const v = judgeDurationBudget({ rows: [{ shotId: "s1", durationMs: 2000, dialogueChars: 10 }] });
  assert.equal(v.verdict, "reject"); // 2s × 4.5 = 9 字上限，10 字超
  assert.deepEqual(v.evidence?.overshoot, [{ shotId: "s1", limit: 9, actual: 10 }]);
});
test("durationBudget: 恰好等于上限 ⇒ pass；无 durationMs 行 ⇒ reject（证据不足，禁采信自报）", () => {
  assert.equal(judgeDurationBudget({ rows: [{ shotId: "s1", durationMs: 2000, dialogueChars: 9 }] }).verdict, "pass");
  assert.equal(judgeDurationBudget({ rows: [{ shotId: "s1", dialogueChars: 5 }] }).verdict, "reject");
});
