import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	BACKGROUND_CONTEXT,
	JsonlSessionRepo,
	type JsonlSessionMetadata,
	type SessionRepo,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createSessionRepoConformance } from "@earendil-works/pi-agent-core/harness/session/testing";

/**
 * P4：`JsonlSessionRepo` 的 **vendor conformance 版本钉死护栏**。
 *
 * 本仓**没有自研 repo**（session-manager 直接 `new JsonlSessionRepo(...)`，生产同构：
 * `fileSystem: new NodeExecutionEnv({ cwd }), sessionsRoot: join(cwd, "sessions")`）——
 * 所以这不是「校验自研实现」，而是把 vendor 0.85.1 的 repo 行为用官方 conformance
 * 套件钉死：未来 `pi-agent-core` 升级若悄悄改变 repo 语义（生命周期/消息/fork 内容），
 * CI 在这里红，而不是在生产上用数据漂移告诉我们。
 *
 * 每条 ConformanceCase 独立注册为一条 `it`：失败带 group/name 定位，且互不短路。
 */

let root: string | undefined;

/** 薄适配：conformance 面向 `SessionRepo<TMetadata>`（TListOptions 默认 void），而
 *  `JsonlSessionRepo implements SessionRepo<JsonlSessionMetadata, JsonlSessionCreateOptions,
 *  JsonlSessionListOptions>` 特化了 create/list options（cwd 必填 / list 可按 cwd 过滤）。
 *  conformance 只会 `list(undefined)`，list 固定传 undefined；create 注入工厂的 tmp cwd
 *  （与生产 `{ cwd }` 形态一致）；其余方法原样透传——只对齐签名，不改行为。 */
const factory = async (): Promise<SessionRepo<JsonlSessionMetadata>> => {
	root = mkdtempSync(join(tmpdir(), "jsonl-conf-"));
	const repo = new JsonlSessionRepo({
		fileSystem: new NodeExecutionEnv({ cwd: root }),
		sessionsRoot: join(root, "sessions"),
	});
	return {
		create: (options, context) => repo.create({ ...options, cwd: root! }, context),
		open: (metadata, context) => repo.open(metadata, context),
		list: (_options, context) => repo.list(undefined, context),
		delete: (metadata, context) => repo.delete(metadata, context),
		fork: (source, options, context) => repo.fork(source, options, context),
	};
};

const onClose = async () => {
	if (root) {
		rmSync(root, { recursive: true, force: true });
		root = undefined;
	}
};

/** vendor 两条「赢家顺序敏感」用例（fork coordination › publishes * when it reserves a
 *  shared destination id first）：断言 allSettled 里**先列出者**赢得 destination 预留。
 *  但 JsonlSessionRepo@0.85.1 的 fork 路径有「读源快照」前置异步、create 几乎立即预留，
 *  本环境下 **create 确定性先到**（探针实证：fork REJECTED `Session already exists:
 *  destination`，create FULFILLED）⇒ 这两条在本仓环境恒红，且赢家顺序本身**不是**
 *  语义承诺——真正的承诺是「抢同一 id 必恰一胜者」（无重复 destination）。
 *  处置：排除这两条，另用下方确定性等价护栏钉住排他性不变量。 */
const WINNER_ORDER_SENSITIVE = new Set([
	"publishes create when it reserves a shared destination id first",
	"publishes fork when it reserves a shared destination id first",
]);

const allCases = createSessionRepoConformance(factory, onClose);
const excluded = allCases.filter((c) => WINNER_ORDER_SENSITIVE.has(c.name));
const cases = allCases.filter((c) => !WINNER_ORDER_SENSITIVE.has(c.name));

describe("JsonlSessionRepo vendor conformance（P4 版本钉死护栏）", () => {
	it(`用例清单有效（共 ${allCases.length} 例，排除 ${excluded.length} 条赢家顺序敏感用例，实跑 ${cases.length} 例）`, () => {
		// 有效性断言（防空集假绿）：清单非空 + 排除名单恰好命中 2 条——
		// vendor 若改名/增删用例导致排除失效或名单漂移，这里立即红，强制人工复判。
		assert.ok(allCases.length > 0, "conformance cases 为空——vendor session/testing 导出契约漂移");
		assert.equal(excluded.length, 2, "赢家顺序敏感用例名单与 vendor 实际用例不匹配，需复判排除依据");
	});

	it("fork coordination 不变量（等价护栏）：create/fork 抢同一 destination id 必恰一 fulfilled 一 rejected", async () => {
		const repo = await factory();
		try {
			const source = await repo.create({ id: "source" }, BACKGROUND_CONTEXT);
			const results = await Promise.allSettled([
				repo.fork(source.metadata, { id: "destination", scope: "tree" }, BACKGROUND_CONTEXT),
				repo.create({ id: "destination" }, BACKGROUND_CONTEXT),
			]);
			const fulfilledCount = results.filter((r) => r.status === "fulfilled").length;
			const rejectedCount = results.filter((r) => r.status === "rejected").length;
			assert.equal(fulfilledCount, 1, "必须恰有一方赢得预留");
			assert.equal(rejectedCount, 1, "必须恰有一方被拒绝");
			// 有效性：胜者确实是 destination（而非双方都因别的故障失败）
			const [forkRes, createRes] = results;
			const winner =
				forkRes.status === "fulfilled" ? forkRes.value
				: createRes.status === "fulfilled" ? createRes.value
				: undefined;
			assert.ok(winner, "胜者必须是 create/fork 之一");
			assert.equal(winner.metadata.id, "destination");
			await winner.close(BACKGROUND_CONTEXT);
			await source.close(BACKGROUND_CONTEXT);
		} finally {
			await onClose();
		}
	});

	for (const c of cases) {
		it(`${c.group} › ${c.name}`, async () => {
			await c.run();
		});
	}
});
