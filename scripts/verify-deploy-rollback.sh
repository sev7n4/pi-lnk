#!/usr/bin/env bash
# 文件：scripts/verify-deploy-rollback.sh
# 离线验证部署护栏「健康检查失败自动回滚」（deploy/rollback-api-image.sh）。
#
# 为什么这个脚本进版本库（而不是按惯例只放 /tmp）：护栏的唯一价值在「该失败时真的回滚」，
# 而它的失败路径只能在生产炸一次才知道 ⇒ 必须在 CI 里用桩把每条路径都跑一遍。
# 被测脚本支持注入点（CURL_BIN / DOCKER_BIN），因此本验证不需要 docker / 网络 / 生产。
#
# 场景矩阵（断言覆盖「正常 + 每一条失败路径」，缺一条就有一类事故测不出来）：
#   1  正常回滚：健康校验通过          ⇒ exit 0 + marker 写入 + docker 调用序列正确
#   2  无 PREV_TAG（首个部署）          ⇒ exit 2（跳过）+ 不调用 compose up
#   3  PREV_TAG == IMAGE_TAG            ⇒ exit 2（跳过）+ 不调用 compose up
#   4  compose up 失败                  ⇒ exit 1 + 无 marker
#   5  回滚后健康仍失败                 ⇒ exit 1（重试满额）+ 无 marker
#   6  健康校验重试后才成功             ⇒ exit 0（重试有效）
#   7  未设 MARKER_FILE                 ⇒ exit 0 且不报错
#   8  回滚时 LNKPI_API_IMAGE 指向旧镜像 ⇒ compose 拿到的是回滚目标而非坏镜像
#   9  缺 IMAGE_TAG（契约违例）         ⇒ 非零退出 + 明确报错（不静默成功）
#   10 日志文件追加回滚记录             ⇒ 日志含回滚目标行
set +e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${REPO_ROOT}/deploy/rollback-api-image.sh"

if [[ ! -f "$TARGET" ]]; then
  echo "FAIL: 找不到被测脚本 ${TARGET}"
  exit 1
fi

WORK="$(mktemp -d)"
if [[ "${KEEP_WORK:-0}" == "1" ]]; then
  echo "WORK=${WORK}（保留现场，KEEP_WORK=1）"
else
  trap 'rm -rf "$WORK"' EXIT
fi

PASS=0
FAIL=0

pass() {
  PASS=$((PASS + 1))
  echo "PASS: $*"
}

fail() {
  FAIL=$((FAIL + 1))
  echo "FAIL: $*"
}

# ── 桩：docker / curl ────────────────────────────────────────────────────────
mkdir -p "$WORK/bin"
cat >"$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "docker $*" >>"$STUB_LOG"
echo "env:LNKPI_API_IMAGE=${LNKPI_API_IMAGE:-}" >>"$STUB_LOG"
if [[ "$1" == "image" && "$2" == "inspect" ]]; then
  # STUB_IMAGE_MISSING 支持空格分隔的多个「不存在的镜像名片段」（精确到具体镜像，
  # 不能一刀切——否则 prev_tag 的存在性校验也会被误判为缺失）。
  target="${3:-}"
  for miss in ${STUB_IMAGE_MISSING:-}; do
    if [[ -n "$miss" && "$target" == *"$miss"* ]]; then
      echo "stub: image not found: $target" >&2
      exit 1
    fi
  done
  exit 0
fi
if [[ "$1" == "compose" ]]; then
  if [[ "${STUB_COMPOSE_FAIL:-0}" == "1" ]]; then
    echo "stub: compose failed" >&2
    exit 1
  fi
  exit 0
fi
if [[ "$1" == "tag" ]]; then
  if [[ "${STUB_TAG_FAIL:-0}" == "1" ]]; then
    echo "stub: tag failed" >&2
    exit 1
  fi
  exit 0
fi
exit 0
STUB

