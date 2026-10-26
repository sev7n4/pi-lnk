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

if curl -fsS --connect-timeout 5 --max-time 15 "${BASE}/" -o "$TMP/index.html" 2>/dev/null; then
  WEB="$(cat "$TMP/index.html")"
  ok "Web 首页可访问（$(wc -c < "$TMP/index.html") 字节）"
else
  WEB=""
  bad "Web 首页不可访问"
fi

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
# ⚠️ 提取必须**只认 assets/ 路径前缀**，否则会把 HTML 全文或整段 JS 当成文件名
#   （踩坑记录：早期版本用 `"[^"]*assets/..."` 匹配到 HTML 内容 ⇒
#    "File name too long"，79 个 URL 全废，判据假红）
extract_assets() {
  grep -oE '"assets/[A-Za-z0-9_.-]+\.(js|css)"' "$1" 2>/dev/null \
    | tr -d '"' | sort -u
}
# ① HTML 里的入口
: > "$TMP/asset_list.txt"
grep -oE '/assets/[A-Za-z0-9_.-]+\.(js|css)' "$TMP/index.html" 2>/dev/null | sort -u >> "$TMP/asset_list.txt"
# ② 入口 chunk 的 mapDeps（vite 把 lazy chunk 清单放在这）
if [[ -f "$TMP/entry.js" ]]; then
  extract_assets "$TMP/entry.js" >> "$TMP/asset_list.txt"
fi
sort -u "$TMP/asset_list.txt" -o "$TMP/asset_list.txt"
# ③ 下载第一批，并从新下载的 chunk 里再抽一层（分包可能引分包）
CNT=0
ROUNDS=0
while [[ $ROUNDS -lt 2 ]]; do
  ROUNDS=$((ROUNDS+1))
  : > "$TMP/asset_list_$ROUNDS.txt"
  while read -r a; do
    [[ -z "$a" ]] && continue
    base=$(basename "$a")
    case "$base" in
      *.css)
        [[ -f "$TMP/assets_css/$base" ]] && continue
        curl -fsS --connect-timeout 5 --max-time 20 "${BASE}/${a}" -o "$TMP/assets_css/$base" 2>/dev/null \
          && echo "$a" >> "$TMP/asset_list_$ROUNDS.txt" ;;
      *.js)
        [[ -f "$TMP/assets_js/$base" ]] && continue
        curl -fsS --connect-timeout 5 --max-time 20 "${BASE}/${a}" -o "$TMP/assets_js/$base" 2>/dev/null \
          && echo "$a" >> "$TMP/asset_list_$ROUNDS.txt" ;;
    esac
    CNT=$((CNT+1))
  done < "$TMP/asset_list.txt"
  # 从本轮新下载的 chunk 里抽下一层
  : > "$TMP/asset_list.txt"
  for f in "$TMP"/assets_js/*.js; do
    [[ -f "$f" ]] && extract_assets "$f" >> "$TMP/asset_list.txt"
  done
  sort -u "$TMP/asset_list.txt" -o "$TMP/asset_list.txt"
  [[ ! -s "$TMP/asset_list.txt" ]] && break
done
JS_N=$(ls "$TMP/assets_js" 2>/dev/null | wc -l | tr -d ' ')
CSS_N=$(ls "$TMP/assets_css" 2>/dev/null | wc -l | tr -d ' ')
ok "已下载 ${JS_N} 个 js 分包 / ${CSS_N} 个 css 分包"

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
  "改词"                            # Task 9 底部主栏按钮文案（testid 动态 ⇒ 用文案判）
  "viewer-bottom-actions"          # Task 9 底部主栏（testid 是动态插值，判据用类名）
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
# ── 3.5 正对照（生产**既有**标识必须命中 → 证明检索方法本身没失效）─────
echo ""
echo "【3.5】正对照（证明检索方法本身有效，不是恒不命中）"
# ⭐ 这组标识是**上线前就存在**的移动端能力 ⇒ 部署后必须仍能命中。
#   若这组都命中不了 ⇒ 说明「分包没下全 / 检索坏了」，此时第 2/3 层的
#   「未命中」是**假红**，不能据此判「未上线」（与 AGENTS.md「入口 0 命中 ≠
#   没上线」同类）。
POSITIVE=(
  "mobile-node-tile"
  "m-sheet-scrim"
)
POS_OK=0
for lit in "${POSITIVE[@]}"; do
  HIT=$(grep -rl -- "$lit" "$TMP"/assets_js "$TMP"/assets_css 2>/dev/null | head -1)
  if [[ -n "$HIT" ]]; then
    ok "正对照命中: ${lit} -> $(basename "$HIT")"
    POS_OK=$((POS_OK+1))
  else
    bad "正对照未命中: ${lit} => 检索方法/分包下载可能失效，后续「未命中」不可信"
  fi
done
if [[ $POS_OK -gt 0 ]]; then
  ok "正对照通过（${POS_OK}/${#POSITIVE[@]}）=> 后续未命中判定可信"
else
  bad "正对照全灭 => 本轮取证不可信"
fi

for lit in "__lnk_definitely_not_exists_9f3a__" "zzz_never_deployed_marker_7c2e"; do
  HIT=$(grep -rl -- "$lit" "$TMP"/assets_js "$TMP"/assets_css 2>/dev/null | head -1)
  [[ -z "$HIT" ]] && ok "负向对照正确未命中: ${lit}" || bad "负向对照竟然命中 ⇒ 检索方法有误"
done

# ── 4.5 CSS 实际内容抽检（第四层取证：CSS 内容 hash 跨构建确定）────────
echo ""
echo "【4.5】CSS 实际内容抽检（判上线看 CSS，不看 JS hash）"
# ⭐ AGENTS.md 铁律：**CSS 内容 hash 跨构建确定、JS hash 不确定** ⇒
#   判「我的样式是否已上线」必须看 CSS 分包里的类名与令牌，不能只看入口 hash。
# 抽检：主 CSS 分包里是否含本次新增的令牌引用（--lnk-radius-2xl / --lnk-duration-base）
CSS_MAIN=$(ls "$TMP"/assets_css/index-*.css 2>/dev/null | head -1)
if [[ -n "$CSS_MAIN" ]]; then
  for tok in "--lnk-radius-2xl" "--lnk-duration-base" "--lnk-touch-target"; do
    if grep -q -- "$tok" "$CSS_MAIN" 2>/dev/null; then
      ok "主 CSS 含令牌: ${tok}"
    else
      info "主 CSS 未见令牌: ${tok}（可能拆到其他 CSS 分包）"
    fi
  done
else
  info "未取到主 CSS 分包（入口 CSS 未下载成功）"
fi
# reduce-motion 分支（Task 9 落地判据）
if grep -rq "prefers-reduced-motion" "$TMP"/assets_css 2>/dev/null; then
  ok "生产 CSS 含 prefers-reduced-motion 分支（Task 9 落地）"
else
  info "生产 CSS 未见 prefers-reduced-motion（可能未上线或未在该分包）"
fi

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
