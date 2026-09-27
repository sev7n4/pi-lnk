#!/usr/bin/env bash
# Sync the internal service token from production CVM into local dev .env files.
#
# ⚠️ 名字里的 AGENT_RUNTIME 是历史命名：老 LangGraph runtime 已于 2026-09-27 退役，
# 但该 token 仍是 `/agent/internal/*` 的服务间鉴权——**pi-runtime 调 Nest 画布工具仍在用**。
# 现在它是「内部服务 token」，不是"老 runtime 的 token"。
#
# Usage: bash deploy/sync-prod-service-token-to-local.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/tencent_cloud_deploy}"
SSH_USER="${SSH_USER:-root}"
SSH_HOST="${SSH_HOST:-119.29.173.89}"
REMOTE_ENV="/opt/lnkpi/.env"
NEST_ENV="$ROOT/apps/server/.env"
PI_RUNTIME_ENV="$ROOT/services/pi-runtime/.env"

if [[ ! -f "$SSH_KEY" ]]; then
  echo "ERROR: SSH key not found: $SSH_KEY" >&2
  exit 1
fi

TOKEN="$(
  ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "${SSH_USER}@${SSH_HOST}" \
    "grep -E '^(LNKPI_INTERNAL_SERVICE_TOKEN|AGENT_RUNTIME_SERVICE_TOKEN)=' '${REMOTE_ENV}' | tail -1 | cut -d= -f2- | tr -d '\"'"
)"

if [[ -z "$TOKEN" ]]; then
  echo "ERROR: internal service token not found on CVM (${REMOTE_ENV})" >&2
  exit 1
fi

upsert_env() {
  local file="$1"
  local key="$2"
  local value="$3"
  touch "$file"
  if grep -q "^${key}=" "$file" 2>/dev/null; then
    if [[ "$(uname)" == Darwin ]]; then
      sed -i '' "s|^${key}=.*|${key}=\"${value}\"|" "$file"
    else
      sed -i "s|^${key}=.*|${key}=\"${value}\"|" "$file"
    fi
  else
    printf '\n%s="%s"\n' "$key" "$value" >>"$file"
  fi
}

mkdir -p "$(dirname "$NEST_ENV")"
touch "$NEST_ENV"
upsert_env "$NEST_ENV" "LNKPI_INTERNAL_SERVICE_TOKEN" "$TOKEN"
upsert_env "$NEST_ENV" "AGENT_RUNTIME_SERVICE_TOKEN" "$TOKEN"

# pi-runtime → Nest 的本地回连配置（若本地起了 pi-runtime）
if [[ -f "$PI_RUNTIME_ENV" ]]; then
  if [[ "$(uname)" == Darwin ]]; then
    sed -i '' "s|^NEST_BASE_URL=.*|NEST_BASE_URL=http://127.0.0.1:${LOCAL_API_PORT:-3001}/api|" "$PI_RUNTIME_ENV"
    sed -i '' "s|^NEST_SERVICE_TOKEN=.*|NEST_SERVICE_TOKEN=${TOKEN}|" "$PI_RUNTIME_ENV"
  else
    sed -i "s|^NEST_BASE_URL=.*|NEST_BASE_URL=http://127.0.0.1:${LOCAL_API_PORT:-3001}/api|" "$PI_RUNTIME_ENV"
    sed -i "s|^NEST_SERVICE_TOKEN=.*|NEST_SERVICE_TOKEN=${TOKEN}|" "$PI_RUNTIME_ENV"
  fi
fi

echo "Synced internal service token (len=${#TOKEN}) to:"
echo "  - $NEST_ENV"
[[ -f "$PI_RUNTIME_ENV" ]] && echo "  - $PI_RUNTIME_ENV"
