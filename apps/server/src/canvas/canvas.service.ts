import { Inject, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'

@Injectable()
export class CanvasService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** 列表只返回卡片元数据（id/title/时间戳），不带 canvasData 等大字段——
   *  2026-10-19 修复：全量返回时 165 个项目可达 2.3MB（下载 6s+），移动端抽屉
   *  项目区长时间空白；消费方（WorkflowPage 入口分发 / AgentSideRail 项目卡片）
   *  均只用这三个字段。取完整画布数据走 update/get 单条接口。 */
  async list(userId: string) {
    return this.prisma.session.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, title: true, createdAt: true, updatedAt: true },
    })
  }

  async create(userId: string, title?: string) {
    return this.prisma.session.create({
      data: { userId, title: title ?? '未命名画布' },
    })
  }

  async update(id: string, userId: string, data: { title?: string; canvasData?: string }) {
    const session = await this.prisma.session.findFirst({ where: { id, userId } })
    if (!session) throw new NotFoundException('Session not found')
    return this.prisma.session.update({ where: { id }, data })
  }
}