cat >"$WORK/bin/curl" <<'STUB'
#!/usr/bin/env bash
echo "curl $*" >>"$STUB_LOG"
n=$(cat "$STUB_CURL_COUNT" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" >"$STUB_CURL_COUNT"
case "${STUB_HEALTH_MODE:-ok}" in
  fail) exit 22 ;;
  flaky)
    if [[ "$n" -lt "${STUB_HEALTH_FLAKY_UNTIL:-3}" ]]; then
      exit 22
    fi
    ;;
esac
exit 0
STUB
chmod +x "$WORK/bin/docker" "$WORK/bin/curl"

# run_case <case-name> <expected-exit> [KEY=VAL ...] -- 执行被测脚本
# 用法：run_case "名称" 0 STUB_HEALTH_MODE=ok PREV_TAG=good
run_case() {
  local name="$1"
  local expected="$2"
  shift 2
  CASE_DIR="$WORK/$(echo "$name" | tr -c 'a-zA-Z0-9' '_')"
  mkdir -p "$CASE_DIR"
  STUB_LOG="$CASE_DIR/stub.log"
  STUB_CURL_COUNT="$CASE_DIR/curl.count"
  : >"$STUB_LOG"
  : >"$STUB_CURL_COUNT"
  export STUB_LOG STUB_CURL_COUNT
  env IMAGE_TAG="${IMAGE_TAG:-newimg}" \
    PREV_TAG="${PREV_TAG:-}" \
    API_HEALTH_URL="http://127.0.0.1:5100/api/health" \
    COMPOSE_FILE="deploy/docker-compose.prod.yml" \
    LOG_FILE="${LOG_FILE:-}" \
    MARKER_FILE="${MARKER_FILE:-}" \
    LAST_GOOD_FILE="${LAST_GOOD_FILE:-}" \
    CURL_BIN="$WORK/bin/curl" \
    DOCKER_BIN="$WORK/bin/docker" \
    ROLLBACK_HEALTH_RETRIES="${ROLLBACK_HEALTH_RETRIES:-3}" \
    ROLLBACK_HEALTH_INTERVAL=0 \
    "$@" \
    bash "$TARGET" >"$CASE_DIR/out.log" 2>&1
  CASE_EXIT=$?
  CASE_DIR_DIR="$CASE_DIR"
  if [[ "$CASE_EXIT" == "$expected" ]]; then
    return 0
  fi
  echo "  (期望 exit ${expected}，实际 ${CASE_EXIT})"
  sed -n '1,12p' "$CASE_DIR/out.log"
  return 1
}

echo "=== 部署护栏离线验证（deploy/rollback-api-image.sh）==="

# ── 1 正常回滚 ───────────────────────────────────────────────────────────────
if run_case "case1_normal" 0 PREV_TAG=goodimg MARKER_FILE="$WORK/case1_normal_/marker"; then
  ok=1
  grep -q "up -d --no-build --force-recreate --remove-orphans api" "$CASE_DIR_DIR/stub.log" || ok=0
  grep -q "tag lnkpi-api:goodimg lnkpi-api:latest" "$CASE_DIR_DIR/stub.log" || ok=0
  [[ -f "$WORK/case1_normal_/marker" ]] && grep -q "rolled_back" "$WORK/case1_normal_/marker" || ok=0
  if [[ "$ok" == "1" ]]; then
    pass "1 正常回滚：exit 0 + compose up 参数正确 + latest 重打 + marker 写入"
  else
    fail "1 正常回滚：docker 调用序列或 marker 不符（见 $CASE_DIR_DIR/stub.log）"
  fi
else
  fail "1 正常回滚：退出码不符"
fi

# ── 2 无 PREV_TAG ───────────────────────────────────────────────────────────
if run_case "case2_no_prev" 2 PREV_TAG=""; then
  if grep -q "compose" "$CASE_DIR_DIR/stub.log"; then
    fail "2 无 PREV_TAG：不应调用 compose up"
  else
    pass "2 无 PREV_TAG：exit 2 跳过回滚，且未调用 compose up"
  fi
else
  fail "2 无 PREV_TAG：退出码不符"
fi

