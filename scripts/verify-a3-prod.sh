#!/usr/bin/env bash
# A3 上线取证（三层证据链，2026-10-22）
# 用法：bash scripts/verify-a3-prod.sh
# 纪律（来自项目 memory）：
# ① 入口 chunk 变 + 旧 chunk 404 ⇒ 真的上线了
# ② grep 产物里的**字面量/属性名**（标识符会被 rollup 改名，函数名 grep 必 0 命中）
# ③ web 路由懒加载 ⇒ 组件只在其 assets/<Page>-<hash>.js 分包里，入口 0 命中是常态
set -uo pipefail
BASE="${BASE:-http://119.29.173.89:8888}"
TMP="$(mktemp -d)"
cd "$TMP"

echo "=== 层① 入口 chunk 变 + 旧 chunk 404 ==="
curl -s --max-time 20 "$BASE/" -o index.html -w "  index.html http=%{http_code}\n"
ENTRY=$(grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' index.html | head -1 | sed 's|/assets/||')
CSS=$(grep -oE '/assets/index-[A-Za-z0-9_-]+\.css' index.html | head -1 | sed 's|/assets/||')
echo "  入口 js : $ENTRY"
echo "  入口 css: $CSS"
for old in index-BH1cb-6k.js index-Blx76l8a.js; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 12 "$BASE/assets/$old")
  echo "  旧 ${old} → ${code}（期望 404）"
done
code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 12 "$BASE/assets/$ENTRY")
echo "  新 ${ENTRY} → ${code}（期望 200）"

echo
echo "=== 层② 产物字面量（coverUrl / coverNodeId / 作品带文案 / 印记资产） ==="
curl -s --max-time 25 "$BASE/assets/$ENTRY" -o entry.js
echo "  入口 js 内 AgentSideRail 命中: $(grep -c 'AgentSideRail' entry.js)（0 正常，组件在分包）"
mkdir -p js
grep -oE 'assets/[A-Za-z0-9_.-]+\.js' entry.js | sort -u > chunks.txt
echo "  分包数: $(wc -l < chunks.txt | tr -d ' ')"
while read -r c; do
  f=$(basename "$c")
  curl -s --max-time 25 "$BASE/$c" -o "js/$f" &
done < chunks.txt
wait
echo "  --- 作品带字面量 ---"
for s in "继续你的创作" "recent-work-item" "recent-work-cover" "coverUrl" "coverNodeId" "focusNode="; do
  hit=$(grep -l "$s" js/*.js 2>/dev/null | head -1)
  if [ -n "$hit" ]; then echo "  ✓ '$s' → $(basename "$hit")"; else echo "  ✗ '$s' 未命中"; fi
done

echo
echo "=== 层③ 静态资产（墨鱼默认封面） ==="
for a in default-64.png default-128.png default-256.png mark-ink-anchor.png; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 12 "$BASE/brand/canvas-cover/$a")
  echo "  /brand/canvas-cover/$a → $code"
done
if curl -s --max-time 15 "$BASE/brand/canvas-cover/default-128.png" -o dc.png; then
  /Users/4seven/.workbuddy/binaries/python/versions/3.13.12/bin/python3 - <<'PY'
from PIL import Image
im = Image.open('dc.png')
px = im.convert('RGBA').load()
print(f"  default-128.png: {im.size} {im.mode} | 角像素 alpha={px[0,0][3]}（圆角 ⇒ 0）")
PY
fi

echo
echo "=== 后端 API（列表带封面字段；无登录态时 401 属正常） ==="
curl -s --max-time 15 -o /dev/null -w "  /api/agent/canvas/list → %{http_code}\n" "$BASE/api/agent/canvas/list"
curl -s --max-time 15 -o /dev/null -w "  /api/health → %{http_code}\n" "$BASE/api/health"

rm -rf "$TMP"
