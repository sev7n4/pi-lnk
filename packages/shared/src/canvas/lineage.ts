/** D-1 L1 失效传播纯函数（spec §8.2-4）。不读网络 / 不写状态；IO 在 apps/server 侧。
 * build-system 式增量失效：contentHash 不变 ⇒ 不传播（防抖动）。
 * 注意：本文件必须保持 web-safe（零 node 内建依赖）——node:crypto 版的
 * computeContentHash 在 ./lineage.server.ts（subpath export，barrel 不 re-export，
 * 见 web build FAIL「createHash is not exported by __vite-browser-external」）。 */

/** 有向图下游闭包：从 changedIds 沿 source→target 可达的全部节点（不含起点）。
 * 自环/环安全：visited 集合防重入。 */
export function downstreamClosure(
  edges: ReadonlyArray<{ source: string; target: string }>,
  changedIds: readonly string[],
): string[] {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const list = adj.get(e.source) ?? [];
    list.push(e.target);
    adj.set(e.source, list);
  }
  const seen = new Set<string>(changedIds);
  const queue = [...changedIds];
  const out: string[] = [];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    for (const next of adj.get(cur) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      out.push(next);
      queue.push(next);
    }
  }
  return out;
}

/** 哈希不变 ⇒ 不传播（spec §8.2-4 防抖动）；任一侧缺失视为变化。 */
export function shouldPropagate(prevHash?: string, nextHash?: string): boolean {
  if (prevHash === undefined || nextHash === undefined) return true;
  return prevHash !== nextHash;
}
