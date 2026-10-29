---
name: html-craft
version: "0.1.0"
description: >-
  生成高质量 HTML 产物的强制规范。当用户要求做网页、页面、原型、落地页、
  H5、可交互演示，或要把画布数据做成总览卡片/流程图/时间线卡片时，写 html 格式文本节点
  前必须先加载本 skill。纯文案、markdown 内容、媒体节点不适用。
---

# HTML 产物生成规范（html-craft）

## 何时使用（出口选择，先读这段再动手）

1. 画布结构化数据可视化（总览图/流程图/时间线卡片）→ HTML 卡片 + mermaid / echarts
   （CDN 白名单内）。读数据前先 tool_search 搜「画布」加载读类工具：布局工具仅含
   id/type/title/position；要节点正文用节点详情读取工具显式读取；
   **取不到的字段一律不写、不编造**。
2. 纯文案 / 说明 → markdown 文本节点，不出 html。
3. 自由布局 / 交互原型 / 表单 / 带脚本的演示页 → format:'html' 自由生成（本规范全文管这个口）。

## 环境硬约束（违反即产物残废，写码前逐条自检）

- 单文件自包含：CSS/JS 全部内联；外部脚本仅允许 cdnjs.cloudflare.com / cdn.jsdelivr.net /
  unpkg.com，**锁精确版本、用 UMD 构建**（UMD 在全局定义变量，放在使用它的内联脚本之前）。
- 图片一律 data URI / 内联 SVG / 纯 CSS 绘制——远程图片必被 CSP 拦截（裂图，非 bug）。
- 无 alert / confirm / prompt（沙箱内静默失效）——交互提示用行内元素。
- 无 localStorage / cookie（沙箱 opaque origin）——状态放内存变量。
- 无 fetch / XHR / WebSocket（connect-src 'none'）——数据内联进页面。
- 字体用系统字体栈或 Google Fonts（唯一允许的外部样式域，字体文件来自 fonts.gstatic.com）。

## 设计规范（反 AI slop）

- 字号 ≥11px；字重只用 400/500 两档；正文行高 1.6。
- 禁渐变/投影/发光/霓虹；平面实色。
- 配色 ≤2 个色系 ramp；中性色打底，强调色只做点睛。
- 布局留白充分；圆角统一一档（8–12px）；间距取阶梯值（4/8/12/16/24）。
- 复杂度预算：单屏组块 ≤7 个；图示横排 ≤4 项；标签 ≤5 词；
  盒宽估算 = max(标题字数×7, 副标题字数×6)+24（px，中文按字数）。
- 图表优先 mermaid / echarts（白名单 CDN），不手写数据图形。
- 自带完整配色（不依赖宿主主题）；文字与背景对比度 ≥4.5:1。
- 无障碍：页面首个元素放 visually-hidden 的一句话摘要（class="sr-only"）。

## 编辑纪律

- 每轮增量修改 ≤4 次；超过必须整体 rewrite（整页重写质量高于碎修补）。
- 修改锚点必须唯一精确，禁止模糊替换。

## 交付自检（全部勾完才允许 set_node_text 交付）

□ DOCTYPE + viewport meta；□ CSS/JS 全内联或白名单 CDN；□ 无远程图片；
□ 无弹窗 API；□ 数据全内联；□ 中文文案无乱码；□ 移动端窄屏不破版；□ 标题层级清晰
