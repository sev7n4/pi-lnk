#!/usr/bin/env python3
"""从 index_data.json 生成 docs/superpowers/INDEX.md（按主题分组 + 状态标记）。"""
import json
import os
from collections import defaultdict

# 脚本在 scripts/docs/，仓库根需上溯两级
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "../.."))
DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "index_data.json")
OUT = os.path.join(ROOT, "docs/superpowers/INDEX.md")

TOPIC_LABEL = {
    "canvas-tool": "画布工具与交互",
    "generation-pipeline": "生成管线（图像/视频/3D）",
    "canvas-product": "画布产品能力（原子/意图/neowow）",
    "image-editor": "图片编辑器与精修台",
    "agent-ux": "Agent 交互与可见性",
    "tool-runtime": "工具与运行时内核",
    "account-auth": "账号/登录/会员",
    "workflow-exchange": "工作流导入导出",
    "planning": "规划与执行计划",
    "ui-interaction": "UI 交互细节",
    "vision": "视觉输入（识图）",
    "deploy-infra": "部署与基础设施",
    "memory": "长期记忆",
    "context-engineering": "上下文工程",
    "prompt-registry": "提示词注册表",
    "other": "其他",
}

STATUS_LABEL = {
    "living": "🟢 living —— 仍在演进，改动前先看这份",
    "frozen": "🔒 frozen —— 内容已定稿或功能已落地，作为历史依据",
    "superseded": "⛔ superseded —— 已被后续决策取代，勿再参考",
}

STATUS_ORDER = ["living", "frozen", "superseded"]


def main():
    if not os.path.exists(DATA):
        raise SystemExit(
            f"未找到 {DATA}\n请先运行： python3 scripts/docs/gen_index.py > scripts/docs/index_data.json")
    d = json.load(open(DATA, encoding="utf-8"))
    items = d["items"]

    by_topic = defaultdict(list)
    for it in items:
        by_topic[it["topic"]].append(it)

    total = d["total"]
    by_status = d["by_status"]

    lines = [
        "# superpowers 文档索引",
        "",
        f"> 全部 **{total} 份** spec/plan 的索引。生成于 2026-10-03，判定依据见文末「状态判定规则」。",
        "> **文档正文未改动** —— 本索引只做导航与状态标注。",
        "",
        "## 怎么用这份索引",
        "",
        "1. **改代码前**，在下面 `🟢 living` 里找相关主题，确认设计意图与当前实现是否一致。",
        "2. **遇到历史包袱**，`🔒 frozen` 记录了「当初为什么这么定」，改设计前值得先读。",
        "3. **`⛔ superseded` 一律不要参考** —— 已被取代，看它旁边的文档。",
        "",
        "## 状态总览",
        "",
        "| 状态 | 份数 | 含义 |",
        "|---|---|---|",
    ]
    for s in STATUS_ORDER:
        lines.append(f"| {STATUS_LABEL[s].split('——')[0].strip()} | {by_status.get(s, 0)} | "
                     f"{STATUS_LABEL[s].split('——')[1].strip()} |")

    lines += [
        "",
        "## 主题分布",
        "",
        "| 主题 | 份数 | 其中 living |",
        "|---|---|---|",
    ]
    for t, arr in sorted(by_topic.items(), key=lambda x: -len(x[1])):
        live = sum(1 for i in arr if i["status"] == "living")
        lines.append(f"| {TOPIC_LABEL.get(t, t)} | {len(arr)} | {live} |")

    lines += ["", "---", "", "## 按主题浏览", ""]

    for t, arr in sorted(by_topic.items(), key=lambda x: -len(x[1])):
        lines.append(f"### {TOPIC_LABEL.get(t, t)}（{len(arr)} 份）")
        lines.append("")
        for s in STATUS_ORDER:
            group = [i for i in arr if i["status"] == s]
            if not group:
                continue
            mark = {"living": "🟢", "frozen": "🔒", "superseded": "⛔"}[s]
            group.sort(key=lambda x: x["name"], reverse=True)
            lines.append(f"<details><summary>{mark} {s} · {len(group)} 份</summary>")
            lines.append("")
            for i in group:
                star = " ★design" if i["kind"] == "spec" else ""
                lines.append(f"- `{i['path']}`{star}")
            lines.append("")
            lines.append("</details>")
            lines.append("")

    lines += [
        "---",
        "",
        "## 状态判定规则",
        "",
        "状态由 `gen_index.py` 按优先级判定：",
        "",
        "1. **文内自述状态优先** —— 文档开头有 `状态：` / `Status:` 字段的，直接采信：",
        "   - `已实现/ 已交付 / 已上线 / Implemented` → **frozen**",
        "   - `待实现 / 待评审 / 进行中 / 已批准 / 已拍板` → **living**",
        "   - `superseded / 已废弃 / 已取代` → **superseded**",
        "2. **月份 + 主题兜底** —— 7-8 月为迁移期，功能已随代码落地 → **frozen**；",
        "   9-10 月的活跃主题（画布工具 / 提示词 / 记忆 / 上下文 / 视觉 / Agent 交互）→ **living**；",
        "   其余 → **frozen**。",
        "",
        "## 重新生成",
        "",
        "```bash",
        "python3 gen_index.py > index_data.json   # 重新判定",
        "python3 gen_index_md.py                  # 重新生成本文件",
        "```",
        "",
        "新增文档后需重跑，并把新文档登记到 `docs/README.md`。",
        "",
        "## 维护约定",
        "",
        "- 本索引**不改正文**，只做导航 —— 避免 283 份文件大改导致 diff 失控。",
        "- 文档自身的状态写在**开头**（推荐 `**状态：** 已实现（YYYY-MM-DD）`），下次重跑即可被自动识别。",
        "- 发现某份文档的状态判断错了，直接改它的开头状态字段，然后重跑生成脚本。",
    ]

    with open(OUT, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"已生成 {OUT}（{total} 份，{len(lines)} 行）")


if __name__ == "__main__":
    main()