# ── 3 PREV_TAG == IMAGE_TAG ─────────────────────────────────────────────────
if run_case "case3_same" 2 PREV_TAG=sameimg IMAGE_TAG=sameimg; then
  if grep -q "compose" "$CASE_DIR_DIR/stub.log"; then
    fail "3 PREV_TAG==IMAGE_TAG：不应调用 compose up"
  else
    pass "3 PREV_TAG==IMAGE_TAG：exit 2 跳过回滚，且未调用 compose up"
  fi
else
  fail "3 PREV_TAG==IMAGE_TAG：退出码不符"
fi

# ── 4 compose up 失败 ────────────────────────────────────────────────────────
if run_case "case4_compose_fail" 1 PREV_TAG=goodimg STUB_COMPOSE_FAIL=1 MARKER_FILE="$WORK/case4_compose_fail_/marker"; then
  if [[ -f "$WORK/case4_compose_fail_/marker" ]]; then
    fail "4 compose 失败：不应写 marker"
  else
    pass "4 compose up 失败：exit 1 + 无 marker"
  fi
else
  fail "4 compose up 失败：退出码不符"
fi

# ── 5 回滚后健康仍失败 ───────────────────────────────────────────────────────
if run_case "case5_health_fail" 1 PREV_TAG=goodimg STUB_HEALTH_MODE=fail MARKER_FILE="$WORK/case5_health_fail_/marker"; then
  tries=$(wc -l <"$CASE_DIR_DIR/stub.log" >/dev/null 2>&1; grep -c "^curl " "$CASE_DIR_DIR/stub.log")
  if [[ -f "$WORK/case5_health_fail_/marker" ]]; then
    fail "5 健康仍失败：不应写 marker"
  elif [[ "$tries" -lt 3 ]]; then
    fail "5 健康仍失败：重试次数不足（实际 ${tries}）"
  else
    pass "5 回滚后健康仍失败：exit 1 + 重试满额（${tries} 次）+ 无 marker"
  fi
else
  fail "5 回滚后健康仍失败：退出码不符"
fi

# ── 6 重试后才成功 ───────────────────────────────────────────────────────────
if run_case "case6_flaky" 0 PREV_TAG=goodimg STUB_HEALTH_MODE=flaky STUB_HEALTH_FLAKY_UNTIL=3; then
  tries=$(grep -c "^curl " "$CASE_DIR_DIR/stub.log")
  if [[ "$tries" -ge 3 ]]; then
    pass "6 健康校验重试后才成功：exit 0 且重试生效（${tries} 次）"
  else
    fail "6 健康校验重试后才成功：重试未生效（实际 ${tries} 次）"
  fi
else
  fail "6 健康校验重试后才成功：退出码不符"
fi

# ── 7 未设 MARKER_FILE ───────────────────────────────────────────────────────
if run_case "case7_no_marker" 0 PREV_TAG=goodimg MARKER_FILE=""; then
  pass "7 未设 MARKER_FILE：exit 0 且不报错"
else
  fail "7 未设 MARKER_FILE：退出码不符"
fi

# ── 8 LNKPI_API_IMAGE 指向回滚目标 ───────────────────────────────────────────
if run_case "case8_env" 0 PREV_TAG=goodimg; then
  if grep -q "env:LNKPI_API_IMAGE=lnkpi-api:goodimg" "$CASE_DIR_DIR/stub.log"; then
    pass "8 回滚时 LNKPI_API_IMAGE 指向旧镜像（compose 不会拉起坏镜像）"
  else
    fail "8 LNKPI_API_IMAGE 未指向回滚目标（见 $CASE_DIR_DIR/stub.log）"
  fi
else
  fail "8 LNKPI_API_IMAGE：退出码不符"
fi

# ── 9 缺 IMAGE_TAG（契约违例）───────────────────────────────────────────────
CASE_DIR="$WORK/case9_missing_tag"
mkdir -p "$CASE_DIR"
env -u IMAGE_TAG CURL_BIN="$WORK/bin/curl" DOCKER_BIN="$WORK/bin/docker" bash "$TARGET" >"$CASE_DIR/out.log" 2>&1
ec=$?
if [[ "$ec" != "0" ]] && grep -qi "IMAGE_TAG" "$CASE_DIR/out.log"; then
  pass "9 缺 IMAGE_TAG：非零退出 + 明确报错（exit=${ec}）"
