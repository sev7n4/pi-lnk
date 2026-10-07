# RUNBOOK：存量用户可选音频模型回填（audio design/music 上架）

> 面向对象：负责把 `feat/audio-node-unified-capability` 上线到生产的人。
> 脚本：`apps/server/scripts/backfill-audio-models.ts`（一次性，**不自动执行**）
> 纯逻辑：`apps/server/src/provider/audio-model-backfill.ts`（有 vitest 覆盖）

## 1. 为什么需要这一步

画布「音」节点新增了 `design` / `music` 两个分类，各自依赖一条**新模型**：

| 分类 | 模型 | 上架方式 |
|---|---|---|
| `design`（综合音频） | `stepaudio-3-gen-preview` | 进 `STUDIO_MODEL_CATALOG` |
| `music`（配乐） | `stepaudio-3-music-preview` | 进 `STUDIO_MODEL_CATALOG` |

但落库只发生在 `ProviderService.ensurePreferences` 的 **create 分支**
（`apps/server/src/provider/provider.service.ts:676`）：`existing` 直接 return。
于是**存量用户**的 `UserAiPreferences.selectableAudioModels` 与平台渠道 `models`
都停留在新模型上架**之前**的历史快照。

后果链（用户可见）：前端按 kind 过滤可选列表 → 交集为空 → 用户点「音乐」chip
只切 kind、不换模型 → 服务端 400。`apps/web` 也没有任何地方调
`providerApi.updatePreferences` ⇒ 用户**无处可去**，只能找客服。

## 2. ⛔ 为什么不能改成自动补齐

**不要**给 `ensurePreferences` / `ensurePlatformChannel` 加「自动并入新模型」逻辑。

DB 里「用户主动停用某模型」与「该模型是新上架的」**同形**——两者都表现为
「快照里少一条」。自动补齐会复活用户主动停用的模型，且没有任何审计痕迹、
没有回滚点。这是一次性人工口径，不是能固化成代码的规则。

## 3. 什么时候跑

| 项 | 值 |
|---|---|
| 时机 | **代码已上线、且确认新模型已在目录里**之后单独跑一次。不要和发布绑在同一步。 |
| 环境 | 生产容器内（SQLite 生产库）。⛔ 不要在本地/预发「顺手跑一下」——那是另一份库。 |
| 目标表 | `UserAiPreferences.selectableAudioModels`（列，JSON 字符串）+ `ProviderChannel.models`（仅 `id='platform'` 那**一行**） |
| 影响用户 | 全部存量用户（只增不删，见 §4） |
| 可重复 | 是（幂等，见 §6） |

前置条件：镜像里的 `packages/shared` 已含两条新模型。先用 §5 的 dry-run
看一眼打印出来的「目录 audio 桶 N 条」——**若 N 仍是 4（而不是 6），说明镜像里的
目录是旧的，立刻停止**（见 §7 的踩坑）。

## 4. 口径：对「用户主动停用」的处理

> **只并入「目录里存在、但该用户快照里没有」的条目；绝不删除、绝不重排快照里已有的条目。**

这条口径的后果，必须让执行人知道：

- 🔴 **用户主动停用过的模型，只要它仍在目录里，就会被这次回填重新加回来。**
  这是「一次性人工口径」的已知代价，不是 bug：新上架与主动停用在 DB 里无法区分。
  缓解手段是 §5 的人工核对——dry-run 会逐用户打印 `added`，apply 前看一眼
  是不是自己预期的规模。
- ✅ 用户主动停用一个**已被从目录移除**的模型：不受影响（目录里没有 ⇒ 不会并入）。
- ✅ BYOK 自定义模型（`ch_xxx::custom`）不在目录里 ⇒ 快照原样保留，脚本不碰。
- ✅ 用户快照里**已有**的条目：顺序不变、内容不变（脚本只做尾部追加）。
- ⚠️ 脏数据（`selectableAudioModels` 不是合法 JSON）⇒ 保守当空数组补齐，
  这会**丢弃**该用户原本那串无法解析的内容。这类行会计入 `changed`，
  apply 前请在 dry-run 输出里留意 `+6`（全量补齐）的行是否比预期多。

## 5. 怎么跑

**dry-run 是默认模式**，必须显式 `--apply` 才写库。

