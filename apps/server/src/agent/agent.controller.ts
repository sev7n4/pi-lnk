import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common'
import { IsArray, IsBoolean, IsIn, IsOptional, IsString, ValidateNested } from 'class-validator'
import { Type } from 'class-transformer'
import type { Request, Response } from 'express'
import { AuthGuard } from '../auth/auth.guard'
import { SessionsService } from '../sessions/sessions.service'
import { AgentCanvasToolsService } from './agent-canvas-tools.service'
import { AgentService } from './agent.service'

const SESSION_FORBIDDEN_HINT =
  '⚠️ 此画布不属于当前账号，无法写入。请返回工作台新建画布，或使用画布所有者账号登录。'

class SidebarAttachmentDto {
  @IsString()
  id!: string

  @IsIn(['text', 'image', 'video', 'audio'])
  mediaType!: 'text' | 'image' | 'video' | 'audio'

  @IsIn(['upload', 'asset', 'canvasNode'])
  sourceKind!: 'upload' | 'asset' | 'canvasNode'

  @IsString()
  label!: string

  @IsOptional()
  @IsString()
  url?: string

  @IsOptional()
  @IsString()
  text?: string

  @IsOptional()
  @IsString()
  sourceNodeId?: string

  /** product_visual: product vs model attachment role (forwarded to pi-runtime). */
  @IsOptional()
  @IsIn(['product', 'model'])
  role?: 'product' | 'model'
}

class ConversationDto {
  @IsString()
  sessionId!: string

  @IsString()
  message!: string

  /** LangGraph thread；新建对话时前端换新 id，与画布 sessionId 解耦 */
  @IsOptional()
  @IsString()
  threadId?: string

  /** Dock 技能 id（UI 命名），Nest 映射后转接 pi-runtime forceSkills */
  @IsOptional()
  @IsString()
  skillId?: string

  /** W28: 单节点快速生成目标画布 node id */
  @IsOptional()
  @IsString()
  focusNodeId?: string

  /** 规划阶段 LLM 模型（含 channel 编码），Nest 解析凭证后转发 */
  @IsOptional()
  @IsString()
  model?: string

  /** 侧边栏参考素材（本轮 user turn） */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SidebarAttachmentDto)
  attachments?: SidebarAttachmentDto[]

  /** 参考素材顺序（attachment id 列表） */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  refOrder?: string[]

  /** 消息内 @ 提及的 refKey（优先参考） */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  mentionedKeys?: string[]

  /** DeepSeek 深度思考（默认关；与文本节点 Dock 对齐） */
  @IsOptional()
  @IsBoolean()
  thinking?: boolean

  @IsOptional()
  @IsIn(['high', 'max'])
  thinkingEffort?: 'high' | 'max'
}

class OptimizePromptDto {
  @IsString()
  prompt!: string

  @IsOptional()
  @IsString()
  style?: string
}

/** Phase 2c.1: browser-facing cancel for pending_confirm (Jwt; not AgentInternalGuard). */
class ClearProposeDto {
  @IsString()
  sessionId!: string

  @IsString()
  nodeId!: string
}

class ListAgentThreadsQueryDto {
  @IsString()
  sessionId!: string
}

class GetAgentMessagesQueryDto {
  @IsString()
  sessionId!: string

  @IsString()
  threadId!: string
}

@Controller('agent')
export class AgentController {
  constructor(
    @Inject(AgentService) private readonly agentService: AgentService,
    @Inject(SessionsService) private readonly sessionsService: SessionsService,
    @Inject(AgentCanvasToolsService) private readonly canvasTools: AgentCanvasToolsService,
  ) {}

  @Get('capabilities/list')
  getCapabilities() {
    const data = this.agentService.getCapabilities()
    return { code: 0, message: 'ok', data }
  }

  @Get('chat/threads')
  async listThreads(@Query() query: ListAgentThreadsQueryDto) {
    const data = await this.agentService.listThreads(query.sessionId)
    return { code: 0, message: 'ok', data }
  }

