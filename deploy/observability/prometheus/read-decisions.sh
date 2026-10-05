#!/usr/bin/env bash
# pi-runtime 指标读数**判据自检**（一次性把「能不能下结论」的判据跑出来）
#
# 为什么需要这个脚本：pi-runtime 的指标族是**按需渲染**的（counter 型 Map 为空时
# 不渲染数据行，见 metrics.ts 注释），而 Prometheus 会**整族丢弃**没有任何样本行的族
# ⇒ 查不到 ≠ 采集断，也 ≠ 出错了。这个脚本把三件事一次说清：
#
#   1. 采集层是否真的活着（up）—— 这是「族空」与「采集断」的唯一分界。
#   2. 数据从什么时候开始（query_range 的**实际首样本**，不是 retention 配置值）。
#   3. 本次查询窗口里到底有没有流量/事件（sessions_active 是瞬时 gauge，恒为 0 不代表
#      「零调用」—— 见下方「窗口」段的判定规则）。
#
# 用法（必须在能访问 Prometheus 的一侧执行；NodePort 30909 默认只在本机/内网可达）：
#   bash deploy/observability/prometheus/read-decisions.sh [PROM_URL]
#   PROM_URL 省略时默认 http://127.0.0.1:30909
#   也支持环境变量 PROMETHEUS_URL（容器内/跳板机场景）。
#
# 退出码恒为 0：本脚本**只做诊断、不做断言**，任何「红」都要人判断上下文，
# 不要在 CI 里把它当门禁（误报会让「零流量」被当成故障，或反过来）。

set -uo pipefail

PROM="${1:-${PROMETHEUS_URL:-http://127.0.0.1:30909}}"

if [ -t 1 ]; then C_OK=$'\033[32m'; C_BAD=$'\033[31m'; C_WARN=$'\033[33m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else C_OK=""; C_BAD=""; C_WARN=""; C_DIM=""; C_OFF=""; fi

say() { printf '%s\n' "$*"; }
hr() { say "${C_DIM}------------------------------------------------------------${C_OFF}"; }

# q <promql> —— 打即时查询，返回首条样本的值（无数据时打印「无数据」并返回空）。
q() {
  curl -sS --max-time 15 --get --data-urlencode "query=$1" "${PROM}/api/v1/query" 2>/dev/null \
    | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: print("查询失败（Prometheus 不可达或返回非 JSON）"); sys.exit(0)
if d.get("status")!="success": print("查询错误:", d.get("error","?")); sys.exit(0)
r=d["data"]["result"]
print(r[0]["value"][1] if r else "无数据")
'
}

# qrange_first <promql> <start> <end> <step> —— 返回 query_range 的**实际首样本** UTC 时间。
# ⚠️ 只能这么判数据起点：`headStats.minTime` 实测偏 14 分钟；`timestamp(min_over_time(x[7d]))`
# 返回的是求值时刻不是最老样本。配置里的 retention.time 与真实覆盖范围无关。
qrange_first() {
  curl -sS --max-time 20 --get \
    --data-urlencode "query=$1" --data-urlencode "start=$2" --data-urlencode "end=$3" \
    --data-urlencode "step=$4" "${PROM}/api/v1/query_range" 2>/dev/null \
    | python3 -c '
import json,sys,datetime
try: d=json.load(sys.stdin)
except Exception: print("查询失败"); sys.exit(0)
r=d["data"]["result"]
vs=r[0]["values"] if r else []
if not vs: print("无数据"); sys.exit(0)
print(datetime.datetime.utcfromtimestamp(vs[0][0]).strftime("%Y-%m-%dT%H:%M:%SZ"))
'
}

# counter_recent —— 判「有没有发生过重启」：counter 只会单调增，**回落即重启**。
# 比翻 helm history 直接（实测 uptime 不符线性时也能用）。
counter_recent() {
  local expr="$1"
  local now last1h
  now=$(date -u +%s); last1h=$((now - 3600))
  curl -sS --max-time 20 --get \
    --data-urlencode "query=$expr" --data-urlencode "start=${last1h}" --data-urlencode "end=${now}" \
    --data-urlencode "step=60" "${PROM}/api/v1/query_range" 2>/dev/null \
    | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: print("查询失败"); sys.exit(0)
r=d["data"]["result"]
if not r: print("无数据（该族窗口内无样本）"); sys.exit(0)
drop=0
for s in r:
    vals=[float(v) for _,v in s["values"]]
    for a,b in zip(vals, vals[1:]):
        if b < a: drop += 1
print("检测到回落=重启 %d 次" % drop if drop else "无回落（近 1h 无重启）")
'
}

hr
say "指标读数判据自检 → ${PROM}"
hr

say ""
say "【1】采集层是否活着"
UP=$(q 'up{job="pi-runtime"}')
say "  up{job=\"pi-runtime\"} = ${UP}"
case "$UP" in
  1) say "  ${C_OK}采集正常${C_OFF} ⇒ 下面查不到的族都应读作「真的没有事件」，不是采集断。" ;;
  0) say "  ${C_BAD}抓取失败${C_OFF} ⇒ 任何指标结论都无效，先修采集。" ;;
  *) say "  ${C_BAD}${UP}${C_OFF} ⇒ 无法判定采集状态（Prometheus 本身可能不可达）。" ;;
