// 文件：apps/server/src/skills/skills.controller.ts
// M1-1 十端点（规格 v1 §5.4 / v2 §5.4）。鉴权：per-route AuthGuard（request.user.sub）。
// ⚠️ ValidationPipe(transform, whitelist)：DTO 逐字段加装饰器，漏加的字段会被剥掉
// （AGENTS.md「Nest/前端/画布」教训）——每个入参字段都有透传断言（集成测试覆盖）。
import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common'
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator'
import { AuthGuard } from '../auth/auth.guard'
import { SkillsService } from './skills.service.js'

class ImportSkillDto {
  /// 粘贴的 SKILL.md 原文（≤4MB 上限在 parse 层裁决）
  @IsString()
  @MinLength(1)
  @MaxLength(4 * 1024 * 1024 + 1)
  text!: string

  /// 来源通路标记（M1-A3：两通路归一仅 sourceType 不同）
  @IsOptional()
  @IsIn(['paste', 'zip', 'url', 'github'])
  sourceType?: string
}

class SetEnabledDto {
  @IsBoolean()
  enabled!: boolean
}

class UninstallBatchDto {
  @IsString({ each: true })
  ids!: string[]

  /// 二次确认标记（M1-A8：false 必拒）
  @IsBoolean()
  confirmed!: boolean
}

class InvokeDto {
  @IsOptional()
  @IsIn(['implicit', 'explicit', 'routed'])
  intent?: 'implicit' | 'explicit' | 'routed'
}

@Controller('skills')
export class SkillsController {
  constructor(private readonly skills: SkillsService) {}

  /** 技能目录：q / vertical / tag / sort 四维（M1-A10；search ≠ install）。 */
  @Get('catalog')
  async getCatalog(
    @Query('q') q?: string,
    @Query('vertical') vertical?: string,
    @Query('tag') tag?: string,
    @Query('sort') sort?: string,
    @Query('limit') limit?: string,
  ) {
    return this.skills.getCatalog({ q, vertical, tag, sort, limit })
  }

  /** 我的技能（登录用户视角；跨用户隔离 M1-A1）。 */
  @Get('mine')
  @UseGuards(AuthGuard)
  async getMine(@Req() req: { user: { sub: string } }) {
    return this.skills.getMine(req.user.sub)
  }

  /** 运行时内置技能清单（薄转发 pi-runtime /skills；⚠️ 必须排在 @Get(':id') 之前，否则被吞）。 */
  @Get('runtime')
  @UseGuards(AuthGuard)
  async getRuntime(@Req() _req: { user: { sub: string } }) {
    return this.skills.listRuntimeSkills()
  }

  /** 自定义加载：粘贴 SKILL.md（M1-A1 写入面）。 */
  @Post('import')
  @UseGuards(AuthGuard)
  async import(@Req() req: { user: { sub: string } }, @Body() dto: ImportSkillDto) {
    return this.skills.importSkill(req.user.sub, dto.text, dto.sourceType ?? 'paste')
  }

  /** 搜索候选（零安装副作用）。 */
  @Get('search')
  @UseGuards(AuthGuard)
  async search(@Query('q') q?: string) {
    return this.skills.search(q ?? '')
  }

  /** 目录一键安装（M1-A3 catalog 通路）。 */
  @Post(':packageHash/install')
  @UseGuards(AuthGuard)
  async install(@Req() req: { user: { sub: string } }, @Param('packageHash') packageHash: string) {
    return this.skills.installFromCatalog(req.user.sub, packageHash)
  }

  /** 启用 / 关闭（M1-A7：开关只写用户行，不改包行）。 */
  @Patch(':id/enabled')
  @UseGuards(AuthGuard)
  async setEnabled(
    @Req() req: { user: { sub: string } },
    @Param('id') id: string,
    @Body() dto: SetEnabledDto,
  ) {
    return this.skills.setEnabled(req.user.sub, id, dto.enabled)
  }

  /** 批量卸载（M1-A8：逐项审计；卸载 ≠ 关闭）。 */
  @Post('uninstall')
  @UseGuards(AuthGuard)
  async uninstall(@Req() req: { user: { sub: string } }, @Body() dto: UninstallBatchDto) {
    return this.skills.uninstall(req.user.sub, dto.ids, dto.confirmed)
  }

  /** 单个卸载（DELETE 入口：与批量同守卫同审计；confirmed 走 query，避开 DELETE body 兼容面）。 */
  @Delete(':id')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  async deleteOne(
    @Req() req: { user: { sub: string } },
    @Param('id') id: string,
    @Query('confirmed') confirmed?: string,
  ) {
    if (confirmed !== 'true') throw new BadRequestException('卸载需要二次确认标记（confirmed=true）')
    return this.skills.uninstall(req.user.sub, [id], true)
  }

  /** 回滚到上一版本（M1-A4）。 */
  @Post(':id/rollback')
  @UseGuards(AuthGuard)
  async rollback(@Req() req: { user: { sub: string } }, @Param('id') id: string) {
    return this.skills.rollback(req.user.sub, id)
  }

  /** 显式调用裁决（M1-A9：denied 时 403 + 审计；允许时返回 skill 名供 forceSkills 管道）。 */
  @Post(':id/invoke')
  @UseGuards(AuthGuard)
  async invoke(@Req() req: { user: { sub: string } }, @Param('id') id: string, @Body() dto: InvokeDto) {
    return this.skills.invoke(req.user.sub, id, dto.intent ?? 'explicit')
  }

  /** 技能详情（兼容评分 + 不可用动作清单，§6.6）。 */
  @Get(':id')
  @UseGuards(AuthGuard)
  async getDetail(@Req() req: { user: { sub: string } }, @Param('id') id: string) {
    return this.skills.getDetail(req.user.sub, id)
  }
}
