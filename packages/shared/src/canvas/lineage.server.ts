/** D-1 L1 失效传播——node 侧哈希实现（web 打包不安全，禁止进 barrel）。
 * spec §8.2-4：contentHash = sha256(structuredFields)。仅 apps/server 消费；
 * 经 `@lnkpi/shared/canvas/lineage.server` subpath 引入，web bundle 永不含 node:crypto。 */
import { createHash } from "node:crypto";

/** 结构化内容哈希：键排序后 JSON 串 sha256。position/位置类字段由调用方排除。 */
export function computeContentHash(fields: Record<string, unknown>): string {
  const sorted = Object.keys(fields).sort()
    .map((k) => `${k}=${JSON.stringify(fields[k])}`).join("&");
  return createHash("sha256").update(sorted).digest("hex");
}
