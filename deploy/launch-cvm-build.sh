#!/usr/bin/env bash
# 在 CVM 上由 deploy workflow 调用：立即返回，构建在后台执行
set -euo pipefail

IMAGE_TAG="${1:?usage: launch-cvm-build.sh <git-sha>}"
DEPLOY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DEPLOY_DIR"

# ---- B4 防呆检查：防止从缺少 pi-runtime 分流代码的旧源码树构建 ----
# 2026-09-23 事故：从不含 B4 的环境打包覆盖 /opt/lnkpi，active 分流静默失效。
AGENT_SERVICE="apps/server/src/agent/agent.service.ts"
PI_RUNTIME_DIR="apps/server/src/agent/pi-runtime"
if ! grep -q "PI_RUNTIME" "$AGENT_SERVICE" 2>/dev/null || [[ ! -d "$PI_RUNTIME_DIR" ]]; then
  echo "ERROR: 源码树缺少 pi-runtime 分流代码（B4）！" >&2
  echo "  缺失标志: $AGENT_SERVICE 中无 PI_RUNTIME 引用，或 $PI_RUNTIME_DIR 目录不存在" >&2
  echo "  继续构建会产出不含 active 分流的镜像，导致静默回退老 runtime。" >&2
  echo "  修复: 从 pi-lnk master 最新源码重新同步本目录（git pull 后 tar 同步），再部署。" >&2
  exit 1
fi

# ---- 镜像 tag 与源码树一致性警告（仅 git 仓库内提示，CVM 非仓库则跳过）----
TREE_SHA="$(git rev-parse --short=7 HEAD 2>/dev/null || true)"
if [[ -n "$TREE_SHA" && "$TREE_SHA" != "$IMAGE_TAG" ]]; then
  echo "WARN: IMAGE_TAG=$IMAGE_TAG 但当前源码树 HEAD=$TREE_SHA，两者不一致（tag 将不代表真实代码）。" >&2
fi

STATUS_FILE="/tmp/lnkpi-deploy-${IMAGE_TAG}.status"
LOG_FILE="/tmp/lnkpi-deploy-${IMAGE_TAG}.log"
PID_FILE="/tmp/lnkpi-deploy-${IMAGE_TAG}.pid"

export IMAGE_TAG STATUS_FILE LOG_FILE

rm -f "$STATUS_FILE" "$LOG_FILE" "$PID_FILE"

# 终止可能卡住的旧构建，避免并发 docker build 打满 CVM
pkill -f "deploy-remote-build.sh" 2>/dev/null || true
sleep 1

if [[ -f "$PID_FILE" ]]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$OLD_PID" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "build already running pid=${OLD_PID}"
    exit 0
  fi
fi

nohup env IMAGE_TAG="$IMAGE_TAG" STATUS_FILE="$STATUS_FILE" LOG_FILE="$LOG_FILE" \
  bash deploy/deploy-remote-build.sh </dev/null >>"$LOG_FILE" 2>&1 &
echo $! >"$PID_FILE"
disown -a 2>/dev/null || true

echo "launched pid=$(cat "$PID_FILE") log=$LOG_FILE"
