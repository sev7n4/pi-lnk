# 支付宝沙箱（模拟账户）测试验证指南 · 风险 #2 第一阶段

> 配套实现：PR `feat/payment-alipay-sandbox`（`Order`/`Payment` 模型 + `PaymentAdapter` + `AlipayAdapter` + `PaymentService` + `upgrade` 订单校验）。
> **沙箱与生产同代码**：仅 `ALIPAY_*` 环境变量（网关/凭证）不同。沙箱验证通过 = 支付链路逻辑已验证，生产切换只换配置 + 过审。

---

## 0. 本阶段目标（Definition of Done）

在沙箱环境跑通完整闭环且**零资损风险敞口**：

- [ ] 登录用户 `POST /api/payment/order` → 获得 `payUrl`（Order=PENDING）
- [ ] 浏览器跳转沙箱收银台 → 沙箱买家账号登录付款
- [ ] 支付宝 `notify_url` 回调到达服务端 → **验签通过** → Order=PAID → 积分到账（pool=`purchased`）
- [ ] 主动查单补偿路径生效（`GET /api/payment/order/:id`，PENDING 时自动查渠道）
- [ ] 幂等验证：重复回调 / 查单后回调 / upgrade 兜底均**不重复发分**
- [ ] 负路径：伪造回调（验签失败）、金额不符回调均**拒绝且零入账**

---

## 1. 获取沙箱凭证（需用户在支付宝开放平台操作）

前置：一个支付宝账号（个人/企业均可，沙箱不要求商业资质）。

