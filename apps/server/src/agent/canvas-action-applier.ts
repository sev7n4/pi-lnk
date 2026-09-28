/**
 * 画布动作落地（`applyCanvasActions`）的注入点——两产品线拆分 path A 的 seam。
 *
 * 背景：`applyCanvasActions` 是**纯画布领域逻辑**，却被 agent 侧用来落地动作，
 * 归属至今未定（测绘文档 §6 问题 1）。在归属定下来之前先做成可替换的注入点：
 * 现在默认指向 `@lnkpi/agent` 的实现，将来无论归属判给画布侧、还是 agent 产品线
 * 自己实现一套，都只需在 AgentModule 换掉 `useValue`，**调用点零改动**。
 *
 * ⚠️ 本文件不含任何策略：只定义「实现可以替换」这件事，不决定替换成什么。
 */
import { applyCanvasActions } from '@lnkpi/agent'
import type { CanvasActionApplier } from '@lnkpi/shared'

/** DI token（Symbol 而非字符串，避免与其它 provider 撞名）。 */
export const CANVAS_ACTION_APPLIER = Symbol('CANVAS_ACTION_APPLIER')

/** 默认实现：当前的 `@lnkpi/agent` 版本。 */
export const defaultCanvasActionApplier: CanvasActionApplier = {
  apply: (data, actions) => applyCanvasActions(data, actions),
}
