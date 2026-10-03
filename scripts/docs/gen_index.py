#!/usr/bin/env python3
"""为 docs/superpowers/ 下的文档判定状态并按主题分类，生成索引数据。

判定依据（按优先级）：
1. 文档内已有明确状态字段（已实现/已交付 → frozen；待实现/待评审 → living）
2. 文件名日期 + 主题关键词（迁移期 7-8 月 → frozen）
3. 近期活跃主题（canvas / prompt-registry / memory 等）→ living

用法：python3 gen_index.py > index_data.json
"""
import json
import os
import re
from collections import defaultdict

# 脚本在 scripts/docs/，仓库根需上溯两级
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "../.."))
SP = os.path.join(ROOT, "docs/superpowers")

# 主题分类：关键词 -> 主题名。按出现顺序匹配，先命中先算。
TOPICS = [
    ("prompt-registry", ["prompt-registry", "prompt-engineering", "prompt-lint", "prompts",
                         "rule-16", "agent-gen-params", "sidebar-block"]),
    ("vision", ["vision", "识图", "supports-vision", "direct-image", "compaction-images"]),
    ("memory", ["memory", "记忆", "recall", "scope-isolation", "compaction-summary"]),
    ("context-engineering", ["context-engineering", "compaction-wiring", "dynamic-budget",
                              "token", "compression", "context-window"]),
    ("image-editor", ["cx-image-edit", "image-editor", "refine-", "matting", "outpaint",
                       "image-grid-slice", "turnaround-deai", "workbench-shell",
                       "media-stream-download", "deai"]),
    ("account-auth", ["login-", "captcha", "invite", "points-stats", "account-chrome",
                      "usage-page", "usage-overview", "personal-center", "profile-ia"]),
    ("workflow-exchange", ["workflow-import", "export-pack", "workflow-recipe", "composition-",
                           "planner-confirm", "explore-import", "agent-import-workflow",
                           "import-default", "dock-guide-scene"]),
    ("generation-pipeline", ["image-pipeline", "i2v", "image-to-video", "turnaround-image",
                             "seedream", "seedance", "agnes", "apimart", "media-storage",
                             "media-inspector", "generation", "byok", "provider-channel",
                             "video-adapter", "upstream-capability", "sts-", "upscale",
                             "minimax", "fal-h3", "guide-catalog", "image-prompting-guide",
                             "media-persist", "delivery-program", "abort-cascade"]),
    ("canvas-product", ["atomic-studio", "atomic-intent", "intent-", "neowow", "dock-studio",
                        "product-visual", "ecommerce", "commercial-storyboard", "storyboard",
                        "workflow-design", "model-adapter", "graph-engineering", "two-product-line",
                        "regenerate", "batch-confirm", "arrange-along-edges", "platform-route"]),
    ("ui-interaction", ["ui-p0", "ui-p1", "interactions", "topology-preview", "hitl",
                        "confirm-loop", "consistency-chain", "interrupt", "conversation-isolation",
                        "conversation-ux"]),
    ("agent-ux", ["agent-ux", "progress", "queued", "steering", "followup", "ask-user", "answer",
                  "sidebar", "thinking", "blocking", "wait", "chip", "presentation", "onboarding",
                  "execution-trace", "journey-trace"]),
    ("canvas-tool", ["canvas", "画布", "render-canvas", "arrange-nodes", "propose",
                     "media-delivery", "node"]),
    ("deploy-infra", ["deploy", "helm", "k3s", "ci-", "registry", "docker", "vercel", "domain",
                      "infra", "rollout"]),
    ("tool-runtime", ["tool", "runtime", "queue", "harness", "vendor", "subagent", "loop-engineering"]),
    ("planning", ["plan-", "roadmap", "milestone", "phase", "spec-figure", "execution-plan"]),
]

# 7-8 月 = 迁移期，主题已随代码落地
MIGRATION_MONTHS = ("2026-07", "2026-08")

# 明确已完成的表述
DONE_PAT = re.compile(r"已实现|已交付|已上线|已完成|Implemented|Complete", re.I)
# 明确进行中的表述
ACTIVE_PAT = re.compile(r"待实现|待评审|待开发|待执行|进行中|待确认|待全文确认|已批准|已拍板|已确认|定稿", re.I)
# 被取代
SUPERSEDED_PAT = re.compile(r"superseded|已废弃|已取代|作废", re.I)


def read_head(path, n=40):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return "".join(f.readline() for _ in range(n))
    except OSError:
        return ""


def classify(path):
    name = os.path.basename(path)
    head = read_head(path)
    date_m = re.match(r"(\d{4}-\d{2})", name)
    month = date_m.group(1) if date_m else "unknown"
    is_spec = "/specs/" in path

    # 1. 文档自述状态优先
    status = None
    reason = ""
    if SUPERSEDED_PAT.search(head):
        status, reason = "superseded", "文内标注已废弃/被取代"
    elif DONE_PAT.search(head):
        status, reason = "frozen", "文内标注已实现/已交付"
    elif ACTIVE_PAT.search(head):
        status, reason = "living", "文内标注待实现/待评审/进行中"

    # 2. 次优：主题 + 月份推断
    if status is None:
        low = name.lower()
        hit_topic = next((t for t, kws in TOPICS if any(k in low for k in kws)), None)
        if month in MIGRATION_MONTHS:
            status = "frozen"
            reason = f"{month} 迁移期文档，功能已随代码落地"
        elif hit_topic in ("vision", "prompt-registry", "memory", "context-engineering", "canvas-tool", "agent-ux"):
            status = "living"
            reason = f"{month} 活跃主题（{hit_topic}）"
        else:
            status = "frozen"
            reason = f"{month} 非活跃主题"

    # 3. 主题归类
    low = name.lower()
    topic = next((t for t, kws in TOPICS if any(k in low for k in kws)), "other")

    return {
        "path": os.path.relpath(path, ROOT),
        "name": name,
        "month": month,
        "kind": "spec" if is_spec else "plan",
        "status": status,
        "reason": reason,
        "topic": topic,
    }


def main():
    items = []
    for sub in ("specs", "plans"):
        d = os.path.join(SP, sub)
        if not os.path.isdir(d):
            continue
        for fn in sorted(os.listdir(d)):
            if fn.endswith(".md"):
                items.append(classify(os.path.join(d, fn)))

    by_topic = defaultdict(list)
    for it in items:
        by_topic[it["topic"]].append(it)

    print(json.dumps({
        "total": len(items),
        "by_status": {s: sum(1 for i in items if i["status"] == s)
                      for s in ("living", "frozen", "superseded")},
        "by_topic": {t: len(v) for t, v in sorted(by_topic.items(), key=lambda x: -len(x[1]))},
        "by_month": {m: sum(1 for i in items if i["month"] == m)
                     for m in sorted({i["month"] for i in items})},
        "items": items,
    }, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
