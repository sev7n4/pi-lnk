// 模型配置视图状态机（2026-11-20 PC/移动双形态共用）：iOS push/pop 单源。
import { describe, expect, it } from 'vitest'
import { useModelConfigView } from './useModelConfigView'

describe('useModelConfigView', () => {
  it('初始为列表视图，标题「选择模型」、无返回', () => {
    const v = useModelConfigView()
    expect(v.view.value).toBe('list')
    expect(v.title.value).toBe('选择模型')
    expect(v.showBack.value).toBe(false)
  })

  it('openConfig → 标题「模型配置」、showBack=true', () => {
    const v = useModelConfigView()
    v.openConfig()
    expect(v.view.value).toBe('config')
    expect(v.title.value).toBe('模型配置')
    expect(v.showBack.value).toBe(true)
  })

  it('back：config→list；thinking/context→config（iOS push/pop 语义）', () => {
    const v = useModelConfigView()
    v.openConfig()
    v.view.value = 'thinking'
    v.back()
    expect(v.view.value).toBe('config')
    v.view.value = 'context'
    v.back()
    expect(v.view.value).toBe('config')
    v.back()
    expect(v.view.value).toBe('list')
    // list 上 back 是 no-op，不抛错
    v.back()
    expect(v.view.value).toBe('list')
  })

  it('reset 回列表（关闭弹层/选择模型后复位）', () => {
    const v = useModelConfigView()
    v.openConfig()
    v.view.value = 'context'
    v.reset()
    expect(v.view.value).toBe('list')
    expect(v.title.value).toBe('选择模型')
  })
})
