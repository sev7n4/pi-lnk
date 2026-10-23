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
import { recordSessionSeen } from './generation-recovery/presence'
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
    @Body()
    dto: {
      sessionId: string
      threadId?: string
      text: string
      /** 参考素材（2026-10-20 P1-1）：插话也要带得动图与指代芯片 */
      attachments?: SidebarAttachmentDto[]
      refOrder?: string[]
      mentionedKeys?: string[]
      /** 画布选中态（SEL-REF 指代信号） */
      selectedNodeIds?: string[]
      /** P1-2：vision 门控用（composer 当前模型，与正常发送 dto.model 同源） */
      model?: string
    },
    @Req() req: Request & { user: { sub: string } },
  ) {
    if (!dto?.text?.trim()) {
      return { code: 400, message: 'text is required', data: null }
    }
    // 与 runs/cancel 一致：先校验会话归属，避免往他人的会话队列里塞消息
    await this.sessionsService.findOne(dto.sessionId, req.user.sub)
    // 可选字段只在有值时下发：JSON 序列化本就会丢 undefined，显式条件展开是为了让
    // 「本次请求到底带了什么」在 payload 上直接可见（也避免下游拿到空数组要再判一次）。
    const data = await this.agentService.steerPiRun({
      sessionId: dto.sessionId,
      threadId: dto.threadId,
      text: dto.text,
      userId: req.user.sub,
      ...(dto.attachments?.length ? { attachments: dto.attachments } : {}),
      ...(dto.refOrder?.length ? { refOrder: dto.refOrder } : {}),
      ...(dto.mentionedKeys?.length ? { mentionedKeys: dto.mentionedKeys } : {}),
      ...(dto.selectedNodeIds?.length ? { selectedNodeIds: dto.selectedNodeIds } : {}),
      ...(dto.model ? { model: dto.model } : {}),
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
    @Body()
    dto: {
      sessionId: string
      threadId?: string
      text: string
      /** 参考素材（2026-10-20 P1-1）：与 steer 同口径 */
      attachments?: SidebarAttachmentDto[]
      refOrder?: string[]
      mentionedKeys?: string[]
      selectedNodeIds?: string[]
      /** P1-2：同 steer。 */
      model?: string
    },
    @Req() req: Request & { user: { sub: string } },
  ) {
    if (!dto?.text?.trim()) {
      return { code: 400, message: 'text is required', data: null }
    }
    await this.sessionsService.findOne(dto.sessionId, req.user.sub)
    // 同 steerRun：可选字段只在有值时下发。
    const data = await this.agentService.followUpPiRun({
      sessionId: dto.sessionId,
      threadId: dto.threadId,
      text: dto.text,
      userId: req.user.sub,
      ...(dto.attachments?.length ? { attachments: dto.attachments } : {}),
      ...(dto.refOrder?.length ? { refOrder: dto.refOrder } : {}),
      ...(dto.mentionedKeys?.length ? { mentionedKeys: dto.mentionedKeys } : {}),
      ...(dto.selectedNodeIds?.length ? { selectedNodeIds: dto.selectedNodeIds } : {}),
      ...(dto.model ? { model: dto.model } : {}),
    })
    return { code: 0, message: 'ok', data }
  }

  /**
   * 回填 user 消息的 pi `entryId`（2026-10-21，统一 user 消息身份）。
   *
   * ## 为什么需要它
   * `streamConversation` 在调 pi **之前**就落了 user 行，而 `pi.prompt()` 只返回
   * `{ accepted }`（`pi-runtime/src/session-manager.ts:2370`）⇒ 正常发送的 entryId
   * 只能从 `pi_message_end` 事件拿。不回填 ⇒ 刷新后的历史消息没有 fork 切点，
   * 「③ 重跑」只能降级兜底。
   *
   * ## 为什么插话不走这里
   * 插话入队即回传 entryId，服务端在落库那一刻就写好了（见 `persistQueuedUserMessage`）。
   *
   * ## 幂等
   * 客户端可能在**多个页签**同时收到同一个 `pi_message_end` ⇒ 重复调用是常态。
   * `entryId` 上有唯一索引，命中已有行即 no-op（见 service 的 `attachUserMessageEntryId`）。
   */
  @Post('chat/user/entry-id')
  @UseGuards(AuthGuard)
  async attachUserEntryId(
    @Body() dto: { sessionId: string; threadId: string; entryId: string },
    @Req() req: Request & { user: { sub: string } },
  ) {
    if (!dto?.entryId?.trim() || !dto?.threadId?.trim()) {
      return { code: 400, message: 'threadId and entryId are required', data: null }
    }
    await this.sessionsService.findOne(dto.sessionId, req.user.sub)
    const data = await this.agentService.attachUserMessageEntryId({
      sessionId: dto.sessionId,
      threadId: dto.threadId,
      entryId: dto.entryId,
    })
    return { code: 0, message: 'ok', data }
  }

  /**
   * 撤回单条已入队的插话（2026-10-20，对齐 vendor `AgentLane.cancelQueued`）。
   *
   * 存在理由：气泡上的「🗑 放弃」「✎ 取回内容」此前只清前端槽位，服务端那条仍在 vendor
   * inbox 里照常被消费 —— 用户以为撤回了，实际它还会插进 agent 上下文。
   *
   * ⚠️ `outcome` 必须**原样透传**，不能折成布尔：`already_consumed` 表示那条已经进了对话历史
   * （撤回晚了），前端要据此收起撤回按钮并如实告知，而不是假装撤回成功。
   */
  @Post('runs/queue/cancel')
  @UseGuards(AuthGuard)
  async cancelQueuedRun(
    @Body() dto: { sessionId: string; threadId?: string; entryId: string },
    @Req() req: Request & { user: { sub: string } },
  ) {
    if (!dto?.entryId?.trim()) {
      return { code: 400, message: 'entryId is required', data: null }
    }
    // 与 steer/followup 一致：先校验会话归属，避免撤他人的会话
    await this.sessionsService.findOne(dto.sessionId, req.user.sub)
    const data = await this.agentService.cancelQueuedPiRun({
      sessionId: dto.sessionId,
      threadId: dto.threadId,
      entryId: dto.entryId,
    })
    return { code: 0, message: 'ok', data }
  }

  /**
   * 会话级事件订阅（纯订阅、不触发 run）——多端同会话一致性的**传输主干**。
   *
   * 两个消费场景，同一条流：
   *  ① **本端**：`chat/conversation` 在 `agent_end` 就收尾了，而 followUp 是在**收尾边界之后**
   *     才接住、由 pi-runtime `drainAfterRun` 派生出的新一代 —— 那一段不在主流里；
   *  ② **旁观端**（2026-10-24 补）：另一端正在跑的那轮，本端若不订阅就只有刷新才看得见。
   *     ⇒ 本端点必须**常驻可订阅**，与「谁发起的」无关。
   *
   * ⚠️ SSE 在本链路永不 EOF（pi-runtime 靠 idle 判定存活），所以必须有空闲闸门：
   * 30s 无任何帧就主动 end，避免订阅没起来时白占一条长连接。**心跳也算帧**（见下），
   * 因此健康连接不会被闸门误杀。
   */
  @Get('runs/events')
  @UseGuards(AuthGuard)
  async runEvents(
    @Query('sessionId') sessionId: string,
    @Query('threadId') threadId: string | undefined,
    // multi-device Task 4：浏览器 EventSource 断线重连时自动带上的 Last-Event-ID
    // （以 ?lastEventId= 形态由前端显式拼入）。只放行非负整数字符串——空串/畸形值
    // 会被 pi-runtime 解析进 `afterSeq=-1` 全量重放分支（plan 已知坑：重放风暴）。
    @Query('lastEventId') lastEventId: string | undefined,
    @Req() req: Request & { user: { sub: string } },
    @Res() res: Response,
  ) {
    await this.sessionsService.findOne(sessionId, req.user.sub)
    // 生成失败回注的在线态代理（spec §6.0-1）：双键记录（sessionId + threadId）。
    // 发射点只知道 canvas sessionId，而前端旁听流通常带 threadId 订阅 —— 单键会导致
    // 在线判定恒 false、回注全部 skip（presence.ts 顶部注释有完整说明）。
    recordSessionSeen(sessionId)
    const presenceThreadId = threadId?.trim()
    if (presenceThreadId && presenceThreadId !== sessionId) {
      recordSessionSeen(presenceThreadId)
    }
    const cursor = /^\d+$/.test(lastEventId?.trim() ?? '') ? lastEventId!.trim() : undefined
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    // ⚠️ 关于 `X-Accel-Buffering: no`（2026-10-24 复核后保留，但**不是**生产问题的成因）：
    // 生产 CVM 的 `/etc/nginx/conf.d/lnkpi.conf` 里 `location /api/` **已经**设了
    // `proxy_buffering off` ⇒ 旁听流**不受** nginx 缓冲。
    // 保留这个头的理由是**防御性**：反代配置会变（新增 location / 换 CDN / 换机器），
    // 而 SSE 一旦被缓冲就会重演「连接建立但收不到任何字节」的静默故障，且排查成本极高
    // （nginx access log 里只看到 200 + 0 字节，看不出是缓冲）。
    // ⇒ 逐响应声明「本响应不缓冲」，不依赖任何外层配置。
    res.setHeader('X-Accel-Buffering', 'no')

    // idle 闸门收窄（multi-device Task 4，plan 已知坑「旁听流 30s idle ⇒ 重连风暴」）：
    // 30s 只用于**首帧前**（等不到首帧 = 订阅没起来，断开让前端退避重试）；
    // 首帧之后连接转常驻，靠 15s 心跳帧保活（与主链路 chat/conversation 同款，
    // 防 nginx/浏览器把静默长连接当死连接掐掉）。
    let firstFrameSeen = false
    // ⭐⭐ 订阅建立**立刻**写一帧（SSE 注释，不进 data 通道）：浏览器要等响应头才算
    // 「连上了」，而本链路首个业务事件可能几十秒后才到。没有这一帧，前端在整段静默期里
    // 都处于「未连接」状态（用户切走 / 组件卸载 ⇒ 直接 abort，永远收不到后续事件）。
    // ⚠️ 用 `:` 注释行而非 `data:`：注释帧不触发前端的 firstFrameSeen，也不该被当成业务事件。
    //
    // 生产实证（2026-10-24）：改前 25 次订阅在 nginx access log 里全是「200 + 0 字节」。
    // 归因**不是** nginx 缓冲（该机 `/api/` 已 `proxy_buffering off`），而是：改前首帧前
    // 不写任何字节 ⇒ 客户端始终拿不到响应头 ⇒ 处于「未建立」状态；此时任何一次掐断
    // （重挂 / 切走 / 重连）都只留下「200 + 0 字节」——看不出原因的静默故障记录。
    res.write(': observer-ready\n\n')
    const idleTimer = setTimeout(() => {
      res.end()
    }, 30_000)
    const heartbeatTimer = setInterval(() => {
      try {
        res.write('data: {"type":"heartbeat"}\n\n')
        // 心跳也是「连接活着」的证据：收到心跳即解除首帧闸门。
        // 否则静默会话的常驻连接会在第 30s 被闸门 end（只来得及发 1 个心跳）
        // ⇒ 前端每 30s 全量重连，常驻订阅名存实亡。
        firstFrameSeen = true
        clearTimeout(idleTimer)
      } catch {
        // 客户端已断开，循环/关闭会清理
      }
    }, 15_000)
    // ⭐⭐ 2026-10-24：客户端断开必须**终止**旁听订阅。
    //
    // 背景：service 侧 `retryOnMissing` 让 404 走「无限期等 lane 出现」⇒ pi-runtime
    // 客户端永不回调 onError ⇒ 生成器永不结束 ⇒ 浏览器一断开，Nest 侧就会**永久留下**
    // 一条每 ≤5s 轮询 pi-runtime 的订阅（每个 observer 一条）⇒ 资源泄漏 + 无谓上游压力。
    //
    // ⇒ 把「客户端断开」映射成 `abort.abort()`，service 收到后立即退订并结束生成器。
    //
    // ⚠️⚠️ 判据用 **`res.on('close')` + `!res.writableFinished`**，**不用** `req.on('close')`。
    // 实测（2026-10-24，本机 Node 24 + Express 4 + express.raw）：
    //   - `req.on('close')` 在**请求体被读完**时就会触发（58ms），而响应还在持续推送
    //     ⇒ 一旦有人给本端点加 body / 换 raw parser，订阅会被**瞬间 abort**
    //     ⇒ 退化成「连上即断」的老故障（Node 16+ 改过 `req.close` 语义）。
    //     本端点当前是 GET（无 body）才侥幸没踩到——那是隐含前提，不是保证。
    //   - `res.on('close')` 只在**响应真正结束**时触发：
    //     客户端掐断 ⇒ close 且 `writableFinished=false`（提前结束）；
    //     服务端自己 `res.end()` ⇒ close 且 `writableFinished=true`（正常收尾）。
    //     ⇒ 用 `!writableFinished` 区分「客户端断连」与「正常收尾」，两种都幂等无副作用。
    const abort = new AbortController()
    const onClientGone = () => {
      if (!res.writableFinished) abort.abort()
    }
    res.on('close', onClientGone)
    try {
      for await (const event of this.agentService.runEventStream(threadId?.trim() || sessionId, {
        lastEventId: cursor,
        signal: abort.signal,
      })) {
        if (!firstFrameSeen) {
          firstFrameSeen = true
          clearTimeout(idleTimer)
        }
        // multi-device Task 4：透传 pi-runtime 的单调 seq 为 SSE id 行——
        // 浏览器据此维护 Last-Event-ID，断线重连自动带回，实现断点续传（D1）。
        // ⚠️ 无 seq 的合成事件不写 id 行：写了会让 Last-Event-ID 指向不存在的
        // seq ⇒ 重连从错误的游标续传（错位丢帧比丢整帧更难查）。
        const seq = (event as { seq?: number }).seq
        const idLine = seq === undefined ? '' : `id: ${seq}\n`
        res.write(`${idLine}data: ${JSON.stringify(event)}\n\n`)
      }
    } catch (err) {
      // 旁听流断开是常态（30s idle / 前端卸载），但也可能是 runtime 不可达——
      // 只吞不算故障，靠 metrics 与下一轮主流自愈，不刷 debug 以下的噪音。
      this.logger.warn(
        `run events stream failed (session=${sessionId}): ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      clearTimeout(idleTimer)
      clearInterval(heartbeatTimer)
      // 解绑断连监听：避免长连接在 res 上留悬挂监听器（每个 res 一个实例，
      // 但同一 res 上 close 只触发一次 ⇒ 摘掉更干净，也防 future 复用 res 时误触发）。
      res.off('close', onClientGone)
      try {
        res.end()
      } catch {
        // 客户端已断开：res.end() 可能抛（ERR_STREAM_WRITE_AFTER_END 等）⇒ 忽略。
      }
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
