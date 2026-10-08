import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common'
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator'
import { Type } from 'class-transformer'
import type { Request, Response } from 'express'
import { AuthGuard } from '../auth/auth.guard'
import { SessionsService } from '../sessions/sessions.service'
import { AgentCanvasToolsService } from './agent-canvas-tools.service'
import { AgentMemoryService } from './agent-memory.service'
import { AgentService } from './agent.service'
import {
  loadRegistry,
  renderStatic,
  renderStaticFallback,
  resolveRegistryRoot,
} from './pi-runtime/prompt-registry.loader'

const SESSION_FORBIDDEN_HINT =
  '⚠️ 此画布不属于当前账号，无法写入。请返回工作台新建画布，或使用画布所有者账号登录。'

/** 诊断端点要展示的 4 种规则组组合——与 assembler 实际会遇到的一致。 */
const DIAG_GROUP_SETS: Array<Array<'core' | 'writeTools' | 'genTools'>> = [
  ['core'],
  ['core', 'writeTools'],
  ['core', 'genTools'],
  ['core', 'writeTools', 'genTools'],
]

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

  /**
   * SEL-REF：指代信号（本轮画布选中的节点 id 集合；单选与框选统一走这里）。
   * 唯一新增上行字段；`focusNodeId` 自本字段派生（见 agent.service.ts）。
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(200)
  selectedNodeIds?: string[]

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

  /**
   * ③ 重跑：pi 会话内目标消息的 entryId（来自 `pi_message_end` 事件）。
   * 提供时 Nest 先 fork 出「截断到该消息之前」的新分支会话，再在新线程上跑本轮 ——
   * 后端线程真实截断（与 WorkBuddy「编辑并重发」一致），而非前端裁剪。
   */
  @IsOptional()
  @IsString()
  branchFromEntryId?: string
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

/**
 * 前端「停止」按钮（AgentSideRail.cancelActiveStream → POST /api/agent/runs/cancel）。
 *
 * 该端点随老 runtime 退役被删，但前端一直在调 → 404 → 只断开 SSE、服务端 run 照跑。
 * 这里补回，语义改为转发 pi-runtime 的 abort（会话保留）。
 * threadId / reason 前端都会传，当前实现只用 sessionId；保留字段以免前端改动。
 */
class CancelRunDto {
  @IsString()
  sessionId!: string

  @IsOptional()
  @IsString()
  threadId?: string

  @IsOptional()
  @IsString()
  reason?: string
}

/** B-2：向阻塞中的确认类工具提交回答（sessionId 走路径参数，其余在 body）。 */
class AnswerPendingDto {
  @IsOptional()
  @IsString()
  threadId?: string

  @IsString()
  callId!: string

  /** 纯对象（key → string[]）；@IsArray 会误拒 Record 形态，@IsObject 保证 whitelist 不剥离 */
  @IsObject()
  answers!: Record<string, string[]>

  /**
   * 2026-10-06：`decline` = 用户**显式拒绝**（propose 卡的「取消」）⇒ pi-runtime 以
   * `aborted` 交还，工具侧回 `reason:"aborted"`，模型拿到确定性事实而非 SSOT 推断。
   * ⚠️ 必须带校验装饰器：`ValidationPipe({whitelist:true})` 会**静默剥掉**未装饰的字段
   * （main.ts:30，无 forbidNonWhitelisted ⇒ 不报错、无日志）。
   */
  @IsOptional()
  @IsIn(['answer', 'decline'])
  decision?: 'answer' | 'decline'
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

/** M6b：抑制标记请求体。reason 选填（缺省 'unspecified'，仅供排障追溯）。 */
class MemorySuppressDto {
  @IsString()
  memoryId!: string

  @IsOptional()
  @IsString()
  reason?: string
}

@Controller('agent')
export class AgentController {
  private readonly logger = new Logger(AgentController.name)

