# 实施计划：畸形 toolCall 进 LLM 前清洗（2026-11-28）

## 前置
- 分支 `fix/intent-dedup-failed-turn-retry`（已开，含 5 条建议实现）。
- 规格 `docs/superpowers/specs/2026-11-28-tool-call-sanitizer-design.md`。

## 步骤

### P1 红灯：纯函数测试
- 新建 `services/pi-runtime/src/tool-call-sanitizer.test.ts`（node:test + assert）。
- 覆盖：空 id / 空 name / 全空白 id、空 toolCallId toolResult、被删调用的同 id toolResult、text+坏调用保留 text、零命中 undefined、输入数组与对象不被 mutate。

### P2 绿灯：纯函数实现
- 新建 `services/pi-runtime/src/tool-call-sanitizer.ts`：
  - `sanitizeMalformedToolCalls(messages): { messages, removedCalls, removedResults } | undefined`
  - 形态守卫复用 `readRecord`（或本地等价的 `isNonEmptyString`），不改 `hook-contract.ts` 语义。

### P3 开关与指标
- `runtime-config.ts`：`RuntimeConfig.toolCallSanitization?: boolean`，`loadRuntimeConfig` 加 `PI_RUNTIME_TOOL_CALL_SANITIZATION` 解析（默认 true）。
- `metrics.ts`：新增 `observeToolCallSanitization()` 计数及 `/metrics` 输出；`metrics.test.ts` 加断言。

### P4 接线（注意注册序）
- `index.ts` `onSessionCreated`：在 `if (hookCfg.trustBoundary !== false)` 块**之前**注册 sanitizer listener：
  - `if (hookCfg.toolCallSanitization === false) return undefined` 的语义通过「不注册」实现；
  - try/catch fail-soft（异常原样放行 + warn）；
  - 返回 `{ messages: out }`。
- 加接线测试：静态读取 `index.ts` 断言 listener 注册序与开关名（沿用现有 wiring test 风格）。

### P5 全量验证
- `services/pi-runtime` `npm test`（node24 / 单 worker 不用管，node:test 自身串行文件）。
- `tsc --noEmit`；`git diff --check`。
- 变异自检：把空 id 判定改成放行 → P1 测试必须红。
- commit 到当前分支；不推 PR、不合并、不部署。

## 验收
- 生产事件账本里的畸形消息形态在测试中构造后，输出消息不再含空 `tool_call_id`；
- 纯文本/正常工具调用会话逐字节不变（零命中返回 undefined）。
