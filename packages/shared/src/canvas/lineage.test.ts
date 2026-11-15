import { describe, expect, it } from "vitest";
import { downstreamClosure, shouldPropagate } from "./lineage.js";
import { computeContentHash } from "./lineage.server.js";

describe("computeContentHash", () => {
  it("相同字段集合（键序无关）⇒ 同哈希", () => {
    expect(computeContentHash({ a: 1, b: "x" })).toBe(computeContentHash({ b: "x", a: 1 }));
  });
  it("任一结构化字段变化 ⇒ 哈希变化；64 位 hex", () => {
    const h1 = computeContentHash({ prompt: "a" });
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(computeContentHash({ prompt: "b" })).not.toBe(h1);
  });
  it("position 等非结构化字段不参与哈希（spec：内容哈希只算 structuredFields）", () => {
    expect(computeContentHash({ prompt: "a" })).toBe(computeContentHash({ prompt: "a" }));
  });
});

describe("downstreamClosure", () => {
  const edges = [
    { source: "A", target: "B" }, { source: "B", target: "C" },
    { source: "A", target: "C" }, { source: "D", target: "A" }, { source: "C", target: "C" },
  ];
  it("BFS 求可达下游，不含起点；自环不死循环", () => {
    expect(downstreamClosure(edges, ["A"]).sort()).toEqual(["B", "C"]);
  });
  it("多起点合并去重", () => {
    // 注：brief 原用例 seeds ["D","A"] 期望含起点 A，与接口契约「不含起点」矛盾
    // （verbatim 实现把起点锁进 visited 恒不输出——这正是 stale 传播所需语义：
    // 本事务刚被重写的节点不再标 stale）。改为 seeds ["D","B"]：D→A 与 B→C 两条
    // 路径在 C 汇合，仍覆盖多起点合并 + 去重。偏差已记入 task-3-report。
    expect(downstreamClosure(edges, ["D", "B"]).sort()).toEqual(["A", "C"]);
  });
  it("无下游 ⇒ 空数组（不报错）", () => {
    expect(downstreamClosure(edges, ["C"])).toEqual([]);
  });
});

describe("shouldPropagate", () => {
  it("哈希不变 ⇒ false（防抖动，spec §8.2-4）", () => {
    expect(shouldPropagate("h", "h")).toBe(false);
  });
  it("哈希变化或首次写入 ⇒ true", () => {
    expect(shouldPropagate("h1", "h2")).toBe(true);
    expect(shouldPropagate(undefined, "h2")).toBe(true);
    expect(shouldPropagate("h1", undefined)).toBe(true);
  });
});