  constructor(
    @Inject(AgentService) private readonly agentService: AgentService,
    @Inject(SessionsService) private readonly sessionsService: SessionsService,
    @Inject(AgentCanvasToolsService) private readonly canvasTools: AgentCanvasToolsService,
    @Inject(AgentMemoryService) private readonly memory: AgentMemoryService,
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
   * W1b：提示词注册中心诊断（免鉴权，与 capabilities/list / runtime-health 同级）。
   *
   * 回答「线上现在跑的提示词是哪一版」——W1a 之后这本账只落在 Nest stdout，日志不落库、
   * 无其他对外端点，于是排查必须登机器看 docker logs。本端点把它变成一条 curl。
   *
   * ⚠️ **免鉴权的安全边界就是响应字段本身**：只出构建元信息（version/hash/entries/degraded），
   * 绝不出提示词正文、title、owner。这些 hash 都已随仓库与镜像公开，不构成新增泄露。
   * 加字段前先问一句「这是元信息还是内容」，是内容就得改成 AuthGuard。
   * 该白名单由 prompt-registry-diag.test.ts 锁死。
   */
  @Get('prompt-registry')
  async promptRegistry() {
    const snap = loadRegistry(resolveRegistryRoot())
    // 读盘真值而非启动快照：磁盘被换过要能立刻看出来。degraded 时改用 fallback 渲染，
    // 让 groupChars 如实反映「兜底确实在出文本」，而不是把降级误报成空静态段。
    const groupChars: Record<string, number> = {}
    for (const groups of DIAG_GROUP_SETS) {
      const text = snap.degraded
        ? renderStaticFallback(groups)
        : renderStatic(snap, groups)
      groupChars[groups.join('+')] = text.length
    }
    return {
      code: 0,
      message: 'ok',
      data: {
        registryVersion: snap.registryVersion,
        registryHash: snap.registryHash,
        degraded: snap.degraded,
        degradedReason: snap.degradedReason ?? null,
        entryCount: snap.entries.length,
        entries: snap.entries.map((e) => ({
          id: e.id,
          version: e.version,
          order: e.order,
          contentHash: e.contentHash,
        })),
        groupChars,
      },
    }
  }

  /**
   * M6b：晋升候选队列（spec docs/superpowers/specs/2026-10-06-memory-promotion-m6b-design.md §2.1）。
   *
   * 只读视图：本账号 scope='canvas' 记忆里同画布重复 ≥3 次的归一化内容。晋升动作不在此做——
   * 人工确认后改 rules/*.md + 同步 6 处 + prompt:lint + PR（docs/ops/memory-m6b-runbook.md）。
   *
   * ⚠️ 与上面 prompt-registry 端点相反：**必须鉴权**。按本仓判据「免鉴权的安全边界是响应字段本身」，
   * 这里的字段含**用户记忆内容**（sampleContents），不是构建元信息 ⇒ AuthGuard，且只出本人数据。
   */
  @Get('memory/promotion-candidates')
  @UseGuards(AuthGuard)
  async promotionCandidates(
    @Req() req: Request & { user: { sub: string } },
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = limit ? Number.parseInt(limit, 10) : undefined
    const data = await this.memory.promotionCandidates({
      userId: req.user.sub,
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
    })
    return { code: 0, message: 'ok', data }
  }

  /**
   * M6b：反哺抑制标记入口（spec §2.2）——M6a 剔除机制缺的「谁来标记」在这里闭环。
   *
   * 链路：归属校验 → Nest 侧进程内表（注入通道立即生效）→ fail-soft 转发 pi-runtime
   * （recall_memory 通道）。幂等；memoryId 必须存在且属于当前账号（否则 404）。
   */
  @Post('memory/suppressions')
  @UseGuards(AuthGuard)
  async suppressMemory(
    @Req() req: Request & { user: { sub: string } },
    @Body() dto: MemorySuppressDto,
  ) {
    const data = await this.memory.suppressMemory({
      userId: req.user.sub,
      memoryId: dto.memoryId,
      reason: dto.reason ?? '',
    })
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

  /** 前端「停止」：中断 pi-runtime 当前 run（会话保留）。详见 CancelRunDto。 */
  @Post('runs/cancel')
  @UseGuards(AuthGuard)
  async cancelRun(
    @Body() dto: CancelRunDto,
    @Req() req: Request & { user: { sub: string } },
  ) {
    // 与 clear-propose 一致：先校验会话归属，避免越权中断他人的 run
    await this.sessionsService.findOne(dto.sessionId, req.user.sub)
    // P0-①：中断目标是对话键（threadId）；只传 sessionId 会 abort 不到常驻会话
    const data = await this.agentService.cancelRun({
      sessionId: dto.sessionId,
      threadId: dto.threadId,
    })
    return { code: 0, message: 'ok', data }
  }

  /**
   * 用户插话（steering 队列）：上一轮还在跑时的发言走这里（2026-10-02）。
   *
   * 刻意做成「轻量 JSON 端点」而非新的 SSE 流：插话要并入**当前这一轮**，开新流反而会
   * 抢跑 / 撞 409。消息由 pi-runtime 落进 vendor 队列，当前 run 的下一个 turn 边界接住。
   *
   * 与 `runs/followup` 是同一份消息的两种「送达时机」，互斥二选一（见 `followUpPiRun` 注释
   * 里 `boundary.ts:106` 的那条跳过规则），不是两条可叠加的通道。
   */
  @Post('runs/steer')
  @UseGuards(AuthGuard)
  async steerRun(
    @Body() dto: { sessionId: string; threadId?: string; text: string },
    @Req() req: Request & { user: { sub: string } },
  ) {
    if (!dto?.text?.trim()) {
      return { code: 400, message: 'text is required', data: null }
    }
    // 与 runs/cancel 一致：先校验会话归属，避免往他人的会话队列里塞消息
    await this.sessionsService.findOne(dto.sessionId, req.user.sub)
    const data = await this.agentService.steerPiRun({
      sessionId: dto.sessionId,
      threadId: dto.threadId,
      text: dto.text,
    })
    return { code: 0, message: 'ok', data }
  }

  /**
   * 尾随指令（followUp 队列）：用户不想打断当前轮，要等它跑完再接住（2026-10-02）。
   *
   * 场景是「人走开」——入队即返回，不开流、不等 run 结束。接住发生在当前 run 的收尾边界，
   * 之后由 pi-runtime 的 `drainAfterRun` 兜底派生排空（`vendor` 没有 terminal drain）。
   */
  @Post('runs/followup')
  @UseGuards(AuthGuard)
  async followUpRun(
    @Body() dto: { sessionId: string; threadId?: string; text: string },
    @Req() req: Request & { user: { sub: string } },
  ) {
    if (!dto?.text?.trim()) {
      return { code: 400, message: 'text is required', data: null }
    }
    await this.sessionsService.findOne(dto.sessionId, req.user.sub)
    const data = await this.agentService.followUpPiRun({
      sessionId: dto.sessionId,
      threadId: dto.threadId,
      text: dto.text,
    })
    return { code: 0, message: 'ok', data }
  }

  /**
   * 旁听众管（纯订阅、不触发 run）：给「点了 followUp 就走开」的人一个切回来还能看见的通道。
   *
   * 主 `chat/conversation` 在 `agent_end` 就收尾了，而 followUp 是在**收尾边界之后**才接住、
   * 由 pi-runtime `drainAfterRun` 派生出的新一代 —— 那一段不在主流里。本端点只旁听、不驱动，
   * 且**收到 `agent_end` 不自动收尾**（否则恰好把续跑那一代切掉）。
   *
   * ⚠️ SSE 在本链路永不 EOF（pi-runtime 靠 idle 判定存活），所以必须有空闲闸门：
   * 30s 无任何事件就主动 end，避免每个静默会话都白占一条长连接。
   */
  @Get('runs/events')
  @UseGuards(AuthGuard)
  async runEvents(
    @Query('sessionId') sessionId: string,
    @Query('threadId') threadId: string | undefined,
    @Req() req: Request & { user: { sub: string } },
    @Res() res: Response,
  ) {
    await this.sessionsService.findOne(sessionId, req.user.sub)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')

    const idleTimer = setTimeout(() => {
      res.end()
    }, 30_000)
    try {
      for await (const event of this.agentService.runEventStream(threadId?.trim() || sessionId)) {
        res.write(`data: ${JSON.stringify(event)}\n\n`)
        idleTimer.refresh()
      }
    } catch (err) {
      // 旁听流断开是常态（30s idle / 前端卸载），但也可能是 runtime 不可达——
      // 只吞不算故障，靠 metrics 与下一轮主流自愈，不刷 debug 以下的噪音。
      this.logger.warn(
        `run events stream failed (session=${sessionId}): ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      clearTimeout(idleTimer)
      res.end()
    }
  }

  /** B-2：向阻塞中的 ask_user/propose_generation 提交回答（透传 pi-runtime /answers，幂等）。 */
  @Post('sessions/:sessionId/answers')
  @UseGuards(AuthGuard)
  async answerPending(
    @Param('sessionId') sessionId: string,
    @Body() dto: AnswerPendingDto,
    @Req() req: Request & { user: { sub: string } },
  ) {
    // 与 runs/cancel 一致：先校验会话归属，避免越权回答他人的 pending
    await this.sessionsService.findOne(sessionId, req.user.sub)
    const data = await this.agentService.answerPiPending({
      sessionId,
      threadId: dto.threadId,
      callId: dto.callId,
      answers: dto.answers,
      decision: dto.decision,
    })
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

    // SSE 保活（item 4）：pi 的 `: heartbeat` 注释帧被 Nest 客户端丢弃，且长任务（run_* 出图 ~3min /
    // 视频 ~11min）两轮业务事件间可能 >30s 无 data 帧 → 浏览器误判「生成服务暂时不可达」并自断。
    // 控制器每 15s 下发一个 data 帧，浏览器逐帧 touch() 重置 stale 计时（< STREAM_STALE_MS=30s）。
    const heartbeatTimer = setInterval(() => {
      try {
        res.write('data: {"type":"heartbeat"}\n\n')
      } catch {
        // 客户端已断开，循环/关闭会清理
      }
    }, 15_000)

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
        dto.branchFromEntryId,
        // SEL-REF：指代信号。追加在参数表**末尾**——中间插入会移位，
        // 而 `refOrder` / `mentionedKeys` 同为 string[] ⇒ 错位是静默的。
        dto.selectedNodeIds,
      )) {
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      res.write('data: [DONE]\n\n')
    } catch (err) {
      res.write(`data: ${JSON.stringify({ type: 'error', data: { message: String(err) } })}\n\n`)
    } finally {
      clearInterval(heartbeatTimer)
    }

    res.end()
  }
}