esac

say ""
say "【2】数据起点（实际首样本，不是 retention 配置值）"
START=$(qrange_first 'pi_runtime_uptime_seconds' "$(date -u -v-8d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '8 days ago' +%Y-%m-%dT%H:%M:%SZ)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "1h")
say "  uptime 首样本 = ${START}"
say "  ${C_DIM}⇒ 只在 [${START}, now] 区间内的结论成立；跨这个区间的 increase()/rate() 需先确认数据起点。${C_OFF}"

say ""
say "【3】近 1h 是否发生过重启（counter 回落即重启）"
say "  tool_calls_total: $(counter_recent 'sum(pi_runtime_tool_calls_total)')"
say "  ${C_DIM}⇒ 若检测到重启，窗口内的 counter 归零属于预期；跨重启的 rate() 会被低估。${C_OFF}"

say ""
say "【4】本窗口的流量与事件（区分「零流量」与「有流量但零错误」）"
SAS=$(q 'max_over_time(pi_runtime_sessions_active[1h])')
say "  近 1h 活跃会话峰值 = ${SAS}"
CALLS=$(q 'sum(increase(pi_runtime_tool_calls_total[1h])) or vector(0)')
say "  近 1h 工具调用增量 = ${CALLS}"
ERRS=$(q 'sum(increase(pi_runtime_tool_calls_total{result="error"}[1h])) or vector(0)')
say "  近 1h 工具错误增量 = ${ERRS}"
say ""
# ⚠️ 判据必须挂在**分母**（工具调用增量）上，不能挂会话数：
# 实测踩过「会话峰值=2 但工具调用增量=0」⇒ 错误增量 0 依然只是「没有事件」的另一种写法。
# 会话数只说明有人在用，不能说明工具被调过。
CALLS_NUM=$(printf '%s' "$CALLS" | tr -cd '0-9.')
if [ -z "$CALLS_NUM" ] || [ "$CALLS_NUM" = "0" ] || [ "$CALLS_NUM" = "0.0" ]; then
  say "  ${C_WARN}注意${C_OFF} 窗口内工具调用增量为 0 ⇒「错误为 0」在这段窗口里**不构成修复证据**，"
  say "  它只是「没有事件」的另一种写法。判定修复必须等一个**分母非零**的窗口。"
  say "  ${C_DIM}（会话峰值 ${SAS} 只说明有人在用，不说明工具被调过——本脚本第一版就误挂在这里。）${C_OFF}"
else
  say "  工具调用增量为 ${CALLS_NUM}（分母非零）⇒ 上面的错误增量 ${ERRS} 可作为错误率判据。"
fi

say ""
say "【5】按需渲染的族：查不到时的正确读法"
say "  ${C_DIM}counter 型 Map 为空时不渲染数据行（metrics.ts 的刻意约定，为了区分"
say "  「从未触发」与「触发过但 0」），而 Prometheus 会整族丢弃没有样本行的族。${C_OFF}"
say "  ${C_DIM}⇒ 查不到某族时，**不要**改 producer 去补 0 值样本：那会把「从未触发」"
say "  与「触发过但 0」抹成同一个 0，反而丢掉了这条判读能力（也已有测试锁定）。${C_OFF}"
say "  ${C_DIM}   需要「空即 0」时在查询侧加 or vector(0)（已验证可用）。${C_OFF}"

hr
say "约束声明：本脚本只做诊断。判断「是否故障」需要人带上业务上下文（谁在用、"
say "有没有发布、窗口里有没有流量），任何把它当门禁的用法都会产生误报。"
hr

# ---------------------------------------------------------------------------
# 回看**历史**窗口（复现一次判读）—— 两种写法都会让 Prometheus 直接报解析错误：
#
#   ✗ sum(increase(x[<绝对时间戳>]))          range 必须是**时长**，不是时刻
#   ✗ sum(increase(x[1h] @ 2026-10-05T07:15Z)) @ 后面必须是 **Unix 秒**，不是 RFC3339
#
# 正确写法（两步）：
#   ts=$(date -u -d "2026-10-05 07:15:00" +%s)   # macOS: date -j -u -f "%Y-%m-%d %H:%M:%S" ...
#   curl -G --data-urlencode "query=sum(increase(pi_runtime_tool_calls_total[1h] @ $ts)) or vector(0)" \
#        "${PROM}/api/v1/query"
# ---------------------------------------------------------------------------
if [ "${SHOW_HISTORY:-0}" = "1" ]; then
  say ""
  say "【6】回看历史窗口（SHOW_HISTORY=1）"
  TS="${HISTORY_TS:-}"
  if [ -z "$TS" ]; then
    say "  用法：HISTORY_TS=\$(date -u -d '2026-10-05 07:15:00' +%s) SHOW_HISTORY=1 bash $0"
  else
    say "  锚点 ts=${TS}"
    say "  分母（工具调用增量）= $(q "sum(increase(pi_runtime_tool_calls_total[1h] @ ${TS})) or vector(0)")"
    say "  分子（错误增量）    = $(q "sum(increase(pi_runtime_tool_calls_total{result=\"error\"}[1h] @ ${TS})) or vector(0)")"
  fi
  hr
fi