else
  fail "9 缺 IMAGE_TAG：契约违例未被拒（exit=${ec}）"
fi

# ── 10 日志文件追加回滚记录 ──────────────────────────────────────────────────
CASE_DIR="$WORK/case10_log"
mkdir -p "$CASE_DIR"
LOG_TARGET="$CASE_DIR/deploy.log"
STUB_LOG="$CASE_DIR/stub.log"
STUB_CURL_COUNT="$CASE_DIR/curl.count"
: >"$STUB_LOG"
: >"$STUB_CURL_COUNT"
export STUB_LOG STUB_CURL_COUNT
env IMAGE_TAG=newimg PREV_TAG=goodimg LOG_FILE="$LOG_TARGET" \
  CURL_BIN="$WORK/bin/curl" DOCKER_BIN="$WORK/bin/docker" \
  ROLLBACK_HEALTH_RETRIES=1 ROLLBACK_HEALTH_INTERVAL=0 \
  bash "$TARGET" >"$CASE_DIR/out.log" 2>&1
ec=$?
if [[ "$ec" == "0" ]] && grep -q "lnkpi-api:goodimg" "$LOG_TARGET" 2>/dev/null; then
  pass "10 日志文件记录回滚目标（便于事后取证）"
else
  fail "10 日志文件未记录回滚目标（exit=${ec}）"
fi

# ── 12 last-good 优先：锚定「上次成功部署的镜像」，而不是时间最近的镜像 ─────────
CASE_DIR="$WORK/case12_last_good"
mkdir -p "$CASE_DIR"
printf 'goodimg\n' >"$CASE_DIR/last-good"
STUB_LOG="$CASE_DIR/stub.log"
STUB_CURL_COUNT="$CASE_DIR/curl.count"
: >"$STUB_LOG"
: >"$STUB_CURL_COUNT"
export STUB_LOG STUB_CURL_COUNT
env IMAGE_TAG=newimg PREV_TAG=badimg LAST_GOOD_FILE="$CASE_DIR/last-good" \
  CURL_BIN="$WORK/bin/curl" DOCKER_BIN="$WORK/bin/docker" \
  ROLLBACK_HEALTH_RETRIES=1 ROLLBACK_HEALTH_INTERVAL=0 \
  bash "$TARGET" >"$CASE_DIR/out.log" 2>&1
ec=$?
if [[ "$ec" == "0" ]] && grep -q "env:LNKPI_API_IMAGE=lnkpi-api:goodimg" "$STUB_LOG" && ! grep -q "lnkpi-api:badimg" "$STUB_LOG"; then
  pass "12 last-good 优先：回滚锚定上次成功镜像（goodimg），忽略时间更新的坏镜像（badimg）"
else
  fail "12 last-good 优先：回滚目标选错（exit=${ec}，见 $STUB_LOG）"
fi

# ── 13 last-good == IMAGE_TAG（就是本次）⇒ 忽略，回退 prev_tag ────────────────
CASE_DIR="$WORK/case13_self"
mkdir -p "$CASE_DIR"
printf 'newimg\n' >"$CASE_DIR/last-good"
STUB_LOG="$CASE_DIR/stub.log"
STUB_CURL_COUNT="$CASE_DIR/curl.count"
: >"$STUB_LOG"
: >"$STUB_CURL_COUNT"
export STUB_LOG STUB_CURL_COUNT
env IMAGE_TAG=newimg PREV_TAG=goodimg LAST_GOOD_FILE="$CASE_DIR/last-good" \
  CURL_BIN="$WORK/bin/curl" DOCKER_BIN="$WORK/bin/docker" \
  ROLLBACK_HEALTH_RETRIES=1 ROLLBACK_HEALTH_INTERVAL=0 \
  bash "$TARGET" >"$CASE_DIR/out.log" 2>&1
