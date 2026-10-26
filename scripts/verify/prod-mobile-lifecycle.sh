#!/bin/bash
# 生产上线复测验证（PR #600 移动端节点生命周期）
#
# 依据 AGENTS.md / MEMORY 的「上线取证四层」判据：
#   ① 入口 chunk 变（最弱）② 目标 Page 分包 grep 字面量
#   ③ CSS 分包 grep 令牌类名 ④ 无头注入生产 CSS 实测
# ⚠️ 入口 0 命中 ≠ 没上线（路由懒加载）；必须正+否两轮
# ⚠️ CSS 内容 hash 跨构建确定、JS hash 不确定 ⇒ 判上线看 CSS/字面量
#
# 用法: bash scripts/verify/prod-mobile-lifecycle.sh [WEB_PORT] [API_PORT]

set -uo pipefail
WEB_PORT="${1:-8888}"
API_PORT="${2:-5100}"
HOST="119.29.173.89"
BASE="http://${HOST}:${WEB_PORT}"
TMP="/tmp/prod-verify-$$"
mkdir -p "$TMP"

PASS=0; FAIL=0
ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
info() { echo "  · $1"; }

echo "═══════════════════════════════════════════════"
echo " 生产上线复测验证 — PR #600 移动端节点生命周期"
echo " 目标: ${BASE}   API: http://${HOST}:${API_PORT}"
echo " 时间: $(date '+%F %T %Z')"
echo "═══════════════════════════════════════════════"

# ── 0. 健康检查（部署没成功时这里就该挂）────────────────────────
echo ""
echo "【0】API 健康检查"
HEALTH=$(curl -fsS --connect-timeout 5 --max-time 15 "http://${HOST}:${API_PORT}/api/health" 2>&1) \
  && ok "API 健康: ${HEALTH:0:120}" || bad "API 健康检查失败: ${HEALTH:0:200}"

WEB=$(curl -fsS --connect-timeout 5 --max-time 15 "${BASE}/" 2>&1) \
  && ok "Web 首页可访问（${#WEB} 字节）" || bad "Web 首页不可访问"

# ── 1. 入口 chunk ───────────────────────────────────────────────
echo ""
echo "【1】入口 chunk（最弱证据）"
ENTRY=$(echo "$WEB" | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1)
if [[ -n "$ENTRY" ]]; then
  ok "入口 chunk: ${ENTRY}"
  echo "${ENTRY}" > "$TMP/entry.txt"
  curl -fsS --connect-timeout 5 --max-time 20 "${BASE}${ENTRY}" -o "$TMP/entry.js" 2>/dev/null \
    && ok "入口 chunk 已下载（$(wc -c < "$TMP/entry.js") 字节）" || bad "入口 chunk 下载失败"
else
  bad "未找到入口 chunk"
fi

# ── 1.5 下载全部生产资源（分包在 lazy chunk 里）──────────────────
echo ""
echo "【1.5】下载生产资源（js + css 分包）"
mkdir -p "$TMP/assets_js" "$TMP/assets_css"
# 从入口 chunk 的 import 关系里找分包文件名（vite 的 mapDeps）
grep -oE '"[^"]*assets/[A-Za-z0-9_-]+\.(js|css)"' "$TMP/entry.js" 2>/dev/null \
  | tr -d '"' | sort -u | head -200 > "$TMP/asset_list.txt"
# 也从 HTML 里抓 preload 链接
grep -oE '/assets/[A-Za-z0-9_-]+\.(js|css)' "$WEB" | sort -u >> "$TMP/asset_list.txt"
sort -u "$TMP/asset_list.txt" -o "$TMP/asset_list.txt"
CNT=0
while read -r a; do
  [[ -z "$a" ]] && continue
  base=$(basename "$a")
  case "$base" in
    *.css) curl -fsS --connect-timeout 5 --max-time 20 "${BASE}${a}" -o "$TMP/assets_css/$base" 2>/dev/null ;;
    *.js)  curl -fsS --connect-timeout 5 --max-time 20 "${BASE}${a}" -o "$TMP/assets_js/$base"  2>/dev/null ;;
  esac
  CNT=$((CNT+1))
done < "$TMP/asset_list.txt"
JS_N=$(ls "$TMP/assets_js" 2>/dev/null | wc -l | tr -d ' ')
CSS_N=$(ls "$TMP/assets_css" 2>/dev/null | wc -l | tr -d ' ')
ok "已下载 ${JS_N} 个 js 分包 / ${CSS_N} 个 css 分包（尝试 ${CNT} 个 URL）"