```bash
# 1) 先看会改什么（不写库）。逐行打印 userId + 本次新增的条目。
docker exec -i lnkpi-api sh -c \
  'cd /app/apps/server && node_modules/.bin/tsx scripts/backfill-audio-models.ts'

# 2) 人工核对上面的 added 列表（规模是否符合预期？有没有异常多的全量补齐行？）
#    确认无误后写库（脚本会先自动备份 *.db 到同目录 .bak-<ts>）
docker exec -i lnkpi-api sh -c \
  'cd /app/apps/server && node_modules/.bin/tsx scripts/backfill-audio-models.ts --apply'

# 3) 再跑一次 dry-run，确认 0 处待写 ⇒ 幂等达成
docker exec -i lnkpi-api sh -c \
  'cd /app/apps/server && node_modules/.bin/tsx scripts/backfill-audio-models.ts'
```

第 3 步必须打印 `0 条待写` 且平台渠道 `已一致`。否则**不要**继续，回报并排查。

## 6. 怎么核对

### 6.1 脚本自身

第 3 步的输出即幂等判据：`用户快照：0 条待写 / N 条已是目标态` +
`平台渠道 models：已一致`。

### 6.2 SQL 核对（生产 SQLite，直连容器内库文件）

```sql
-- 核对 1：仍缺新模型的存量用户（期望 **0 行**）
SELECT userId FROM UserAiPreferences
WHERE selectableAudioModels LIKE '%stepaudio-3-gen-preview%' = 0
   OR selectableAudioModels LIKE '%stepaudio-3-music-preview%' = 0;

-- 核对 2：平台渠道 models 是否已含两条新模型（期望各 ≥1）
SELECT
  json_extract(models, '$') IS NOT NULL AS models_is_array,
  models LIKE '%stepaudio-3-gen-preview%'   AS has_design,
  models LIKE '%stepaudio-3-music-preview%' AS has_music
FROM ProviderChannel WHERE id = 'platform';

-- 核对 3：确认没有用户渠道被误改（本脚本只应动 id='platform' 那一行）
SELECT id, userId FROM ProviderChannel WHERE models LIKE '%stepaudio-3-music-preview%';

-- 核对 4：抽查若干用户的快照，确认既有条目与顺序未被重排、BYOK 条目还在
SELECT userId, selectableAudioModels FROM UserAiPreferences
WHERE selectableAudioModels LIKE '%::custom%' OR selectableAudioModels LIKE '%ch_%'
LIMIT 20;
```

### 6.3 产品面

拿一个**存量账号**登录 → 打开画布「音」节点 → 依次点 `voice` / `design` / `music`
三个分类 chip：每次都应切到对应模型（下拉里能看到 `StepAudio 3 Gen` /
`StepAudio 3 Music`），且**不报 400**。

## 7. 怎么回滚

脚本 apply 前会自动备份：`/app/apps/server/data/lnkpi.db.bak-<ts>`（同目录）。

```bash
# 1) 找到备份
docker exec -i lnkpi-api sh -c 'ls -lt /app/apps/server/data/*.bak-* | head'

# 2) 停服后回滚（覆盖前再备份一次当前状态，便于二次回滚）
docker exec -i lnkpi-api sh -c 'cp /app/apps/server/data/lnkpi.db /app/apps/server/data/lnkpi.db.pre-rollback'
docker exec -i lnkpi-api sh -c \
  'cp /app/apps/server/data/lnkpi.db.bak-<ts> /app/apps/server/data/lnkpi.db'
# 3) 重启 API
```

只回滚**用户快照**、保留其他变更时（推荐，影响面更小）：

```sql
-- 用备份库里的值覆盖回来（把备份库作为 ATTACH 进来的第二个库）
ATTACH DATABASE '/app/apps/server/data/lnkpi.db.bak-<ts>' AS bak;
UPDATE UserAiPreferences
SET selectableAudioModels = (
  SELECT selectableAudioModels FROM bak.UserAiPreferences b WHERE b.userId = UserAiPreferences.userId
)
WHERE userId IN (SELECT userId FROM bak.UserAiPreferences);
UPDATE ProviderChannel SET models = (SELECT models FROM bak.ProviderChannel WHERE id = 'platform')
WHERE id = 'platform';
DETACH DATABASE bak;
```

