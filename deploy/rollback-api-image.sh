#!/usr/bin/env bash
# 自动回滚 API 镜像到上一个已知良好版本（部署护栏原语）。
#
# 背景（2026-11-16 生产事故 #929）：新镜像因 Nest DI 缺陷启动即崩 ⇒ deploy-remote-build.sh
# 的健康检查 15 次全失败 ⇒ 脚本 on_fail 退出；但生产容器仍停在崩溃回环（/api/health 502），
# 而当时的「回滚命令」只是打印在日志里、没有人执行 ⇒ 长时间无人值守。
# 现在：健康失败时由本脚本自动回滚，把结果落到 marker 文件 + 部署日志。
#
# 契约（CI 离线验证见 scripts/verify-deploy-rollback.sh —— 场景矩阵必须覆盖失败路径）：
#   入参（全部走环境变量，便于注入桩）：
#     IMAGE_TAG       新镜像 tag（本次部署目标）                  必填
#     PREV_TAG        回滚候选 tag（构建前捕获的上一镜像）      可空 ⇒ 跳过回滚
#     LAST_GOOD_FILE  「上次成功部署的镜像」记录文件              默认 .last-good-api-image
#     API_HEALTH_URL  健康检查 URL       默认 http://127.0.0.1:5100/api/health
#     COMPOSE_FILE    compose 文件        默认 deploy/docker-compose.prod.yml
#     LOG_FILE        日志文件（追加）     可空 ⇒ 只写 stdout
#     MARKER_FILE     结果 marker 文件    可空
#     CURL_BIN        健康检查命令         默认 curl
#     DOCKER_BIN      docker 命令          默认 docker
#     ROLLBACK_HEALTH_RETRIES / ROLLBACK_HEALTH_INTERVAL  二次健康校验次数 / 间隔秒  默认 10 / 3
#   退出码：
#     0 = 回滚成功且服务健康
#     1 = 回滚执行了但服务仍不健康（需人工介入）
#     2 = 跳过回滚（无 PREV_TAG / PREV_TAG == IMAGE_TAG）——不是失败，只是没有可回滚目标
set -uo pipefail

IMAGE_TAG="${IMAGE_TAG:?IMAGE_TAG is required}"
PREV_TAG="${PREV_TAG:-}"
API_HEALTH_URL="${API_HEALTH_URL:-http://127.0.0.1:5100/api/health}"
COMPOSE_FILE="${COMPOSE_FILE:-deploy/docker-compose.prod.yml}"
LOG_FILE="${LOG_FILE:-}"
MARKER_FILE="${MARKER_FILE:-}"
CURL_BIN="${CURL_BIN:-curl}"
DOCKER_BIN="${DOCKER_BIN:-docker}"
LAST_GOOD_FILE="${LAST_GOOD_FILE:-.last-good-api-image}"
RETRIES="${ROLLBACK_HEALTH_RETRIES:-10}"
INTERVAL="${ROLLBACK_HEALTH_INTERVAL:-3}"

# 日志一律走 stderr：resolve_target 在命令替换 $(...) 里执行，
# 若 log 写 stdout 会把日志文本混进回滚目标变量（实测踩过：TARGET 变成多行）。
log() {
  local msg="[$(date -u +%H:%M:%S)] [rollback] $*"
  echo "$msg" >&2
  if [[ -n "$LOG_FILE" ]]; then
    echo "$msg" >>"$LOG_FILE"
  fi
}

# 追加输出的目标：LOG_FILE 有值就落盘，否则丢弃（避免污染 stdout 契约）
sink() { echo "${LOG_FILE:-/dev/null}"; }

# 镜像是否存在（桩可替换 DOCKER_BIN）
image_exists() {
  "$DOCKER_BIN" image inspect "$1" >/dev/null 2>&1
}

# 回滚目标选择（优先级）：
#   1) LAST_GOOD_FILE 记录的「上次成功部署的镜像」——最可信（它真的跑通过健康检查）；
#   2) PREV_TAG（构建前按时间抓到的上一个镜像）——只是「最近」，可能是上一次失败部署的坏镜像。
#      ⚠️ 2026-11-16 事故实证：#929 的坏镜像 bd038ea9 比好镜像 de30e8f8 更新，按时间取会选中坏镜像。
resolve_target() {
  if [[ -n "$LAST_GOOD_FILE" && -f "$LAST_GOOD_FILE" ]]; then
    local lg
    lg="$(head -n1 "$LAST_GOOD_FILE" 2>/dev/null | tr -d '\r' | tr -d '[:space:]')"
    if [[ -n "$lg" && "$lg" != "$IMAGE_TAG" ]] && image_exists "lnkpi-api:${lg}"; then
      echo "$lg"
      return 0
    fi
    log "last-good 候选不可用（${lg:-空}）——回退到 prev_tag"
  fi
  if [[ -n "$PREV_TAG" && "$PREV_TAG" != "$IMAGE_TAG" ]] && image_exists "lnkpi-api:${PREV_TAG}"; then
    echo "$PREV_TAG"
    return 0
  fi
  return 1
}

TARGET="$(resolve_target || true)"
if [[ -z "$TARGET" ]]; then
  log "SKIP: 没有可用的回滚目标（last-good 与 prev_tag 均不可用）"
  exit 2
fi
PREV_TAG="$TARGET"

log "回滚目标: lnkpi-api:${IMAGE_TAG} → lnkpi-api:${PREV_TAG}"

# 1) 用上一版本镜像重建容器（--no-build：镜像已在本地；--force-recreate：换镜像必须重建）
export LNKPI_API_IMAGE="lnkpi-api:${PREV_TAG}"
if ! "$DOCKER_BIN" compose -f "$COMPOSE_FILE" up -d --no-build --force-recreate --remove-orphans api >>"$(sink)" 2>&1; then
  log "ERROR: compose up 失败（回滚未生效）"
  exit 1
fi

# 2) latest 也要指回好镜像：裸 `docker compose up -d`（未带 LNKPI_API_IMAGE）会用 latest。
if ! "$DOCKER_BIN" tag "lnkpi-api:${PREV_TAG}" lnkpi-api:latest >>"$(sink)" 2>&1; then
  log "WARN: 回滚后重打 latest 失败（裸 compose up 仍会指向坏镜像）"
fi

# 3) 二次健康校验：回滚后服务必须真的活着，否则等于没回滚
for i in $(seq 1 "$RETRIES"); do
  if "$CURL_BIN" -fsS "$API_HEALTH_URL" >/dev/null 2>&1; then
    log "OK: 回滚后健康校验通过（lnkpi-api:${PREV_TAG}）"
    if [[ -n "$MARKER_FILE" ]]; then
      mkdir -p "$(dirname "$MARKER_FILE")" 2>/dev/null || true
      if printf 'rolled_back\nimage=%s\nprev=%s\n' "$IMAGE_TAG" "$PREV_TAG" >"$MARKER_FILE" 2>/dev/null; then
        log "marker 已写入: ${MARKER_FILE}"
      else
        log "WARN: marker 写入失败（${MARKER_FILE}）——服务已回滚，但 CI 看不到回滚标记"
      fi
    fi
    exit 0
  fi
  log "rollback health attempt ${i}/${RETRIES} failed"
  sleep "$INTERVAL"
done

log "ERROR: 回滚后健康校验仍失败（lnkpi-api:${PREV_TAG}）——需人工介入"
exit 1
