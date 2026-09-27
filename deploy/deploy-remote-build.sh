#!/usr/bin/env bash
# 在服务器 /opt/lnkpi 执行：本地 docker build + compose up（无 TCR 跨境 push）
set -euo pipefail

cd "$(dirname "$0")/.."
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi
IMAGE_TAG="${IMAGE_TAG:?set IMAGE_TAG to git commit sha}"
STATUS_FILE="${STATUS_FILE:-/tmp/lnkpi-deploy-${IMAGE_TAG}.status}"
LOG_FILE="${LOG_FILE:-/tmp/lnkpi-deploy-${IMAGE_TAG}.log}"
export LNKPI_API_IMAGE="lnkpi-api:${IMAGE_TAG}"
export USE_TENCENT_APT_MIRROR=1
export DOCKER_BUILDKIT=1
export COMPOSE_DOCKER_CLI_BUILD=1

COMPOSE="docker compose -f deploy/docker-compose.prod.yml"

log() {
  echo "[$(date -u +%H:%M:%S)] $*" >>"$LOG_FILE"
}

set_status() {
  echo "$1" > "$STATUS_FILE"
  log "status=$1"
}

on_fail() {
  set_status failed
  docker logs lnkpi-api --tail 40 2>&1 || true
  exit 1
}

set_status running

log "=== Disk before build (${LNKPI_API_IMAGE}) ==="
df -h / /var/lib/docker 2>/dev/null || df -h /

log "=== Prune unused Docker data ==="
docker image prune -f >/dev/null 2>&1 || true
# 仅在 Docker 数据盘 >85% 时清理 builder cache，避免误删 apt/pnpm 层缓存导致冷构建 1h+
docker_use_pct=$(df /var/lib/docker 2>/dev/null | awk 'NR==2 {gsub(/%/,"",$5); print $5}')
if [[ -z "${docker_use_pct}" ]]; then
  docker_use_pct=$(df / | awk 'NR==2 {gsub(/%/,"",$5); print $5}')
fi
if [[ "${docker_use_pct:-0}" -gt 85 ]]; then
  log "Docker disk ${docker_use_pct}% — pruning builder cache older than 7d"
  docker builder prune -f --filter 'until=168h' >/dev/null 2>&1 || true
else
  log "Docker disk ${docker_use_pct}% — keeping builder cache"
fi
# 回滚支持：保留当前 tag、latest，以及最近 KEEP_PREVIOUS 个历史版本（默认 1），其余 tag 清理。
# 依据：lnkpi-api 各层（依赖 562MB / apt 473MB / 基础 243MB）在两次构建间内容稳定，
# Docker 按层内容寻址共享 → 多留一个历史版本的真实磁盘增量 ≈ 业务层（apps/server/dist，约 1MB）。
KEEP_PREVIOUS="${LNKPI_KEEP_PREVIOUS:-1}"
protect_ids="$(
  docker images --format '{{.ID}}' --filter "reference=lnkpi-api:${IMAGE_TAG}" 2>/dev/null || true
  docker images --format '{{.ID}}' --filter 'reference=lnkpi-api:latest' 2>/dev/null || true
)"
prev_ids="$(
  docker images --format '{{.ID}} {{.CreatedAt}}' lnkpi-api 2>/dev/null \
    | sort -k2,3 -r \
    | awk '{print $1}' \
    | uniq \
    | grep -vxF -f <(printf '%s\n' "$protect_ids" | sed '/^[[:space:]]*$/d') \
    | head -n "$KEEP_PREVIOUS" || true
)"
keep_ids="$(printf '%s\n%s\n' "$protect_ids" "$prev_ids" | sed '/^[[:space:]]*$/d' | sort -u)"
prev_tag=""
if [[ -n "${prev_ids//[[:space:]]/}" ]]; then
  prev_tag="$(docker images --format '{{.ID}} {{.Tag}}' lnkpi-api 2>/dev/null \
    | awk -v id="$(printf '%s\n' "$prev_ids" | head -n1)" '$1==id && $2!="latest" && $2!="<none>" {print $2; exit}')"
  if [[ -n "$prev_tag" ]]; then
    printf '%s\n' "$prev_tag" > .last-api-image 2>/dev/null || true
    log "rollback point kept: lnkpi-api:${prev_tag}"
    log "rollback cmd: LNKPI_API_IMAGE=lnkpi-api:${prev_tag} docker compose -f deploy/docker-compose.prod.yml up -d --no-build --force-recreate api"
  fi
else
  log "no previous lnkpi-api image to keep (first deploy or already pruned)"
fi
log "=== Prune old lnkpi-api images (keep ${LNKPI_API_IMAGE}, latest${prev_tag:+, lnkpi-api:${prev_tag}}) ==="
docker images --format '{{.ID}} {{.Tag}}' lnkpi-api 2>/dev/null | while read -r id tag; do
  [[ -z "${tag:-}" || "$tag" == "<none>" ]] && continue
  printf '%s\n' "$keep_ids" | grep -qx "$id" && continue
  log "pruning lnkpi-api:${tag}"
  docker rmi "lnkpi-api:${tag}" 2>/dev/null || true
done

log "=== Building ${LNKPI_API_IMAGE} on CVM ==="
if ! $COMPOSE build --progress=plain api >>"$LOG_FILE" 2>&1; then
  on_fail
fi
docker tag "${LNKPI_API_IMAGE}" lnkpi-api:latest

log "=== Starting container ==="
# 只起 api：pi-runtime 由 K3s 独立部署（见 docs/ops/RUNBOOK-pi-runtime-deploy.md），不在本 compose 内
$COMPOSE up -d --no-build --force-recreate --remove-orphans api

log "=== Port binding ==="
ss -tlnp | grep ':5100' || true
docker port lnkpi-api 2>/dev/null || true

if command -v ufw >/dev/null 2>&1 && sudo ufw status 2>/dev/null | grep -qi active; then
  log "=== UFW active, allowing TCP 5100 ==="
  sudo ufw allow 5100/tcp comment 'lnkpi-api' || true
  sudo ufw status numbered | grep 5100 || true
fi

log "=== Waiting for health ==="
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if curl -fsS "http://127.0.0.1:5100/api/health" >/dev/null 2>&1; then
    curl -fsS "http://127.0.0.1:5100/api/health" | head -c 200
    echo ""
    log "=== Sync platform channel baseUrl from container env ==="
    docker exec lnkpi-api node -e "
const { PrismaClient } = require('@prisma/client');
const url = (process.env.OPENAI_BASE_URL || '').trim();
if (!url) { console.log('skip platform baseUrl sync: OPENAI_BASE_URL unset'); process.exit(0); }
const p = new PrismaClient();
p.providerChannel.update({ where: { id: 'platform' }, data: { baseUrl: url } })
  .then((row) => { console.log('platform.baseUrl synced to', row.baseUrl); return p.\$disconnect(); })
  .catch((err) => { console.error(err); process.exit(1); });
" >>"$LOG_FILE" 2>&1 || log "WARN: platform baseUrl sync failed (non-fatal)"

    set_status success
    log "部署完成 (IMAGE=${LNKPI_API_IMAGE})"
    exit 0
  fi
  log "health attempt $i failed, retry..."
  sleep $((i <= 5 ? 5 : 10))
done

log "health check failed after retries"
on_fail
