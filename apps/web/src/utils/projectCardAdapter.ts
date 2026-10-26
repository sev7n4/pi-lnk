import type { ProjectCard } from '@/composables/useProjectWorkspace'
import type { Session } from '@lnkpi/shared'

/**
 * ProjectCard → SessionLike 恒等映射（**临时件**，规格 v2 §12 Task 3）。
 *
 * 主页 compact 网格在 P3 品牌化（删区块）前仍消费 SessionCard；SessionCard 的
 * props 类型是 `Session`，而数据面已切到 useProjectWorkspace 的 ProjectCard。
 * 本 adapter 只映射 SessionCard 实际消费的字段（id/title/updatedAt + coverUrl，
 * 见 extractSessionCover 的消费面），**显式白名单，防夹带**。
 *
 * ⛔ P3 删主页「我的项目」区块时本文件与测试一并删除——勿复用到别处。
 */
export type SessionLike = Pick<Session, 'id' | 'title' | 'updatedAt'> & {
  coverUrl: string | null
  coverNodeId: string | null
}

export function toSessionLike(p: ProjectCard): SessionLike {
  return {
    id: p.id,
    title: p.title,
    updatedAt: p.updatedAt,
    coverUrl: p.coverUrl,
    coverNodeId: p.coverNodeId,
  }
}
