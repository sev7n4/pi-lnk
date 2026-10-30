import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as gateModule from './agentInterruptGate'
import {
  filterAssistantVisibleText,
  filterUserVisibleText,
  isMachineOnlyVisibleText,
  isRunCancelledState,
} from './agentInterruptGate'

describe('isRunCancelledState', () => {
  it('detects cancelled thread state', () => {
    expect(isRunCancelledState({ phase: 'cancelled', runCancelled: true })).toBe(true)
    expect(isRunCancelledState({ phase: 'done', runCancelled: false })).toBe(false)
  })

  it('is false for nullish state', () => {
    expect(isRunCancelledState(null)).toBe(false)
    expect(isRunCancelledState(undefined)).toBe(false)
    expect(isRunCancelledState({})).toBe(false)
  })
})

describe('filterAssistantVisibleText', () => {
  it('strips macro, scheme, and delivery machine payload lines', () => {
    const raw = [
      '请确认宏观方案',
      '__scheme_decision__{"action":"confirm_schemes","selections":{}}',
      '__macro_scheme_decision__{"action":"confirm","selected_ids":["A"]}',
      '__delivery_decision__{"action":"confirm_delivery","selections":{}}',
      '底部说明',
    ].join('\n')
    expect(filterAssistantVisibleText(raw)).toBe('请确认宏观方案\n底部说明')
  })

  it('returns empty string when only machine payloads present', () => {
    expect(
      filterAssistantVisibleText('__macro_scheme_decision__{"action":"confirm"}'),
    ).toBe('')
  })

  it('strips quoted machine payload lines (user confirm bubbles)', () => {
    expect(
      filterUserVisibleText(
        '"__macro_scheme_decision__{\\"action\\":\\"confirm\\",\\"selected_ids\\":[\\"A\\",\\"B\\"]}"',
      ),
    ).toBe('')
  })

  it('hides the new-task machine message from user bubbles', () => {
    expect(filterUserVisibleText('__new_task__')).toBe('')
  })

  it('filters internal QA error strings from assistant text', () => {
    expect(
      filterAssistantVisibleText('识图模型返回格式异常，请重试\n自动识图暂时不可用'),
    ).toBe('自动识图暂时不可用')
  })

  it('strips bare flow-end error codes and toolCalls JSON', () => {
    expect(filterAssistantVisibleText('流程结束。dialog_draft_parse_failed')).toBe(
      '流程未能完成，请补充说明后重试。',
    )
    expect(
      filterAssistantVisibleText('macro \'A\' has 11 shots (max 8)'),
    ).toBe('')
    expect(
      filterAssistantVisibleText('{"toolCalls":[{"toolName":"foo"}]}'),
    ).toBe('')
  })
})

describe('isMachineOnlyVisibleText', () => {
  it('is true only for pure machine payload', () => {
    expect(isMachineOnlyVisibleText('__new_task__')).toBe(true)
    expect(isMachineOnlyVisibleText('正常的一句话')).toBe(false)
  })
})

/**
 * 回归锁（2026-10-06 ①）：确认卡片机制整体下线后，本模块**不得**再导出任何
 * gate / chip 构造器 —— 一旦有人把它们加回来，这条用例先红。
 *
 * 判据用「导出键集合」而不是源码字符串断言：字符串断言会被注释命中（假绿/假红）。
 */
describe('确认卡片机制已下线（不得复活）', () => {
  const BANNED_EXPORTS = [
    'chipSetFromInterrupt',
    'interruptPayloadFromThreadState',
    'resolveGatePrimaryActionLabel',
    'resolveImageQaOptions',
    'resolveImageQaTitle',
    'resolveImageQaBodyText',
    'resolveImageQaChecks',
    'buildRetakeContinueMessage',
    'isRetakePendingPhase',
    'buildSchemeConfirmMessage',
    'buildMacroSchemeConfirmMessage',
    'buildMacroAbFooterHint',
    'buildDeliveryConfirmMessage',
    'buildDeliveryRefineMessage',
    'buildDeliverySwitchMessage',
    'buildShotDeliveryConfirmMessage',
    'buildShotDeliverySwitchMessage',
    'buildClientDeliveryGroups',
    'defaultSchemeSelections',
    'defaultMacroSchemeSelection',
    'toggleMacroSchemeSelection',
    'defaultDeliverySelections',
    'defaultShotDeliverySelections',
    'selectableImageTypes',
    'IMAGE_QA_OPTIONS',
  ]

  it('模块导出里不含任何 gate / chip 构造器', () => {
    const exported = Object.keys(gateModule)
    expect(exported).not.toHaveLength(0)
    expect(exported.filter((name) => BANNED_EXPORTS.includes(name))).toEqual([])
  })

  it('保留的三个文本过滤函数 + 终态判定仍在', () => {
    const exported = Object.keys(gateModule)
    expect(exported).toEqual(
      expect.arrayContaining([
        'filterAssistantVisibleText',
        'filterUserVisibleText',
        'isMachineOnlyVisibleText',
        'isRunCancelledState',
      ]),
    )
  })
})

/**
 * K4 反向守卫（F1，审查 2026-10-29）：机器载荷清单单源是 `@lnkpi/shared`
 * 的 `machinePayloads`，本文件不得再持有清单字面量副本。
 *
 * 判据对**源码文本**（strip 注释后）扫描——导出键集合判不出「字面量复制回本文件」，
 * 而裸字符串扫描会被本文件的说明性注释命中（假红），也会被注释里的一句提及放过
 * （假绿），故必须先 stripComments 再断言。
 */
describe('K4 反向守卫：清单字面量不得回流本文件', () => {
  // stripComments 惯例同 SignatureHero.test.ts：`://` 不被当行注释吞掉。
  const stripComments = (src: string) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:\w])\/\/.*$/gm, '$1')

  // ⚠️ fileURLToPath 必须收字符串而非 URL 对象（既有坑，见 SignatureHero.test.ts）。
  const HERE = dirname(fileURLToPath(import.meta.url))

  const gateSource = stripComments(
    readFileSync(join(HERE, 'agentInterruptGate.ts'), 'utf8'),
  )

  it('清单改由 @lnkpi/shared import（strip 注释后仍须命中真实 import 语句）', () => {
    expect(gateSource).toContain('@lnkpi/shared')
  })

  it('不含清单字面量反例（__new_task__）——复制回任何一条即先红', () => {
    expect(gateSource).not.toContain('__new_task__')
  })
})
