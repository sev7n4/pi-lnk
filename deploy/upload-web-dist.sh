#!/usr/bin/env bash
# 上传 web dist 到 CVM：按内容差量同步，并在改 nginx 之前逐文件校验完整性。
#
# 发布目录语义与旧链路一致：只清 assets，不使用 --delete，不做 staging 切换。
# 所有远端动作都经过 run_remote / COPY_CMD，scripts/verify-web-upload.py 可把
# 它们注入为本地目录，从而端到端跑真实 rsync 与真实 SHA 工具。
#
# 一键回退：LNKPI_WEB_UPLOAD_LEGACY=1（或在 workflow 里设同名 repo variable）。
set -euo pipefail

DIST="${LNKPI_WEB_DIST:-apps/web/dist}"
REMOTE_DIST="${LNKPI_WEB_REMOTE_DIST:-/opt/lnkpi/web/dist}"
REMOTE_DEPLOY_DIR="${LNKPI_WEB_REMOTE_DEPLOY_DIR:-/opt/lnkpi/deploy}"
SHARE_DIR="${LNKPI_WEB_SHARE_DIR:-/opt/lnkpi/share}"
REMOTE_HOST="${LNKPI_WEB_REMOTE_HOST:-deploy-cvm}"
RSYNC_DEST="${LNKPI_WEB_RSYNC_DEST:-${REMOTE_HOST}:${REMOTE_DIST}/}"
RSYNC_BIN="${LNKPI_WEB_RSYNC_BIN:-rsync}"
REMOTE_EXEC="${LNKPI_WEB_REMOTE_EXEC:-ssh ${REMOTE_HOST}}"
COPY_CMD="${LNKPI_WEB_COPY:-scp}"
SIDECARS="${LNKPI_WEB_SIDECARS:-deploy}"
WORK="${LNKPI_WEB_WORK:-/tmp}"
INBOX="${LNKPI_WEB_INBOX:-/tmp}"
SYNC_LOG="${LNKPI_WEB_SYNC_LOG:-/tmp/lnkpi-web-rsync.log}"
LEGACY="${LNKPI_WEB_UPLOAD_LEGACY:-0}"
VERIFY_ONLY="${LNKPI_WEB_VERIFY_ONLY:-0}"

MANIFEST="${WORK}/lnkpi-web-manifest.sha256"
TGZ="${WORK}/lnkpi-web-dist.tgz"

if command -v sha256sum >/dev/null 2>&1; then
  SHA_BIN="sha256sum"
else
  SHA_BIN="shasum -a 256"
fi

# 远端执行器：生产是 "ssh deploy-cvm"，测试注入为本地 wrapper。
run_remote() {
  # shellcheck disable=SC2086
  $REMOTE_EXEC "$1"
}

# 把本地 dist 的每个文件写成 sha256sum -c 可读的清单；清单不落在 dist 内。
make_manifest() {
  mkdir -p "$WORK"
  (
    cd "$DIST"
    find . -type f -print | LC_ALL=C sort | while IFS= read -r rel; do
      digest=$($SHA_BIN "$rel" | awk '{print $1}')
      printf '%s  %s\n' "$digest" "$rel"
    done
  ) > "$MANIFEST"
}

# 只清旧 hashed chunk；远端其它历史文件保留，与原 tar 覆盖语义一致。
prepare_remote() {
  run_remote "mkdir -p '${REMOTE_DIST}' && rm -rf '${REMOTE_DIST}/assets'"
}

incremental_upload() {
  : > "$SYNC_LOG"
  "$RSYNC_BIN" -az --checksum --partial --timeout=60 \
    --out-format='%i %n' --stats "${DIST}/" "${RSYNC_DEST}" > "$SYNC_LOG"
}

