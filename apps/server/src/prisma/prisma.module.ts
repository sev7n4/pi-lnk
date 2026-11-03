import { Global, Module } from '@nestjs/common'
import { PrismaService } from './prisma.service'
import { buildTerminalWriteTap } from '../studio/terminal-write-tap'
import { terminalEventBus } from '../studio/terminal-events'

/** flag 解析（Review Focus #1）：仅精确 'false' 才关；其余（含未设/'true'/'0'/'off'）皆开。 */
export function isTerminalWriteTapEnabled(): boolean {
  return process.env.LNKPI_TERMINAL_WRITE_TAP !== 'false'
}

/**
 * 构建 PrismaService：按 flag 挂载 terminal-write-tap 扩展。
 * ⚠️ $extends 返回新 client，丢失 onModuleInit/onModuleDestroy（生命周期方法）；
 * 不重绑会静默断 DB 连接。此处重绑，连接照常；消费者类型保持 PrismaService 不变。
 */
const buildPrismaService = (): PrismaService => {
  const base = new PrismaService()
  if (!isTerminalWriteTapEnabled()) return base // flag 关 = 不挂扩展，行为逐字节一致
  const extended = (base.$extends(buildTerminalWriteTap(terminalEventBus) as never) as unknown) as PrismaService
  extended.onModuleInit = () => extended.$connect()
  extended.onModuleDestroy = () => extended.$disconnect()
  return extended
}

@Global()
@Module({
  providers: [{ provide: PrismaService, useFactory: buildPrismaService }],
  exports: [PrismaService],
})
export class PrismaModule {}
