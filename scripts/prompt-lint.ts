/**
 * 提示词注册中心门禁（spec §4.5 的 L1-L9）。
 *
 * 刻意只做 CLI 外壳：全部判据在 loader 的 assertRegistryIntegrity 里，
 * 运行时与 CI 共用同一份，避免"本地过、线上炸"。
 *
 * 运行：pnpm prompt:lint（等价于 npx tsx scripts/prompt-lint.ts）
 */
import {
	assertRegistryIntegrity,
	resolveRegistryRoot,
} from "../apps/server/src/agent/pi-runtime/prompt-registry.loader";

// lint 跑在仓库根，cwd 一定是根；env 显式指定时以它为准。
const root = process.env.PI_PROMPT_REGISTRY_DIR ?? resolveRegistryRoot();
const errors = assertRegistryIntegrity(root);

if (errors.length > 0) {
	for (const e of errors) console.error(`prompt-lint: ${e}`);
	console.error(`prompt-lint: ${errors.length} 个问题 → 退出码 1`);
	process.exit(1);
}
console.log(`prompt-lint: ok (${root})`);