ec=$?
if [[ "$ec" == "0" ]] && grep -q "env:LNKPI_API_IMAGE=lnkpi-api:goodimg" "$STUB_LOG"; then
  pass "13 last-good 指向本次镜像：被忽略并回退 prev_tag（goodimg）"
else
  fail "13 last-good 指向本次镜像：未正确回退（exit=${ec}，见 $STUB_LOG）"
fi

# ── 14 last-good 指向的镜像已不存在 ⇒ 回退 prev_tag ─────────────────────────
CASE_DIR="$WORK/case14_missing"
mkdir -p "$CASE_DIR"
printf 'ghostimg\n' >"$CASE_DIR/last-good"
STUB_LOG="$CASE_DIR/stub.log"
STUB_CURL_COUNT="$CASE_DIR/curl.count"
: >"$STUB_LOG"
: >"$STUB_CURL_COUNT"
export STUB_LOG STUB_CURL_COUNT
env IMAGE_TAG=newimg PREV_TAG=goodimg LAST_GOOD_FILE="$CASE_DIR/last-good" STUB_IMAGE_MISSING=ghostimg \
  CURL_BIN="$WORK/bin/curl" DOCKER_BIN="$WORK/bin/docker" \
  ROLLBACK_HEALTH_RETRIES=1 ROLLBACK_HEALTH_INTERVAL=0 \
  bash "$TARGET" >"$CASE_DIR/out.log" 2>&1
ec=$?
if [[ "$ec" == "0" ]] && grep -q "env:LNKPI_API_IMAGE=lnkpi-api:goodimg" "$STUB_LOG"; then
  pass "14 last-good 镜像已不存在：回退 prev_tag（goodimg）"
else
  fail "14 last-good 镜像已不存在：未回退（exit=${ec}，见 $STUB_LOG）"
fi

# ── 15 两个候选都不可用 ⇒ 跳过（exit 2），不盲目回滚 ─────────────────────────
CASE_DIR="$WORK/case15_none"
mkdir -p "$CASE_DIR"
printf 'ghostimg\n' >"$CASE_DIR/last-good"
STUB_LOG="$CASE_DIR/stub.log"
STUB_CURL_COUNT="$CASE_DIR/curl.count"
: >"$STUB_LOG"
: >"$STUB_CURL_COUNT"
export STUB_LOG STUB_CURL_COUNT
env IMAGE_TAG=newimg PREV_TAG=ghostimg LAST_GOOD_FILE="$CASE_DIR/last-good" STUB_IMAGE_MISSING=ghostimg \
  CURL_BIN="$WORK/bin/curl" DOCKER_BIN="$WORK/bin/docker" \
  ROLLBACK_HEALTH_RETRIES=1 ROLLBACK_HEALTH_INTERVAL=0 \
  bash "$TARGET" >"$CASE_DIR/out.log" 2>&1
ec=$?
if [[ "$ec" == "2" ]] && ! grep -q "^docker compose" "$STUB_LOG"; then
  pass "15 无可用回滚目标：exit 2 跳过且未盲目 compose up"
else
  fail "15 无可用回滚目标：应跳过（exit=${ec}，见 $STUB_LOG）"
fi

# ── 11 接线断言：deploy-remote-build.sh 必须真的调用回滚原语 ──────────────────
# （护栏最怕「原语写得对、但没接上」——这里做静态接线断言，防回归时被摘掉）
DRB="${REPO_ROOT}/deploy/deploy-remote-build.sh"
if [[ -f "$DRB" ]] && grep -q "rollback-api-image.sh" "$DRB" && grep -q "ROLLBACK_MARKER" "$DRB" && grep -q "last-good-api-image" "$DRB"; then
  pass "11 接线：deploy-remote-build.sh 调用回滚原语并留 marker"
else
  fail "11 接线：deploy-remote-build.sh 未调用 rollback-api-image.sh（护栏形同虚设）"
fi

echo ""
echo "=== 结果：通过 ${PASS} / 失败 ${FAIL} ==="
[[ "$FAIL" == "0" ]] || exit 1
exit 0