# 旧链路：全量 tar + scp + 解包，作为回退路径保留。
legacy_upload() {
  tar -czf "$TGZ" -C "$DIST" .
  # shellcheck disable=SC2086
  $COPY_CMD "$TGZ" "${REMOTE_HOST}:/tmp/"
  run_remote "tar -xzf '${INBOX}/$(basename "$TGZ")' -C '${REMOTE_DIST}'"
}

upload_sidecars() {
  local nginx_src="${SIDECARS}/nginx.conf"
  local deploy_src="${SIDECARS}/deploy-web.sh"
  # #723：分享默认 OG 卡必须随 web 部署落到主机 SHARE_DIR（nginx 直出，绕过 Nest）。
  # 缺失会让所有分享卡的 OG 预览图 404。播种语义与原 scp 链路完全一致。
  local og_src="${SIDECARS}/static/share-og-default.png"
  if [[ ! -f "$nginx_src" || ! -f "$deploy_src" || ! -f "$og_src" ]]; then
    echo "ERROR: missing nginx.conf / deploy-web.sh / static/share-og-default.png in ${SIDECARS}" >&2
    exit 1
  fi
  # shellcheck disable=SC2086
  $COPY_CMD "$nginx_src" "$deploy_src" "$og_src" "$MANIFEST" "${REMOTE_HOST}:/tmp/"
  run_remote "mkdir -p '${REMOTE_DEPLOY_DIR}' '${SHARE_DIR}' && cp '${INBOX}/nginx.conf' '${REMOTE_DEPLOY_DIR}/nginx.conf' && cp '${INBOX}/deploy-web.sh' '${REMOTE_DEPLOY_DIR}/deploy-web.sh' && chmod +x '${REMOTE_DEPLOY_DIR}/deploy-web.sh' && cp -f '${INBOX}/share-og-default.png' '${SHARE_DIR}/share-og-default.png' && chmod 644 '${SHARE_DIR}/share-og-default.png'"
}

# 校验失败必须硬失败：绝不进入 Configure nginx on CVM。
verify_manifest() {
  local manifest_name remote_manifest n check
  manifest_name="$(basename "$MANIFEST")"
  remote_manifest="${INBOX}/${manifest_name}"
  n="$(wc -l < "$MANIFEST" | tr -d '[:space:]')"
  check="cd '${REMOTE_DIST}' && if command -v sha256sum >/dev/null 2>&1; then sha256sum -c '${remote_manifest}'; else shasum -a 256 -c '${remote_manifest}'; fi"
  if ! run_remote "$check"; then
    echo "ERROR: remote manifest verification failed (${n} files)" >&2
    exit 1
  fi
  echo "MANIFEST_OK files=${n}"
}

cleanup() {
  run_remote "rm -f '${INBOX}/lnkpi-web-dist.tgz' '${INBOX}/nginx.conf' '${INBOX}/deploy-web.sh' '${INBOX}/share-og-default.png'"
  rm -f "$TGZ"
}

main() {
  if [[ ! -d "$DIST" ]]; then
    echo "ERROR: missing dist directory: ${DIST}" >&2
    exit 1
  fi

  make_manifest

  # 运维能力：只重验已上传内容，不传输、不清 assets。
  if [[ "$VERIFY_ONLY" == "1" ]]; then
    # shellcheck disable=SC2086
    $COPY_CMD "$MANIFEST" "${REMOTE_HOST}:/tmp/"
    verify_manifest
    exit 0
  fi

  prepare_remote
  if [[ "$LEGACY" == "1" ]]; then
    echo "UPLOAD_MODE=legacy reason=LNKPI_WEB_UPLOAD_LEGACY"
    legacy_upload
  elif ! command -v "$RSYNC_BIN" >/dev/null 2>&1; then
    echo "UPLOAD_MODE=legacy reason=rsync_unavailable"
    legacy_upload
  else
    echo "UPLOAD_MODE=incremental"
    incremental_upload
  fi

  upload_sidecars
  verify_manifest
  cleanup
  echo "WEB_DIST_UPLOAD_OK"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
