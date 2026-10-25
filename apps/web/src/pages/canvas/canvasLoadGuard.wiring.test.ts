/**
 * 画布「整份覆盖保存」守卫的**接线契约**（静态守卫）。
 *
 * ⭐ 为什么要有这层守卫：`canvasLoadGuard.ts` 只判「该不该拦」，
 *   真正的价值全在**接线**上——
 *   ① 守卫必须落在 `api.put('/sessions/:id')` **之前**（否则拦不住覆盖）；
 *   ② 加载成功必须把状态置 `loaded`（否则新建的空画布永远存不下去）；
 *   ③ 加载失败必须置 `failed`（否则失败态的一次自动保存就会抹掉真画布）；
 *   ④ 被拦下的保存必须在加载成功后**补做**（否则用户在等待期画的内容会丢）。
 *
 * 断言全部落在**可观测出口**（源文件里的调用位置），不靠"某个函数被提到过"。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const code = readFileSync(resolve(here, '../CanvasPage.vue'), 'utf8')

/** 取某个函数体的源码片段（按大括号配平）。 */
function bodyOf(fnName: string): string {
  const start = code.indexOf(`async function ${fnName}(`)
  if (start < 0) throw new Error(`找不到函数 ${fnName}`)
  let depth = 0
  let i = code.indexOf('{', start)
  for (; i < code.length; i++) {
    if (code[i] === '{') depth++
    else if (code[i] === '}') {
      depth--
      if (depth === 0) break
    }
  }
  return code.slice(start, i + 1)
}

describe('画布整份覆盖保存守卫 · 接线契约', () => {
  it('① 守卫必须落在整份 PUT 之前（拦不住覆盖就等于没修）', () => {
    const body = bodyOf('saveCanvas')
    const guardAt = body.indexOf('shouldBlockCanvasOverwrite(')
    const putAt = body.indexOf("api.put(`/sessions/${sessionId.value}`")
    expect(guardAt, 'saveCanvas 必须调用 shouldBlockCanvasOverwrite').toBeGreaterThan(-1)
    expect(putAt, 'saveCanvas 里必须定位得到整份 PUT').toBeGreaterThan(-1)
    expect(guardAt, '守卫必须早于整份 PUT（否则空画布照样覆盖真画布）').toBeLessThan(putAt)
    // ⚠️ 静态文本守卫的**已知局限**（沿用仓库既有做法，见 tail-visibility.test.ts 的同类注释）：
    //    它抓得到「守卫整段被删/被挪到 PUT 之后」，抓不到「人为把条件短路成 false」。
    //    ⇒ 真正的行为防线是纯函数用例（canvasLoadGuard.test.ts）+ 生产 e2e。
    //    这里额外锁住「守卫分支必须真的 return」——否则守卫形同虚设。
    //    ⚠️ 取区间不能按第一个 `}` 截断：守卫块内还有嵌套 if（会被先撞上）⇒ 用窗口。
    const guardWindow = body.slice(guardAt, guardAt + 500)
    expect(guardWindow, '守卫分支必须 return（否则拦不住整份 PUT）').toContain('return')
  })

  it('② 加载成功必须置 loaded（新建的空画布也要能保存）', () => {
    const body = bodyOf('loadSession')
    expect(body).toContain("canvasLoadState.value = 'loading'")
    expect(body).toContain("canvasLoadState.value = 'loaded'")
  })

  it('③ 加载失败必须置 failed（失败态不得整份覆盖）', () => {
    const body = bodyOf('loadSession')
    expect(body).toContain("canvasLoadState.value = 'failed'")
  })

  it('④ 被拦下的保存必须在加载成功后补做（否则用户在等待期画的内容会丢）', () => {
    const load = bodyOf('loadSession')
    const save = bodyOf('saveCanvas')
    expect(save, 'saveCanvas 必须记住被拦下的保存').toContain('deferredCanvasSave = true')
    expect(load, '加载成功后必须补做被拦下的保存').toMatch(/deferredCanvasSave\s*=\s*false[\s\S]{0,200}void saveCanvas\(\)/)
  })

  it('⑤ 守卫拦下时必须可见（保存失败态 + 一次性提示）', () => {
    const body = bodyOf('saveCanvas')
    expect(body).toContain('saveFailed.value = true')
    expect(body).toContain('已暂停自动保存')
  })
})
