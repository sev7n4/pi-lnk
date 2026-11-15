// apps/server/src/canvas/asset-contract-columns.test.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

/**
 * D-1 L0：加列存在性 + 可空默认（spec §7）。migration.sql 与 schema.prisma 必须同步。
 * harness：临时 SQLite + `prisma db push`（照 pricing-cost-record sqlite integration
 * 模式。本仓 migrations 链无初始基线（首个 migration 即假设既有表存在），
 * migrate deploy 无法在干净库上跑通，故用 db push 等价建库 + PRAGMA table_info
 * 直接断言列存在且可空（notnull=0 且无默认值 ⇒ 旧行零迁移可读）。
 */
const serverRoot = join(__dirname, "../..");

/** Shot 新列 → SQLite 类型（migration.sql 20261116000000_d1_asset_contract 同源）。 */
const SHOT_COLUMNS: Array<[string, string]> = [
  ["axisSide", "TEXT"],
  ["screenDirection", "TEXT"],
  ["shotSize", "TEXT"],
  ["durationMs", "INTEGER"],
  ["contentHash", "TEXT"],
  ["version", "INTEGER"],
  ["pinnedAssetId", "TEXT"],
];
/** Story 新列。 */
const STORY_COLUMNS: Array<[string, string]> = [
  ["contentHash", "TEXT"],
  ["lockedAt", "DATETIME"],
  ["lockedVersion", "INTEGER"],
];

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

function tableInfo(dbPath: string, table: string): ColumnInfo[] {
  const out = execFileSync(
    "sqlite3",
    [dbPath, `PRAGMA table_info("${table}");`],
    { encoding: "utf8" },
  );
  return out
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      // sqlite3 默认列表输出：cid|name|type|notnull|dflt_value|pk
      const [, name, type, notnull, dflt] = line.split("|");
      return {
        name,
        type,
        notnull: Number(notnull),
        dflt_value: dflt === "" ? null : dflt,
      };
    });
}

describe("D-1 asset contract columns", () => {
  let dbPath: string;
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "d1-cols-"));
    dbPath = join(dir, "test.db");
    execFileSync("pnpm", ["exec", "prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
      stdio: "pipe",
    });
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("Shot/Story 新列存在且可空（PRAGMA：无 NOT NULL、无默认值）", () => {
    for (const [table, columns] of [
      ["Shot", SHOT_COLUMNS],
      ["Story", STORY_COLUMNS],
    ] as const) {
      const info = tableInfo(dbPath, table);
      for (const [name, type] of columns) {
        const col = info.find((c) => c.name === name);
        expect(col, `${table}.${name} 列存在`).toBeDefined();
        expect(col!.type, `${table}.${name} 类型`).toBe(type);
        expect(col!.notnull, `${table}.${name} 可空`).toBe(0);
        expect(col!.dflt_value, `${table}.${name} 无默认值`).toBeNull();
      }
    }
  });

  it("Shot/Story 旧行零迁移可读：不写新列即可建行，新列读出为 NULL", async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });
    // Shot.sessionId / Story.userId 均有 FK ⇒ 先建父行（brief 测试数据省略了父行）。
    await prisma.user.create({ data: { id: "u1", phone: "13800000000", nickname: "t" } });
    await prisma.session.create({ data: { id: "s1", userId: "u1" } });
    const shot = await prisma.shot.create({ data: { sessionId: "s1" } });
    expect(shot.axisSide).toBeNull();
    expect(shot.durationMs).toBeNull();
    expect(shot.version).toBeNull();
    const story = await prisma.story.create({ data: { userId: "u1", title: "t" } });
    expect(story.contentHash).toBeNull();
    expect(story.lockedAt).toBeNull();
    await prisma.$disconnect();
  });
});
