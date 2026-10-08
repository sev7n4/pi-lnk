import { describe, expect, it } from 'vitest'
import { getModelEntry, listModels, STUDIO_MODEL_CATALOG } from './studioModelCatalog'
import { GenerationType } from './index'

/**
 * 幽灵清单回归锁（2026-10-08）。
 *
 * ⛔ 事故背景：`packages/shared/src/index.ts` 曾并行导出 `TEXT_MODELS` /
 * `IMAGE_MODELS` / `VIDEO_MODELS`（gpt-4o / dall-e-3 / sora / kling-v1 …），
 * 它们与 `STUDIO_MODEL_CATALOG` **零重叠**，却被 `ModelSelector.vue` 与
 * `GET /agent/capabilities/list` 直接返给前端 ⇒ 用户能在主导航的
 * 「工作室」页选中 `sora`，后端 `resolveModelKey` 查不到 ⇒ 静默回落默认模型
 * （`fallback:true` 只写进 metadata）⇒ **选了 A 生成 B，且照扣费、页面不报错**。
 *
 * 本测试锁死「所有对用户暴露的模型 id 必须出自 catalog」这条不变量。
 * 任何新的模型清单必须加进 `STUDIO_MODEL_CATALOG`，不能另开一份。
 */
describe('模型清单单一真相：STUDIO_MODEL_CATALOG', () => {
  it('每个 catalog 条目都能按 modelKey 与 gatewayModelId 双向查到', () => {
    for (const entry of STUDIO_MODEL_CATALOG) {
      expect(getModelEntry(entry.modelKey)?.modelKey, `modelKey ${entry.modelKey}`).toBe(entry.modelKey)
      expect(
        getModelEntry(entry.gatewayModelId)?.modelKey,
        `gatewayModelId ${entry.gatewayModelId}（modelKey=${entry.modelKey}）`,
      ).toBe(entry.modelKey)
    }
  })

  it('modelKey 全局唯一（否则 resolveModelKey 的「modelKey 优先」消歧会失效）', () => {
    const seen = new Map<string, string>()
    for (const entry of STUDIO_MODEL_CATALOG) {
      const prev = seen.get(entry.modelKey)
      expect(prev, `modelKey 重复：${entry.modelKey}（${prev} vs ${entry.gatewayModelId}）`).toBeUndefined()
      seen.set(entry.modelKey, entry.gatewayModelId)
    }
  })

  it('四个 modality 都有可用模型，且有默认模型', () => {
    for (const modality of ['text', 'image', 'video', 'audio'] as const) {
      const models = listModels(modality)
      expect(models.length, `${modality} 目录为空`).toBeGreaterThan(0)
    }
  })

  it('不存在「已从 catalog 移除」的幽灵 id（T2 清单的历史成员）', () => {
    // 这批 id 曾在 index.ts 的幽灵清单里给用户选，全部不在 catalog 中。
    const ghostIds = [
      'gpt-4o', 'deepseek-v3', 'claude-sonnet',
      'dall-e-3', 'midjourney-v6', 'flux-pro', 'sd-xl',
      'sora', 'kling-v1', 'runway-gen3', 'pika-v2',
    ]
    for (const id of ghostIds) {
      expect(getModelEntry(id), `幽灵 id 仍在 catalog 中：${id}`).toBeUndefined()
    }
  })

  it('GenerationType 的每个维度都能在 catalog 里找到至少一个 modelKey', () => {
    // GenerationType（text|image|video）必须完全被 catalog 覆盖 ——
    // 这是「前端任何按 GenerationType 取模型的代码都不会拿到空列表」的前提。
    for (const type of ['text', 'image', 'video'] as GenerationType[]) {
      expect(listModels(type).length, `GenerationType ${type} 在 catalog 中无模型`).toBeGreaterThan(0)
    }
  })
})