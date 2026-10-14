# 侧栏参考图绑定指标 — 告警查询草稿（待校准）

本批（PR-D / RB-D9）随 `feat/sidebar-ref-bind-prd` 新增三个指标，语义见父规格 RB-D9：

- `pi_runtime_sidebar_ref_bind_total{outcome}` —— 侧栏参考图绑定/解绑结算计数，按 `outcome`（`ok` / `upstream_error` / …）区分结果。
- `pi_runtime_propose_missing_refs_total` —— 提议（propose）阶段因缺失参考图引用被拦截的计数（门禁）。
- `nest_zod_reject_total{endpoint}` —— Nest 侧 Zod 校验拒绝计数，按 `endpoint` 区分入口；其中 `apply-sidebar-attachments` 即侧栏附件门禁入口。

**本文件仅为草稿，不告警。** 它不进 Prometheus 抓取（非 `.yml`），仅作为后续落成 `rules/*.yml` 前的查询与阈值方向记录。

## 纪律：不创建 firing 规则

依据 `deploy/observability/prometheus/rules/README.md` 的**静默降级纪律**：`rules/` 目录刻意留空，需本栈稳定运行 **≥1 个发布周期的真实流量** 才能校准 spec §7.2 的初值阈值——否则「无错误」只是「无流量」的假象（pod 重启会使 counter 归零，采样窗口内分母可能为零）。

因此，本文件**不创建任何 firing 规则**，三个 PromQL 仅作草稿。待真实基线建立后，再按下方「窗口校正原则」落成 `rules/*.yml`。

## PromQL 草稿（待校准）

门禁拦截率：

```promql
sum(rate(pi_runtime_propose_missing_refs_total[1h])) / sum(rate(pi_runtime_sidebar_ref_bind_total{outcome="ok"}[1h]))
```

Zod 拒绝残留（门禁上线后理论上应趋零，若 > 0 说明模型仍在伪造）：

```promql
sum(rate(nest_zod_reject_total{endpoint="apply-sidebar-attachments"}[1h]))
```

上游错误突增：

```promql
sum(rate(pi_runtime_sidebar_ref_bind_total{outcome="upstream_error"}[1h]))
```

## 窗口校正原则

复用 `rules/README.md` 的三条窗口校正原则（用于未来落成 `rules/*.yml` 时校准阈值）：

1. **带 `or vector(0)`**：指标族为空时 `rate`/`increase` 返回空向量而非 0，「稳定为 0」与「查不到」无法区分；必须 `or vector(0)` 才能让「零错误」与「无数据」可被区分。
2. **窗口 < 典型重启间隔**：`rate`/`increase` 跨 pod 重启（counter 归零）时取值不可信，采样窗口必须短于典型重启间隔，避免跨重启污染基线。
3. **先确认分母非零**：在判「错误为 0」之前，必须先确认同一窗口内的分母（事件总数）非零；否则「错误为 0」只是「没有事件」的另一种写法。

> 以上三条针对未来落地的 firing 规则。下面的「建议初值阈值方向」**不是最终阈值**，仅用于指导校准，最终数值一律按真实基线定。

### 各草稿的建议初值阈值方向（非最终）

- **门禁拦截率**：`propose_missing_refs / bind{outcome="ok"}` 的比值，反映门禁对缺失引用的拦截占比。初值方向：先观察真实区间，确认分母 `bind{outcome="ok"}` 非零后再定上界；突发异常升高（如远超历史基线）才值得调查。最终阈值按真实基线定。
- **Zod 拒绝残留**：门禁上线后理论上应趋零。初值方向：可设 `> 0 即调查`，但最终阈值按真实基线定——零星拒绝未必是异常（边界输入），需结合流量规模判断。
- **上游错误突增**：`bind{outcome="upstream_error"}` 的速率。初值方向：以真实基线的「典型水平」为锚，突增（如数倍于基线）才告警；静默期（分母非零窗口）稳定为 0 是健康信号。最终阈值按真实基线定。

> 重申：以上均为**方向性建议，不是最终阈值**。在 `rules/README.md` 要求的 ≥1 发布周期真实流量校准完成前，本文件不产生任何告警。
