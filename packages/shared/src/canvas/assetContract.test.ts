import { describe, expect, it } from "vitest";
import {
  AXIS_SIDES, SHOT_SIZES, SCREEN_DIRECTIONS,
  parseAssetNodeData, parseMaterialMeta,
} from "./assetContract.js";

describe("AssetNodeData", () => {
  it("合法形态：全字段通过并归一化", () => {
    const r = parseAssetNodeData({
      assetId: "char-hero", contentHash: "a".repeat(64), version: 3,
      pinnedVersion: 2, derivedFrom: "char-hero", stale: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.version).toBe(3);
  });
  it("空 data 也合法（字段全可选，不破坏既有节点）", () => {
    expect(parseAssetNodeData({}).ok).toBe(true);
  });
  it("未知键 fail-closed：拒绝并回执合法键清单", () => {
    const r = parseAssetNodeData({ assetId: "x", note: "自由文本" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.allowedKeys).toContain("assetId");
  });
  it("负例 fixture（spec §8.2-8）：类型非法 ⇒ 拒绝", () => {
    expect(parseAssetNodeData({ version: "v3" }).ok).toBe(false);
    expect(parseAssetNodeData({ stale: "no" }).ok).toBe(false);
    expect(parseAssetNodeData({ derivedFrom: 42 }).ok).toBe(false);
  });
});

describe("MaterialMeta", () => {
  it("null / 空串 ⇒ ok 空对象（既有数据零迁移成本）", () => {
    expect(parseMaterialMeta(null).ok).toBe(true);
    expect(parseMaterialMeta("").ok).toBe(true);
  });
  it("权威维度闭集：face/firstFrame/lastFrame/scene/prop 之外的键拒绝", () => {
    const bad = JSON.stringify({ authority: { costume: { level: "primary" } } });
    expect(parseMaterialMeta(bad).ok).toBe(false);
    const good = JSON.stringify({ authority: { face: { level: "primary", pinnedVersion: 2 } } });
    expect(parseMaterialMeta(good).ok).toBe(true);
  });
  it("authority.level 闭集 primary|fallback，非法值拒绝", () => {
    const bad = JSON.stringify({ authority: { face: { level: "best" } } });
    expect(parseMaterialMeta(bad).ok).toBe(false);
  });
});

describe("枚举闭集", () => {
  it("三组枚举与 spec §7 一致且为 const 元组", () => {
    expect(AXIS_SIDES).toEqual(["left", "right"]);
    expect(SCREEN_DIRECTIONS).toEqual(["in", "out", "neutral"]);
    expect(SHOT_SIZES).toEqual(["wide", "medium", "close", "insert"]);
  });
});