# ── 2. 目标 Page 分包 grep 字面量 ───────────────────────────────
echo ""
echo "【2】目标 Page 分包字面量（我的功能标识）"
# 本次上线的关键行为标识（来自 9 个 task 的实现）
LITERALS=(
  "mobile-node-select-indicator"   # Task 5 多选选择模式
  "mobile-viewer-close"            # Task 2 查看器右上 X
  "mobile-viewer-annotate"         # Task 7 标注入口
  "mobile-undo-toast"              # Task 3 删除撤销提示
  "mobile-node-hint"               # Task 1 空节点轻提示
  "mobile-viewer-bottom-edit"      # Task 9 底部主栏「改词」
)
FOUND_LIT=0
for lit in "${LITERALS[@]}"; do
  # 遍历所有 assets 下的 js（分包里才有）
  HIT=$(grep -rl -- "$lit" "$TMP"/assets_js 2>/dev/null | head -1)
  if [[ -n "$HIT" ]]; then
    ok "字面量命中: ${lit}  →  $(basename "$HIT")"
    FOUND_LIT=$((FOUND_LIT+1))
  else
    info "字面量未命中: ${lit}"
  fi
done
[[ $FOUND_LIT -gt 0 ]] && ok "已确认 ${FOUND_LIT}/${#LITERALS[@]} 个功能字面量在生产包里" \
                       || bad "所有功能字面量都未命中 ⇒ 疑似未上线"

# ── 3. CSS 分包 grep 令牌类名 ───────────────────────────────────
echo ""
echo "【3】CSS 分包令牌类名（跨构建确定 ⇒ 判上线看它）"
CSS_LITERALS=(
  "mobile-node-select-indicator"   # Task 5 指示器样式
  "viewer-ink"                     # Task 7 画笔覆盖层
  "mobile-undo-toast"              # Task 3 撤销提示
  "m-sheet-actions"                # Task 7/9 底部主栏 slot
)
CSS_FOUND=0
for lit in "${CSS_LITERALS[@]}"; do
  HIT=$(grep -rl -- "$lit" "$TMP"/assets_css 2>/dev/null | head -1)
  if [[ -n "$HIT" ]]; then
    ok "CSS 命中: ${lit} → $(basename "$HIT")"
    CSS_FOUND=$((CSS_FOUND+1))
  else
    info "CSS 未命中: ${lit}"
  fi
done
[[ $CSS_FOUND -gt 0 ]] && ok "已确认 ${CSS_FOUND}/${#CSS_LITERALS[@]} 个 CSS 标识在生产包里" \
                       || bad "CSS 标识都未命中 ⇒ 疑似未上线"

# ── 4. 负向对照（必须真的没有 → 证明检索方法有效）──────────────
echo ""
echo "【4】负向对照（证明检索方法有效，不是恒命中）"
for lit in "__lnk_definitely_not_exists_9f3a__" "zzz_never_deployed_marker_7c2e"; do
  HIT=$(grep -rl -- "$lit" "$TMP"/assets_js "$TMP"/assets_css 2>/dev/null | head -1)
  [[ -z "$HIT" ]] && ok "负向对照正确未命中: ${lit}" || bad "负向对照竟然命中 ⇒ 检索方法有误"
done

# ── 5. 回归探测（部署没打破既有能力）────────────────────────────
echo ""
echo "【5】回归探测"
PR=$(curl -fsS --connect-timeout 5 --max-time 15 "http://${HOST}:${API_PORT}/api/agent/prompt-registry" 2>&1)
if echo "$PR" | grep -q "rules\|registry\|ok"; then
  ok "prompt-registry 端点正常（部署自检项）"
else
  info "prompt-registry 响应: ${PR:0:150}"
fi

echo ""
echo "═══════════════════════════════════════════════"
echo " 结果: 通过 ${PASS} 项 / 失败 ${FAIL} 项"
echo " 资产目录: $TMP/assets_js  $TMP/assets_css"
echo "═══════════════════════════════════════════════"
[[ $FAIL -eq 0 ]] && echo "✅ 全部通过" || echo "⚠️  有失败项，需人工判定"
exit $((FAIL > 0 ? 1 : 0))
