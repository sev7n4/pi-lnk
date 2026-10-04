## 变更动机

<!-- 解决什么问题，一两句。 -->

## 影响面

<!-- 勾选并补充：

- [ ] 改前端（apps/web）—— 画布渲染 / 交互
- [ ] 改后端（apps/server）—— API / 数据层
- [ ] 改 pi-runtime（services/pi-runtime）—— agent 运行时
- [ ] 改 packages/
- [ ] 改了 prompt-registry 规则（⇒ 须同步 6 处，见 AGENTS.md）
- [ ] 改了工具分层（⇒ 须回答「哪个资产点名了它」，见 AGENTS.md）
- [ ] 改了 vendor/（⇒ 须确认零业务 patch）
- [ ] 改了对外契约（docs/workflow/）
-->

## 验证证据

<!-- 跑了什么命令、看到什么输出。不要只写「跑过了」。

- 命令：
- 关键输出：
-->

## 是否需手工发 runtime 流水线

<!-- 合并后 pi-runtime 不会自动部署，需手工发 workflow_dispatch。

- [ ] 不需要（本次未改 services/pi-runtime/ 、 skills/ 、 vendor/）
- [ ] 需要 —— tag: `<master commit 短 SHA>`

⚠️ 改了这三类路径而勾「不需要」＝ 功能不会上线。详见 AGENTS.md「系统地图」。
-->

## 红线确认

- [ ] 未动 schema / 数据迁移
- [ ] 未动积分 / 扣分 / 退款逻辑
- [ ] 未动 prompt-registry 预算
- [ ] 未向 master 直接提交
