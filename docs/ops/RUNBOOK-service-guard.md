# RUNBOOK：lnkpi 服务自愈巡检（service-guard）

> 2026-10-15 抠图 502 事故后加装。脚本：`deploy/service-guard.sh`，
> 生产安装路径 `/usr/local/sbin/lnkpi-service-guard.sh`，cron 每分钟执行一次。

## 为什么需要它（事故复盘要点）

2026-10-15 04:48 那次 `systemctl restart docker`，systemd 等 `stop-sigterm` 超时后
**SIGKILL 了 dockerd**（journalctl：`State 'stop-sigterm' timed out. Killing.`）。
后果：容器状态没被干净持久化 ⇒ dockerd 起来后只自动拉起了 `lnkpi-segment`，
**`lnkpi-matting` 一直 `Exited(0)`，`RestartCount=0`**（policy 同为 `unless-stopped`），
抠图接口静默不可用 11.5 小时，直到用户从前端网络面板发现 502。

两条结论：

1. **restart policy 不可作为业务可用性的依托**。它是 daemon 内部状态机，daemon 自己被强杀时不可信；
   而且容器一旦不存在，policy 什么都不做。
2. **容器消失 = 完全静默故障**。healthcheck 只对活容器生效；api 侧 fetch 到不存在的服务名
   只是一次 DNS 失败 → `BadGatewayException` → 前端 502，服务端日志无痕。

⇒ 期望状态必须**外置**，由外部 reconcile 循环持续对齐（k8s 控制器同思路，单机用 cron 实现）。

## 职责与红线

检查白名单服务（`api` / `matting` / `segment`）对应容器 `lnkpi-<svc>` 是否存在且 running：

| 观测到 | 动作 |
|---|---|
| 容器不存在 / `exited` / `dead` | `docker compose up -d --no-build <svc>` |
| running 且连续 3 个周期 `unhealthy` | `docker compose restart <svc>`（`starting` 不计，防模型加载抖动误伤） |
| running 且 healthy | 不动 |
| `restarting` / `created` / `paused` | 不动（中间态，避免与 docker 自身动作打架） |

红线（改动脚本时别顺手优化掉）：

1. 只 touch lnkpi 白名单服务 —— 机器上还有 `pintuotuo-*` 等其他项目容器，不碰。
2. 必须 `--no-build` —— guard 绝不触发镜像构建（走网络、可能失败且耗时数分钟）。
3. 不删镜像 / 卷 / 网络 —— 那是 `disk-guard.sh` 的职责。
4. 健康服务绝不重启 —— 会中断进行中的请求。
5. 只做「拉起」，不做回滚 / 切版本 —— 镜像选择权归部署流程（`IMAGE_TAG`）。

## 安装 / 验证

```sh
install -m 0755 deploy/service-guard.sh /usr/local/sbin/lnkpi-service-guard.sh
mkdir -p /var/lib/lnkpi-guard
# crontab（注意：外层不要再套 flock，原因见下）
* * * * * /usr/local/sbin/lnkpi-service-guard.sh >/dev/null 2>&1
```

### 部署门禁（P1，随本脚本同仓库交付）

`deploy-remote.sh` / `deploy-remote-build.sh` / `cvm-recover.sh` 在 api 健康检查通过后：

1. 先跑一次 reconcile（顺手补齐缺失的 matting/segment）
2. 再 `--verify` 断言三服务齐全，结果进部署日志

⚠️ verify 失败**故意不阻断部署**：部署主目标是 api 新版本，guard cron 每分钟还会继续
reconcile；若哪天要收紧成硬门禁，把三个脚本里的 WARN 分支改成 `exit 1` 即可。

### 黑盒合成探针（P2）

health 只探 `/health`，探不到「容器在但推理坏」（模型加载失败 / onnxruntime 崩 /
内存不足推理超时都表现为 health 200 + 业务 5xx）。探针是唯一贴合用户视角的检测：

```sh
install -m 0755 deploy/matting-probe.sh /usr/local/sbin/lnkpi-matting-probe.sh
# crontab
*/10 * * * * /usr/local/sbin/lnkpi-matting-probe.sh >/dev/null 2>&1
```

行为：每 10 分钟用**内嵌的 32x32 渐变 PNG**（本机 python 手写生成，不含任何用户数据）
直连 matting 内网 IP 真打一次推理，校验 200 + PNG magic；连续 2 轮失败才告警（防瞬时抖动）；
结果写 textfile 指标 `lnkpi_matting_probe_ok`。失败不自动 restart —— 拉起重启是 guard 的
职责，探针只负责「说真话」，两者职责分离才能区分「推理坏了」和「入口坏了」。

### 告警通道（P3）

guard 与探针统一走 `notify_alert`：写 alert 文件 + 可选 webhook。配置（cron 环境不读
`/opt/lnkpi/.env`，用独立文件）：

```sh
echo 'LNKPI_ALERT_WEBHOOK=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx' \
  > /usr/local/etc/lnkpi-alert.env
chmod 600 /usr/local/etc/lnkpi-alert.env
```

未配置 ⇒ 只落文件、不报错（探活告警不能反过来制造新故障）。推送格式为企微机器人
markdown；换其他 webhook 只需改 `notify_alert` 里的 payload。

```sh
/usr/local/sbin/lnkpi-service-guard.sh --dry-run   # 打印将做的动作，不执行
/usr/local/sbin/lnkpi-service-guard.sh --verify    # 只断言不修复；有服务缺失 ⇒ exit 1
tail -f /var/log/lnkpi-service-guard.log           # 巡检日志（自限 2MB）
cat /var/log/lnkpi-service-guard.alert             # 最近一次需人看的事件
```

⚠️ **cron 外层不要套 `flock`**：`flock -xn <file> -c cmd` 的锁 fd 会被子进程继承，
脚本内部的 `flock -xn 9` 对同一文件**永远拿不到锁**，于是每轮都 `SKIP` 空转
（2026-10-15 17:18 实测，两轮全 SKIP，守护形同虚设）。锁由脚本自己管。

## 演练记录（2026-10-15）

`docker stop lnkpi-matting` ⇒ 21 秒后自动拉起并转 healthy
（日志 `RECOVER OK` + alert 文件写入 `recovered matting (was exited)`）。
本次事故实测对比：MTTD 11.5h → ≤60s，MTTR 1min（人工）→ 21s（自动）。

## 未覆盖（后续要补的）

- **告警通道默认未接 webhook**：机制已就绪（`/usr/local/etc/lnkpi-alert.env` 填
  `LNKPI_ALERT_WEBHOOK` 即生效），目前 alert 只落文件。
- **pi-runtime 在 k3s**，不在 compose 白名单内，本脚本不管。
- **lnkpi 自己的 Prometheus/Alertmanager 未在生产启用**（跑着的是 pintuotuo 的栈）。
  脚本若发现 node_exporter textfile 目录（`/var/lib/node_exporter/textfile_collector`）
  会写 `lnkpi_service_up{service=...}` 与 `lnkpi_matting_probe_ok`，接 prometheus 后可直接配告警规则。
- **仅探 matting**：segment 的 `/segment` 推理探针可照抄 matting-probe 加一条 cron（未做，
  segment 崩溃会被 guard 的 healthy 巡检兜住，但没有推理级检测）。
