# S0-1 幽灵模型下架 —— 分项规格

状态：待评审（2026-10-09）
上级规格：`2026-10-09-model-platform-hardening-design.md`（批次 B0，服务目标 G1）
事故依据：总体规格 §2.4（deepseek-v4 生产 503 取证）

## 1. 目标

平台目录中的 3 个「网关无渠道」文本模型对用户**不可选**：Dock 选择器、设置页平台镜像、用户 `selectableTextModels` 全部同步收敛，且历史数据零破坏。

## 2. 现状摘录（真实锚点）

- `packages/shared/src/studioModelCatalog.ts` `STUDIO_MODEL_CATALOG` 文本 4 条：`agnes-2.0-flash`（真实可用）、`gemini-3.1-flash`、`deepseek-v4`、`gpt-5.5`（三者为幽灵：agnes hub `/v1/models` 无渠道，探针取证见总体规格 §2.4）。
- 下架的既有机制已存在：`apps/server/src/provider/model-catalog-sync.ts`（#306）头注释明确「目录移除某模型后，它的停用记录一并清理；bootstrap 对齐时清掉目录已不存在的选择」。**本分项 = 给 sync 喂一个移除了条目的目录，验证既有机制闭环，不新写同步逻辑。**
- 镜像：`ProviderChannel('platform').models`（`[{name, capability}]`），由 `ensurePlatformChannel`（`apps/server/src/provider/provider.service.ts`）播种。
- 用户侧：`UserAiPreferences.selectableTextModels` / `disabledModels`。

## 3. 改动设计

1. **目录删条目**：从 `STUDIO_MODEL_CATALOG` 移除 `deepseek-v4`、`gemini-3.1-flash`、`gpt-5.5` 三条；在原位置保留注释块，注明「2026-10-09 探活下架（agnes hub 无渠道），上游开通后按 §S1-1 探活对账结果重新上架」，防止将来无据复排。
2. **`modelCapability` 等衍生逻辑零改动**：`resolveModelKey` 对未知 key 抛错的既有行为即兜底（已移除的 key 不再命中）。
3. **同步验证**（不改代码，只补测试）：bootstrap sync 后镜像 = 25 条；`selectableTextModels` 中三个已移除条目被清理；`disabledModels` 中它们的停用记录被清理。

## 4. 验收判据（可断言）

| # | 判据 | 断言方式 |
|---|---|---|
| A1 | `STUDIO_MODEL_CATALOG.filter(text).length === 1`（仅 agnes-2.0-flash） | shared 包单测 |
| A2 | 既有镜像（预置含 28 条）经 sync 后 = 25 条，三个幽灵条目消失 | `model-catalog-sync` 单测：预置含幽灵的镜像行，断言 sync 结果 |
| A3 | `selectableTextModels` 含 `deepseek-v4` 的用户行，sync 后不含之；`disabledModels` 中其停用记录清空 | 同上单测 |
| A4 | 引用幽灵模型的既有画布节点不崩：`resolveModelKey('text','deepseek-v4')` 抛既有确定性错误（非静默） | shared 包单测断言抛错类型 |
| A5 | 生产复测：部署后 `ProviderChannel('platform').models` 长度 25；用户报障画布 Dock 无 DeepSeek V4 可选 | SQL + 页面目视 |

## 5. 测试要点

- 新增测试文件：`packages/shared/src/studioModelCatalog.ghost-retirement.test.ts`（A1/A4）。
- `apps/server/src/provider/model-catalog-sync.test.ts` 追加用例（A2/A3）：fixture 行必须包含「幽灵既在 selectable 又在 disabled」的复合形态（同形歧义是 #306 的核心已知坑）。
- 上架机会（可选，同 PR）：网关真实存在但目录缺失的 `agnes-2.5-flash` / `agnes-3.0-flash` 如需上架，**必须在 S1-1 探活能力就绪后**（总体规格 §3.3 门禁），本分项不做。

## 6. 涉及文件

- Modify: `packages/shared/src/studioModelCatalog.ts`（删 3 条 + 注释块）
- Test: `packages/shared/src/studioModelCatalog.ghost-retirement.test.ts`（新）、`apps/server/src/provider/model-catalog-sync.test.ts`（追加）
- 生产复测：SQL（`ProviderChannel.models`）+ Docker 探针（复用 `.workbuddy` 探针模式，参考 2026-10-09 事故取证命令）

## 7. 依赖与风险

- 无代码依赖，可独立发车；风险与回滚见总体规格 §6 第一行（下架≠删除，恢复=重加条目）。
- 上游恢复 deepseek 系后：走 B1-1 探活对账的「恢复→解除灰显/提示上架」路径，不再人工目测。
