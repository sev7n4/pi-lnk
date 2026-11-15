// services/pi-runtime/src/tools/asset-oracle.ts
/** D-1 L2 三条 oracle（spec §6.1）。纯函数：不读网络 / 不调模型 / 不写状态；
 * 离线 golden-cases 与生产 todo.ts.execute 共用（单一真相源，judgeCanvasCounts 范式）。
 * 4.5 常量与 render-canvas-view.ts:128 CHARS_PER_SEC 同源语义；此处独立常量并测试锁定，避免跨工具 import。 */
export type OracleVerdict = { verdict: "pass" | "reject"; reason?: string; evidence?: Record<string, unknown> };

const CHARS_PER_SEC = 4.5; // spec §6.1-3：中文口播 4–5 字/秒，取 4.5（render-canvas-view.ts:128 同值）

export function judgeIdClosure(input: { registeredIds: readonly string[]; referencedIds: readonly string[] }): OracleVerdict {
  const registered = input.registeredIds;
  const dupes = registered.filter((id, i) => registered.indexOf(id) !== i);
  if (dupes.length > 0) {
    return { verdict: "reject", reason: "一名多实体", evidence: { duplicateIds: [...new Set(dupes)] } };
  }
  const reg = new Set(registered);
  const unknownIds = [...new Set(input.referencedIds.filter((id) => !reg.has(id)))];
  if (unknownIds.length > 0) {
    return { verdict: "reject", reason: "孤儿引用", evidence: { unknownIds, registeredIds: registered } };
  }
  return { verdict: "pass" };
}

export function judgeAuthorityRef(input: {
  authorities: ReadonlyArray<{ dimension: string; materialId: string; accepted: boolean; pinned: boolean }>;
}): OracleVerdict {
  const byDim = new Map<string, number>();
  for (const a of input.authorities) {
    if (!a.accepted || !a.pinned) {
      return { verdict: "reject", reason: `维度 ${a.dimension} 的权威素材未验收或未钉版本`, evidence: { materialId: a.materialId, dimension: a.dimension } };
    }
    byDim.set(a.dimension, (byDim.get(a.dimension) ?? 0) + 1);
  }
  const conflicts = [...byDim.entries()].filter(([, n]) => n > 1).map(([d]) => d);
  if (conflicts.length > 0) {
    return { verdict: "reject", reason: "同维度多重权威", evidence: { conflicts } };
  }
  return { verdict: "pass" };
}

export function judgeDurationBudget(input: {
  rows: ReadonlyArray<{ shotId: string; durationMs?: number; dialogueChars?: number }>;
}): OracleVerdict {
  const overshoot: Array<Record<string, unknown>> = [];
  const missing: string[] = [];
  for (const r of input.rows) {
    if (r.durationMs === undefined || r.dialogueChars === undefined) { missing.push(r.shotId); continue; }
    const limit = (r.durationMs / 1000) * CHARS_PER_SEC;
    if (r.dialogueChars > limit) {
      overshoot.push({ shotId: r.shotId, limit: Math.floor(limit), actual: r.dialogueChars });
    }
  }
  if (missing.length > 0 || overshoot.length > 0) {
    return { verdict: "reject", reason: missing.length > 0 ? "缺少结构化 durationMs（禁采信模型自报，#815）" : "台词超时长预算", evidence: { overshoot, missingDuration: missing } };
  }
  return { verdict: "pass" };
}
