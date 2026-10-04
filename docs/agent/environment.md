# 本机环境

本机 PATH、gh 位置、资源限制。

> 属于 [`AGENTS.md`](../../AGENTS.md) 规范体系的一部分。

## 本机环境

```bash
export PATH="/usr/local/bin:$PATH"   # gh 在 /usr/local/bin，不在默认 PATH
```

- **本机是 4 核 Mac，多 agent 并存** —— 跑全量测试前先看 `uptime`，别互相拖慢
- `ps` 在沙箱环境 `operation not permitted`，查进程用 `lsof`
- 主仓 `/Users/4seven/workspace/pi-lnk`；worktree 在 `.worktrees/<slug>/`
