# pi-lnk 记忆管理约定

> 配套：[2026-10-08-workbuddy-three-layer-memory-design.md](../superpowers/specs/2026-10-08-workbuddy-three-layer-memory-design.md)（设计 SPEC）、[memory-diagnostic.md](./memory-diagnostic.md)（缺口诊断）
> 适用范围：本项目 agent 侧记忆目录 `pi-lnk/.workbuddy/memory/`（L3 工作区记忆）
> 生效：2026-10-08

## 1 定位与三件套

本目录是 **L3 工作区记忆**（项目级、不绑账号）。三件套职责分明：

| 文件 | 角色 | 约束 |
| --- | --- | --- |
| `MEMORY.md` | **精炼索引 + 高频判据** | **≤3000 字符**（硬限，超出即注入截断） |
| `YYYY-MM-DD.md` | 每日日志，**追加写、不可覆盖** | 记录当天实质工作，append-only |
| `MEMORY-details.md` | `MEMORY.md` 每条结论的**全文快照/证据/file:line** | 按标题组织，供检索，避免索引被证据撑爆 |

> 跨项目的用户偏好走 L2（`~/.workbuddy/user-<UUID>-personal/MEMORY.md`，≤4000 字符，绑账号）；**账号切换会让 L2 换目录、旧滞留新空**——切换后主动核对 L2，必要时把偏好并入本项目 L3（本项目 2026-10-08 已做）。

## 2 字符硬限（强制）

- L3 `MEMORY.md` **≤3000 字符**；L2 `MEMORY.md` **≤4000 字符**。
- 超限的后果：**本会话注入被截断**，最高频判据反而读不全（2026-10-08 实测 17047 字节 → 截断）。
- **护栏**：`pnpm memory:check` 扫描两处 `MEMORY.md`，超限即非零退出；推荐并入 CI 文档校验步骤。
- 计数字符（Unicode 码点），非字节；中文 BMP 字符码点=字节/3，但 emoji（🔴⭐⛔）是代理对，码点=1、字节=2，按码点计。

## 3 写入规则

1. **每日日志追加写**：当天实质工作写入 `YYYY-MM-DD.md`，用 `Edit` **追加到末尾**，绝不覆盖或改写历史行。
2. **编辑 `MEMORY.md` 前先读**：累积文件多次未读追加曾产生 7 行重复（2026-10-03）。编辑前先 `Read` 一遍。
3. **长期事实进 `MEMORY.md`**：跨会话有用的判据/偏好/纪律写进索引；纯流水留在每日日志。
4. **跨项目偏好进 L2**：只在本项目有用的写 L3；跨项目通用的写 L2（或两者都写）。
5. **数字 / file:line 下沉 `MEMORY-details.md`**：`MEMORY.md` 只放结论 + 标题锚点，证据在 details 按相同标题可查。

## 4 蒸馏纪律（补缺口 C）

- **30 天蒸馏**：`YYYY-MM-DD.md` 超过 30 天时，按主题把要点压进 `MEMORY.md`，随后**删除旧日志文件**（蒸馏后旧日志不再需要）。
- **压缩不删判据**：`MEMORY.md` 逼近 3000 时执行压缩——只压措辞、合并同类、数字/file:line 下沉 details；**任何高频判据不可删**（判据是记忆的价值所在）。
- 蒸馏前先读 `MEMORY.md` 全文，避免重复追加。

## 5 落盘复核（防 broker 吞写，缺口 E）

Write/Edit 工具报「成功」**不等于磁盘落盘**（本环境 broker 可能吞写，多次中招）。写入 `.workbuddy/memory/` 后**必须**：
- `wc -c <文件>` 复核字节数符合预期；
- `grep` 复核关键句确实写入；
- `git status` 对 `.workbuddy/`（已 gitignore）**为空属预期**，不能作为落盘判据——以磁盘字节 + grep 为准。

## 6 与产品侧记忆的边界

本项目**作为产品**还提供 `agent_memories` 表（scope=user/canvas，见 `2026-10-03-agent-memory-scope-isolation-design.md`）。那是**给用户用的功能记忆**，与本文档的 **agent 自身记忆** 完全正交：存储、作用域、生命周期都不同，不可混谈。本目录只管 agent 自身如何记住项目/用户事实。

## 7 自检清单（每次写记忆后过一遍）

- [ ] `MEMORY.md` ≤3000 字符（`pnpm memory:check` 通过）
- [ ] 编辑前已 `Read` 过 `MEMORY.md`
- [ ] 数字/file:line 已下沉 `MEMORY-details.md`
- [ ] 每日日志为追加写，未覆盖历史
- [ ] 写入后 `wc -c` + grep 复核落盘
- [ ] 跨项目偏好已考虑是否需同步 L2
