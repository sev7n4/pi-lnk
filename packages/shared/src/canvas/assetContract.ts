/** D-1 L0 资产契约（spec 2026-11-15-d1-creative-asset-contract-design.md §7）。
 * 只允许既有 model 加列 / 开放字段收 schema，不新增 Prisma model。
 * 未知键 fail-closed：spec §7「开放字段须有 zod 解析 + 未知键 fail-closed」。 */
import { z } from "zod";

export const AXIS_SIDES = ["left", "right"] as const;
export const SCREEN_DIRECTIONS = ["in", "out", "neutral"] as const;
export const SHOT_SIZES = ["wide", "medium", "close", "insert"] as const;

/** 画布节点 data 的资产字段（全部可选：既有节点零破坏）。 */
export const AssetNodeDataSchema = z
  .object({
    assetId: z.string().min(1).optional(),
    contentHash: z.string().length(64).optional(),
    version: z.number().int().positive().optional(),
    pinnedVersion: z.number().int().positive().optional(),
    /**
     * 契约（D-1 终审裁决）：必须引用同一命名空间内已登记的 assetId（不带版本后缀）；
     * 版本谱系由 version/pinnedVersion 承载。即 derivedFrom 的合法取值域 = registeredIds，
     * 不允许出现 "char-hero-v1" 这类版本后缀形态。
     */
    derivedFrom: z.string().min(1).optional(),
    stale: z.boolean().optional(),
  })
  .strict(); // 未知键 fail-closed（zod strict = 未知键报错）

export type AssetNodeData = z.infer<typeof AssetNodeDataSchema>;

export type ParseFail = { ok: false; reason: string; allowedKeys: string[] };

export function parseAssetNodeData(data: unknown):
  | { ok: true; value: AssetNodeData } | ParseFail {
  const r = AssetNodeDataSchema.safeParse(data);
  if (r.success) return { ok: true, value: r.data };
  const allowedKeys = Object.keys(AssetNodeDataSchema.shape);
  const first = r.error.issues[0];
  return { ok: false, reason: first ? `${first.path.join(".")}: ${first.message}` : "invalid", allowedKeys };
}

const AUTHORITY_DIMENSIONS = ["face", "firstFrame", "lastFrame", "scene", "prop"] as const;
const AuthorityEntrySchema = z.object({
  level: z.enum(["primary", "fallback"]),
  pinnedVersion: z.number().int().positive().optional(),
}).strict();

export const MaterialMetaSchema = z.object({
  authority: z.record(z.enum(AUTHORITY_DIMENSIONS), AuthorityEntrySchema).optional(),
}).strict();

export type MaterialMeta = z.infer<typeof MaterialMetaSchema>;

export function parseMaterialMeta(meta: string | null):
  | { ok: true; value: MaterialMeta } | ParseFail {
  if (meta === null || meta === "") return { ok: true, value: {} };
  let raw: unknown;
  try { raw = JSON.parse(meta); } catch { return { ok: false, reason: "metadata 不是合法 JSON", allowedKeys: ["authority"] }; }
  const r = MaterialMetaSchema.safeParse(raw);
  if (r.success) return { ok: true, value: r.data };
  const first = r.error.issues[0];
  return { ok: false, reason: first ? `${first.path.join(".")}: ${first.message}` : "invalid", allowedKeys: ["authority"] };
}