回滚判据：重跑 §6.2 的核对 1，应重新出现「缺新模型」的存量用户行。

## 8. 踩坑（实测踩过，别重犯）

| 坑 | 现象 | 正确做法 |
|---|---|---|
| 脚本放在仓库根 `scripts/` | 经 pnpm 隐藏提升目录解析到**主仓**的 `packages/shared`，只看到 **4** 条 audio（缺本次两条新模型）⇒ 回填按旧目录补齐、**静默漏掉**新模型 | 脚本必须放 `apps/server/scripts/`（与 `backfill-point-transactions.ts` 同处），那里解析到的是当前 checkout |
| 直接 `pnpm install` 试图修 node_modules | 在 worktree 里会破坏链接状态 | 不要动 node_modules |
| 误以为「改 `ensurePreferences` 更省事」 | 会复活用户主动停用的模型，且无审计无回滚（见 §2） | 一次性脚本 + 本 runbook |
| 拿 `sqlite3` 灌测试数据时 `DATETIME` 只写 `2026-09-01` | Prisma 读回报 `Inconsistent column data: Conversion failed` | 灌数据用完整 ISO：`2026-09-01T00:00:00+00:00` |

## 9. 一次跑完的实跑记录（本地开发库，非生产）

用于确认脚本在真实 Prisma + SQLite 上跑得通、且幂等。
数据是自造的存量快照（含 BYOK / 空快照 / 已完整 / 曾移除 music 四种形态）。

**dry-run（第一次）**：

```
[backfill] 偏好行 5 条 / 平台渠道 存在｜模式=DRY-RUN（不写库）
[backfill] 目录 audio 桶 6 条：platform::seed-audio-1.0, platform::minimax-speech-2.8-hd, platform::step-tts-mini, platform::stepaudio-3-tts, platform::stepaudio-3-gen-preview, platform::stepaudio-3-music-preview
CHANGE u-legacy-byok                +5  platform::seed-audio-1.0, platform::step-tts-mini, platform::stepaudio-3-tts, platform::stepaudio-3-gen-preview, platform::stepaudio-3-music-preview
CHANGE u-legacy-empty               +6  platform::seed-audio-1.0, platform::minimax-speech-2.8-hd, platform::step-tts-mini, platform::stepaudio-3-tts, platform::stepaudio-3-gen-preview, platform::stepaudio-3-music-preview
CHANGE u-legacy-full                +4  platform::step-tts-mini, platform::stepaudio-3-tts, platform::stepaudio-3-gen-preview, platform::stepaudio-3-music-preview
CHANGE u-legacy-partial             +5  platform::seed-audio-1.0, platform::step-tts-mini, platform::stepaudio-3-tts, platform::stepaudio-3-gen-preview, platform::stepaudio-3-music-preview
[backfill] 用户快照：4 条待写 / 1 条已是目标态
[backfill] 平台渠道 models：待同步 —— 平台渠道目录镜像落后：2 条 → 28 条
[backfill] DRY-RUN 结束：5 处待写。加 --apply 执行。
```

⇒ 已是目标态的 `u-new`（走 create 分支的新用户）**未被改写**，符合预期。

**apply**：

```
[backfill] 偏好行 5 条 / 平台渠道 存在｜模式=APPLY（会写库）
...（CHANGE 行同上）
[backfill] 已备份 .../prisma/dev-local.db → .../prisma/dev-local.db.bak-2026-10-07T07-33-51-466Z
[backfill] 平台渠道 models 已同步（28 条）
[backfill] 写入用户快照 4 行；偏好行数 5 → 5
```

**dry-run（第二次，验幂等）**：

```
[backfill] 偏好行 5 条 / 平台渠道 存在｜模式=DRY-RUN（不写库）
[backfill] 用户快照：0 条待写 / 5 条已是目标态（无需回填）
[backfill] 平台渠道 models：已一致 —— 已与目录一致
[backfill] DRY-RUN 结束：0 处待写。加 --apply 执行。
```

**SQL 核对**：核对 1 返回 0 行；`u-legacy-byok` 的快照为
`["ch_byok_1::my-custom-voice","platform::minimax-speech-2.8-hd", ...6 条目录条目]`
—— BYOK 条目在**首位**、未被删除或重排。
