/** D-1 L1 失效传播——node 侧哈希实现（web 打包不安全，禁止进 barrel）。
 * spec §8.2-4：contentHash = sha256(structuredFields)。仅 apps/server 消费；
 * 经 `@lnkpi/shared/canvas/lineage.server` subpath 引入，web bundle 永不含 node:crypto。 */
import { createHash } from "node:crypto";
import { downstreamClosure, shouldPropagate } from "./lineage.js";
import type { CanvasData, CanvasNode } from "../index.js";

/** 结构化内容哈希：键排序后 JSON 串 sha256。position/位置类字段由调用方排除。 */
export function computeContentHash(fields: Record<string, unknown>): string {
  const sorted = Object.keys(fields).sort()
    .map((k) => `${k}=${JSON.stringify(fields[k])}`).join("&");
  return createHash("sha256").update(sorted).digest("hex");
}

/** D-1 L1 内容哈希的结构化字段口径（agent-canvas computeNodeContentHash 同源，单一真相源）。
 * position / 位置类字段不入 hash。 */
const CONTENT_HASH_FIELDS = ["title", "prompt", "assetId", "pinnedVersion", "derivedFrom"] as const;

/** 节点 data 的内容哈希（与 agent-canvas 旧私有实现逐字同口径）。 */
export function computeNodeContentHash(data: Record<string, unknown> | null | undefined): string {
  const fields: Record<string, unknown> = {};
  for (const k of CONTENT_HASH_FIELDS) {
    if (data?.[k] !== undefined) fields[k] = data[k];
  }
  return computeContentHash(fields);
}

/** 从画布 op 列表提取「内容变更节点 id」（update_node / add_node 的 payload.id）。
 * agent persist/commitStage 与 sessions.service.patchCanvas 共用，口径单一。 */
export function changedNodeIdsFromOps(ops: readonly { type?: string; payload?: unknown }[]): string[] {
  const out: string[] = [];
  for (const op of ops) {
    if (op?.type !== 'update_node' && op?.type !== 'add_node') continue;
    const id = (op.payload as { id?: unknown } | undefined)?.id;
    if (typeof id === 'string' && id.length > 0) out.push(id);
  }
  return out;
}

/**
 * D-1 L1 失效传播——**共享纯就地变换**（server-only，node:crypto）。
 *
 * 两条写路径共用同一实现（吃满上游、不重复造轮子）：
 * - agent 写路径：agent-canvas-tools.service.persist / commitStage；
 * - 人工编辑：sessions.service.patchCanvas（C1a/C2a 侧车 ops PATCH）。
 *
 * 语义（spec §8.2-4）：changed 节点 hash 未变 ⇒ 不写（防抖动幂等）；hash 变化/首次 ⇒
 * changed 节点盖 contentHash + version 自增 + stale:false（重写即新鲜，清除旧 stale 标记），
 * 并对 downstreamClosure（BFS，不含起点）每个下游写 stale:true。
 *
 * **就地变换，不持 tx、不写 IO**：调用方在自己的 `$transaction` 内、唯一 `tx.session.update`
 * 之前对 merged canvas 生效，写通道保持唯一（spec §6.2 单一写者硬约束）。
 */
export function propagateStale(
  canvas: CanvasData,
  changedNodeIds: readonly string[],
): void {
  if (changedNodeIds.length === 0) return;
  const propagating: string[] = [];
  for (const id of changedNodeIds) {
    const node = (canvas.nodes as CanvasNode[]).find((n) => n.id === id);
    if (!node) continue;
    const data = (node as { data?: unknown }).data;
    // 存量节点 data 可能 null/undefined：只做字段读取兜底，绝不抛错中断保存路径。
    const prevHash = typeof (data as Record<string, unknown> | undefined)?.contentHash === "string"
      ? (data as Record<string, unknown>).contentHash as string
      : undefined;
    const nextHash = computeNodeContentHash(
      data && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : undefined,
    );
    if (!shouldPropagate(prevHash, nextHash)) continue;
    (node as { data?: Record<string, unknown> }).data = {
      ...((data && typeof data === "object" && !Array.isArray(data)
        ? data : {}) as Record<string, unknown>),
      contentHash: nextHash,
      version: (Number((data as Record<string, unknown> | undefined)?.version) || 0) + 1,
      stale: false,
    };
    propagating.push(id);
  }
  if (propagating.length === 0) return;
  const edges = (canvas.edges ?? []) as Array<{ source: string; target: string }>;
  const downstreamIds = new Set(downstreamClosure(edges, propagating));
  if (downstreamIds.size === 0) return;
  for (const node of canvas.nodes as CanvasNode[]) {
    if (!downstreamIds.has(node.id)) continue;
    const data = (node as { data?: unknown }).data;
    (node as { data?: Record<string, unknown> }).data = {
      ...((data && typeof data === "object" && !Array.isArray(data)
        ? data : {}) as Record<string, unknown>),
      stale: true,
    };
  }
}