1. 登录 [支付宝开放平台](https://open.alipay.com/) → 进入 **沙箱控制台**（开发者中心 → 沙箱）。
2. 选择/创建应用，记录：
   - **APPID**（沙箱版，形如 `2021000xxxxxxxxx`）
   - **应用私钥**（「查看」可复制；RSA2，2048 位。也可用官方密钥工具本地生成后上传应用公钥换取）
   - **支付宝公钥**（注意：不是「应用公钥」。上传应用公钥后平台返回的才是支付宝公钥）
3. 记录 **沙箱买家账号**（买家信息：账号 + 登录密码 + 支付密码，用于沙箱收银台登录付款）。
4. 电脑网站支付（`alipay.trade.page.pay`）在沙箱默认可用，无需额外开通产品。

> ⚠️ 密钥只进服务端 `.env`，严禁进仓库/前端/日志（资损红线）。

## 2. 配置（生产 CVM 的 `/opt/lnkpi/deploy/.env`）

```bash
# —— 支付宝沙箱（风险 #2 第一阶段）——
ALIPAY_APP_ID=2021000xxxxxxxxx
ALIPAY_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEv...（应用私钥全文，\n 为字面换行）\n-----END PRIVATE KEY-----"
ALIPAY_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\nMIIBI...（支付宝公钥全文）\n-----END PUBLIC KEY-----"
ALIPAY_GATEWAY=https://openapi.alipaydev.com/gateway.do
ALIPAY_NOTIFY_URL=http://119.29.173.89:5100/api/payment/callback/alipay
ALIPAY_RETURN_URL=https://<前端域名>/pay/return
```

要点：
- **notify_url 必须公网可达**：CVM `119.29.173.89:5100` 已实测公网 200（见 §5）。
- **return_url 指向前端**（Vercel 域名），用户付款后浏览器落点；前端落地后调 `GET /api/payment/order/:id` 确认到账。
- 未配置时支付端点返回「支付渠道未配置」，**不阻塞服务启动、不静默假成功**（显式失败设计）。
- 容器访问 `alipaydev.com`（国内域名）若走代理会慢/失败 ⇒ 确认容器 `NO_PROXY` 豁免 `alipaydev.com,.alipaydev.com`（与既有 `.bigmodel.cn` 豁免同思路），改后 `compose up -d --no-build api` + `docker exec lnkpi-api env | grep -i no_proxy` 验证。

## 3. 部署生效

推送含支付模块的 master → deploy.yml 自动构建 → entrypoint 自动 `prisma migrate deploy`（建 Order/Payment 表）→ 容器重启后读新 `.env`。

## 4. 联调步骤（按序执行）

| # | 操作 | 预期 |
|---|---|---|
| 1 | 登录态 `POST /api/payment/order` `{plan:'pro'}` | `{orderId, payUrl, amountFen:9900}`；DB Order=PENDING |
| 2 | 浏览器开 `payUrl` | 跳转沙箱收银台；URL 含 `app_id/method=alipay.trade.page.pay/sign/biz_content` |
| 3 | 沙箱买家账号登录 → 确认付款 | 收银台显示「支付成功」；浏览器跳 `return_url` |
| 4 | （服务端）支付宝 notify 到达 | 日志 `订单入账成功: order=... plan=pro amount=9900`；Order=PAID；用户 `points+5000`、`membership=pro`、流水 `pool=purchased, orderId` |
| 5 | `GET /api/payment/order/:id` | `status=PAID` |
| 6 | 重放步骤 4 的同一回调（curl 重发原始报文） | 仍 `success`，**积分不重复**（CAS 幂等） |
| 7 | 伪造回调（改 `total_amount` 或去掉 `sign`） | `fail`，零入账 |
| 8 | 未付款时调 `POST /api/membership/upgrade` `{plan,orderId}` | 拒绝「支付订单未完成」 |
| 9 | 已入账后调 `POST /api/membership/upgrade`（兜底路径） | 成功且**不重复发分**（幂等返回当前余额） |
| 10 | `GET /api/membership/points-breakdown` | `purchased.available` = 5000 |

## 5. 已验证事实（2026-10-17 实测）

- `http://119.29.173.89:5100/api/health` 公网返回 200（notify_url 链路前提成立）。
- RSA2 签名/验签单测 7/7：按「支付宝官方签名规则」（排除 sign/sign_type 字典序拼接 + RSA-SHA256）构造的合法通知被接受；篡改金额/缺 sign/串 app_id 均拒绝。
- 真实 SQLite 集成测试 12/12：入账、重复回调幂等、验签失败拒绝、金额不符拒绝、未知订单拒绝、查单补偿入账、双路径不重复发分、upgrade 三拒绝、越权拒绝、未付通知零入账。

## 6. 生产切换清单（沙箱通过后）

- [ ] 商户完成支付宝企业认证 + 创建「网页/移动应用」并添加 **电脑网站支付** 能力（过审）
- [ ] 生产密钥对（RSA2）+ 生产 APPID（与沙箱不同）
- [ ] `ALIPAY_GATEWAY=https://openapi.alipay.com/gateway.do`
- [ ] notify_url 换 **https**（建议 Nginx 反代域名，替代 IP:端口）
- [ ] `NO_PROXY` 同步豁免 `alipay.com,.alipay.com`
- [ ] 小额真实验证（¥0.01 档）后开放正式套餐
- [ ] 对账：`/api/payment/order/:id` 与支付宝商家后台账单逐笔核对（风险 #4 看板数据源）

## 7. 故障排查

| 现象 | 大概率原因 | 处置 |
|---|---|---|
| `支付渠道未配置` | `.env` 缺 `ALIPAY_APP_ID/PRIVATE_KEY/PUBLIC_KEY` | 补齐后重启 api 容器 |
| 收银台报 `invalid-signature` | 应用私钥/支付宝公钥配反或格式缺 PEM 头 | 核对「私钥自己签、公钥对方验」；normalizeKey 已兼容裸 base64 |
| notify 从未到达 | 端口/防火墙，或容器走了代理 | 验证 5100 公网可达；检查容器 `NO_PROXY` 含 `alipaydev.com` |
| 回调 200 但没到账 | 验签失败或金额不符（看 `PaymentService` warn/error 日志） | 按日志定位；确认回调为原始 form 报文未被中间层改写 |
| 沙箱提示「交易不存在」 | 沙箱数据定期清空 / 用了生产账号付沙箱订单 | 用沙箱买家账号；重新下单 |

---

## 安全设计备忘（评审关注点）

- **入账唯一入口**：`PaymentService.settlePaidOrder`（验签 + `Order.status PENDING→PAID` CAS + 事务发分）。查单补偿与 upgrade 兜底共享同一 CAS，重复调用不可能重复发分。
- **双重幂等锚点**：`Payment.orderId @unique` + `PointTransaction(pool='purchased', orderId)` 守卫。
- **F2 失败闭合解除时机**：仅当 Order 已 `PAID` 才发放；任何未校验 Payment 的发放路径都不存在。
- **金额单位**：Order.amount 为分（Int），支付宝元字符串换算在 adapter 内，杜绝浮点。
