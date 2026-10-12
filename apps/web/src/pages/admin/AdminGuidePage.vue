<script setup lang="ts">
// 纯静态指南页：无数据请求。内容与 docs/ops-console-guide.md 同源（精简版）。
</script>

<template>
  <section class="p-2 text-sm leading-6">
    <h1 class="mb-3 text-base font-semibold text-fg">使用说明</h1>

    <div class="space-y-4">
      <div class="rounded border border-line-subtle bg-surface-base p-3">
        <h2 class="mb-1 font-semibold text-fg">登录与 Token</h2>
        <ul class="list-disc pl-5 text-fg-2">
          <li>进入 /admin 输入 <span class="font-mono text-fg">LNKPI_ADMIN_TOKEN</span>，存 sessionStorage，关标签页即失效。</li>
          <li>轮换：改 api 容器 env 后重建容器。</li>
        </ul>
      </div>

      <div class="rounded border border-line-subtle bg-surface-base p-3">
        <h2 class="mb-1 font-semibold text-fg">模型目录</h2>
        <ul class="list-disc pl-5 text-fg-2">
          <li><span class="text-fg">modelKey</span> 创建后不可改；下架是软删（可恢复），同 modelKey 重新新增即恢复上架。</li>
          <li><span class="text-fg">modality</span> = 输出能力（text/image/video/audio，单选）。</li>
          <li><span class="text-fg">providerBinding</span> = 服务端装载适配器白名单（文本模型一律 gateway-openai-compat）。</li>
          <li>
            <span class="text-fg">params (JSON)</span> = 参数处置声明 <span class="font-mono">{"字段名": 处置}</span>，处置四选一：
            <span class="font-mono text-fg">native</span> 原生透传 ·
            <span class="font-mono text-fg">promptPrefix</span> 拼进提示词 ·
            <span class="font-mono text-fg">instruction</span> 作指令注入 ·
            <span class="font-mono text-fg">metadataOnly</span> 只记元数据（默认）。不确定就填 <span class="font-mono">{}</span>。
          </li>
          <li>下架报 409 = 该模型是某模态默认模型，先改默认再下架。</li>
        </ul>
      </div>

      <div class="rounded border border-line-subtle bg-surface-base p-3">
        <h2 class="mb-1 font-semibold text-fg">上游路由</h2>
        <ul class="list-disc pl-5 text-fg-2">
          <li>按 pattern 逐条匹配（优先级数字大者先），禁用一条 = 该 pattern 流量落到下一优先级，最终兜底 default 行。</li>
          <li>启停即时生效（跨实例 5s TTL 兜底）；启停需 X-Confirm 确认头（页面自动携带）。</li>
          <li>路由行由种子播种，页面只启停、不增删。</li>
        </ul>
      </div>

      <div class="rounded border border-line-subtle bg-surface-base p-3">
        <h2 class="mb-1 font-semibold text-fg">健康探活</h2>
        <ul class="list-disc pl-5 text-fg-2">
          <li>上半区 = 全部真实流量统计（含 BYOK 用户渠道，按 模型+渠道 分组）；402 计数 = 上游余额不足。</li>
          <li>下半区 = 定时探活（默认 6h，只读 GET /v1/models，不发生成请求），无手动触发按钮。</li>
          <li>
            <span class="text-warning">ghost N</span> = 上游有、目录没有（候选上架）；
            <span class="text-fg-2">missing N</span> = 目录有、上游没有（候选下架）——展开行看清单。
          </li>
          <li>HTTP/模型数空白 = 该次探活失败（看同行错误列，如超时）。</li>
        </ul>
      </div>

      <div class="rounded border border-line-subtle bg-surface-base p-3">
        <h2 class="mb-1 font-semibold text-fg">渠道定价</h2>
        <ul class="list-disc pl-5 text-fg-2">
          <li>四字段 = <span class="font-mono text-fg">每百万 token 绝对美元单价</span>（input/output/cacheRead/cacheWrite），不支持倍率，留空 = 该维度不计费。</li>
          <li><span class="text-warning">未配定价</span> 徽标成片出现 = pull-models 刚抹过 pricing，需按审计 before 快照补配。</li>
          <li>保存为条目级替换（其他模型/字段不动）；清除后该模型不计费；每次操作均写审计。</li>
          <li>顶部黄条「models JSON 畸形」= 编辑全禁用（拒盲写），先修渠道行。</li>
        </ul>
      </div>

      <div class="rounded border border-line-subtle bg-surface-base p-3">
        <h2 class="mb-1 font-semibold text-fg">审计日志</h2>
        <ul class="list-disc pl-5 text-fg-2">
          <li>action / resource 精确匹配过滤；行首 &gt; 展开 before/after JSON diff。</li>
          <li>常用 action：<span class="font-mono text-fg">platform-channel.pricing.set</span> / <span class="font-mono text-fg">.clear</span>。</li>
        </ul>
      </div>

      <div class="rounded border border-warning-border bg-warning-bg p-3">
        <h2 class="mb-1 font-semibold text-fg">常见 SOP</h2>
        <ul class="list-disc pl-5 text-fg-2">
          <li>上架新模型：目录新增 → 确认路由 → 配定价 → 健康页观察。</li>
          <li>模型批量失败：看 errorCode 分布；402 高 = 充值；上游故障 = 路由页临时关停。</li>
          <li>pull-models 之后：定价页查「未配定价」→ 按审计补价 → 健康页看 ghost/missing 决定上下架。</li>
        </ul>
        <p class="mt-2 text-fg-3">完整版（含字段表与边界说明）：仓库 docs/ops-console-guide.md</p>
      </div>
    </div>
  </section>
</template>
