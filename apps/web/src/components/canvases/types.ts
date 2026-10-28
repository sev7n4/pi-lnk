import type { ProjectCard } from '@/composables/useProjectWorkspace'
import type { ProjectCover } from '@/utils/projectCoverFallback'
import type { useProjectManager } from '@/composables/useProjectManager'

/** 创作空间列表/卡墙共用的行视图模型（规格 §13.3：预解析封面三态）。 */
export type ProjectRowVM = ProjectCard & { cover: ProjectCover }

/** useProjectManager 单例返回形态（视图组件经 prop 接收，避免重复实例化）。 */
export type ProjectManagerApi = ReturnType<typeof useProjectManager>
