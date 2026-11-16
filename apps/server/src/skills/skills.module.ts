// 文件：apps/server/src/skills/skills.module.ts
// M1-1 技能控制面模块（PrismaModule 是 @Global()，无需显式 import）。
import { Module } from '@nestjs/common'
import { SkillsController } from './skills.controller.js'
import { SkillsService } from './skills.service.js'

@Module({
  controllers: [SkillsController],
  providers: [SkillsService],
  exports: [SkillsService],
})
export class SkillsModule {}