  @Get('chat/user/messages')
  async getMessages(@Query() query: GetAgentMessagesQueryDto) {
    const data = await this.agentService.getMessages(query.sessionId, query.threadId)
    return { code: 0, message: 'ok', data }
  }

  /** 前端心跳：探 pi-runtime 是否可达（老 agent-runtime 已退役）。 */
  @Get('runtime-health')
  async runtimeHealth() {
    const data = await this.agentService.checkRuntimeHealth()
    return { code: 0, message: 'ok', data }
  }

  /**
   * Phase 2c.1: clear propose pending_confirm → draft.
   * Browser uses Jwt session ownership; runtime keeps POST /agent/internal/clear-propose-generation.
   */
  @Post('clear-propose')
  @UseGuards(AuthGuard)
  async clearPropose(
    @Body() dto: ClearProposeDto,
    @Req() req: Request & { user: { sub: string } },
  ) {
    await this.sessionsService.findOne(dto.sessionId, req.user.sub)
    const data = await this.canvasTools.clearProposeGeneration({
      sessionId: dto.sessionId,
      userId: req.user.sub,
      nodeId: dto.nodeId,
    })
    return { code: 0, message: 'ok', data }
  }

  /** W12: 重连时的 checkpoint 相位。老 LangGraph runtime 已退役 → 恒 null（端点保留给前端）。 */
  @Get('thread-state')
  @UseGuards(AuthGuard)
  async threadState(
    @Query('threadId') threadId: string,
  ) {
    const data = await this.agentService.getThreadState(threadId)
    return { code: 0, message: 'ok', data }
  }

  /** W27: 相位时间线。同 thread-state：checkpoint 历史随老 runtime 退役 → 恒 null。 */
  @Get('thread-timeline')
  @UseGuards(AuthGuard)
  async threadTimeline(
    @Query('threadId') threadId: string,
  ) {
    const data = await this.agentService.getThreadTimeline(threadId)
    return { code: 0, message: 'ok', data }
  }

  @Post('chat/optimize-prompt')
  async optimizePrompt(@Body() dto: OptimizePromptDto) {
    const data = await this.agentService.optimizePrompt(dto.prompt, dto.style)
    return { code: 0, message: 'ok', data }
  }

  @Post('chat/conversation')
  @UseGuards(AuthGuard)
  async conversation(
    @Body() dto: ConversationDto,
    @Req() req: Request & { user: { sub: string } },
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')

    // Idempotency key check — prevent duplicate requests from network retries
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined
    if (idempotencyKey) {
      const cached = await this.agentService.checkIdempotencyKey(idempotencyKey)
      if (cached) {
        const text =
          cached.status === 'processing'
            ? '上一轮仍在处理中，请稍候…'
            : cached.resultSummary || '已完成'
        res.write(`data: ${JSON.stringify({ type: 'text_delta', data: { text } })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
    }

    try {
      await this.sessionsService.findOne(dto.sessionId, req.user.sub)
    } catch (err) {
      if (err instanceof ForbiddenException) {
        res.write(
          `data: ${JSON.stringify({ type: 'text_delta', data: { text: SESSION_FORBIDDEN_HINT } })}\n\n`,
        )
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      throw err
    }

    try {
      for await (const event of this.agentService.streamConversation(
        dto.sessionId,
        dto.message,
        req.user.sub,
        dto.threadId,
        idempotencyKey,
        dto.skillId,
        dto.model,
        dto.focusNodeId,
        dto.attachments,
        dto.refOrder,
        dto.mentionedKeys,
        dto.thinking,
        dto.thinkingEffort,
      )) {
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      res.write('data: [DONE]\n\n')
    } catch (err) {
      res.write(`data: ${JSON.stringify({ type: 'error', data: { message: String(err) } })}\n\n`)
    }

    res.end()
  }
}
