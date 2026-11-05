import { describe, expect, it } from 'vitest'
import {
  SidebarAttachmentSchema,
  validateSidebarAttachments,
  SIDEBAR_ATTACHMENT_MAX,
  resolveSidebarRef,
  imageSidebarRefKeys,
} from './sidebarAttachments'

describe('SidebarAttachmentSchema', () => {
  it('accepts image upload', () => {
    const parsed = SidebarAttachmentSchema.parse({
      id: 'a1',
      mediaType: 'image',
      sourceKind: 'upload',
      label: 'product.jpg',
      url: 'https://cdn.example.com/a.jpg',
      role: 'product',
    })
    expect(parsed.mediaType).toBe('image')
    expect(parsed.role).toBe('product')
  })

  it('rejects blob url', () => {
    expect(() =>
      validateSidebarAttachments([
        {
          id: 'a1',
          mediaType: 'image',
          sourceKind: 'upload',
          label: 'x',
          url: 'blob:http://localhost/abc',
        },
      ]),
    ).toThrow(/blob/)
  })

  it('rejects more than max', () => {
    const items = Array.from({ length: SIDEBAR_ATTACHMENT_MAX + 1 }, (_, i) => ({
      id: `a${i}`,
      mediaType: 'image' as const,
      sourceKind: 'upload' as const,
      label: 'x',
      url: `https://cdn.example.com/${i}.jpg`,
    }))
    expect(() => validateSidebarAttachments(items)).toThrow(/最多/)
  })
})

describe('resolveSidebarRef / imageSidebarRefKeys（VISP S-7，与侧栏块 I 编号同源）', () => {
  const atts = [
    { text: '产品文案', mediaType: 'text' },
    { url: 'http://h:8888/api/uploads/u1/a.png', mediaType: 'image' },
    { url: 'http://h:8888/api/uploads/u1/b.jpg', mediaType: 'image' },
    { url: 'http://h:8888/api/uploads/u1/c.mp4', mediaType: 'video' },
  ]

  it('1a: I1/I2 → 对应图片 url（跨 mediaType 计数正确）', () => {
    expect(resolveSidebarRef(atts, 'I1')).toBe('http://h:8888/api/uploads/u1/a.png')
    expect(resolveSidebarRef(atts, 'I2')).toBe('http://h:8888/api/uploads/u1/b.jpg')
  })

  it('1b: 脏输入容忍（小写/空白）', () => {
    expect(resolveSidebarRef(atts, ' i1 ')).toBe('http://h:8888/api/uploads/u1/a.png')
  })

  it('1c: 非图片 ref / 越界 / 非法形态 → null', () => {
    expect(resolveSidebarRef(atts, 'T1')).toBeNull()
    expect(resolveSidebarRef(atts, 'V1')).toBeNull()
    expect(resolveSidebarRef(atts, 'I9')).toBeNull()
    expect(resolveSidebarRef(atts, 'n_abc')).toBeNull()
    expect(resolveSidebarRef(atts, '')).toBeNull()
  })

  it('1d: 附件缺 url 或列表为空 → null / 空 keys', () => {
    expect(resolveSidebarRef([{ mediaType: 'image' }], 'I1')).toBeNull()
    expect(imageSidebarRefKeys(atts)).toEqual(['I1', 'I2'])
    expect(imageSidebarRefKeys([])).toEqual([])
  })
})
