# 地方口述史事件年表（Oral Chronicle）

供地方口述史团队本机使用的事件年表 Web 应用。编辑者录入**事件**、带**出处**的时间主张（可精确到年 / 月 / 日），以及事件之间的**「先于」关系**；同一事件可以保留多条互相矛盾的主张。发布时为每个事件选定一条主张，系统检查全部先后关系后生成**不可变版本**。访客只能看到最新已发布年表。

- 技术栈：Node.js（Express）+ SQLite（better-sqlite3）+ 浏览器原生界面（无需前端构建）

## 一键启动（Docker Compose，推荐）

```bash
docker compose up -d --build
```

启动即完成：安装依赖、初始化 SQLite 数据库（自动建表）、挂载持久化数据卷。
Compose 默认 `SEED_DEMO=1`，首次启动会写入一组演示草稿（3 个事件，含矛盾主张），方便体验发布流程。

访问地址：

| 用途 | 地址 |
| --- --- | --- |
| 访客年表（只读最新已发布版本） | http://localhost:3000/ |
| 编辑者工作台 | http://localhost:3000/editor |
| 最新发布快照 JSON | http://localhost:3000/api/public/chronicle |

编辑者口令默认在 `docker-compose.yml` 中为 `change-me-please`，**请修改后使用**：在编辑台右上角输入口令并保存（仅保存在该浏览器 localStorage 中，请求以 `X-Editor-Token` 头发送）。

停止与查看日志：

```bash
docker compose logs -f
docker compose down            # 保留数据卷
docker compose down -v         # 同时删除数据库数据卷
```

## 不用 Docker，本机直接运行

要求 Node.js ≥ 20。

```bash
npm install
npm start                     # 默认 http://localhost:3000
# 可选：写入演示草稿
npm run seed
npm test                      # 运行求解器与接口测试
```

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址（本机直跑可设 `127.0.0.1`） |
| `EDITOR_TOKEN` | `editor` | 编辑者口令，生产使用务必修改 |
| `DB_PATH` | `./data/chronicle.db`（容器内 `/app/data/chronicle.db`） | SQLite 数据库文件路径，目录自动创建 |
| `SEED_DEMO` | 未设置 | 设为 `1` 时启动写入演示草稿（仅在库为空时） |

改端口示例：

```bash
PORT=8080 EDITOR_TOKEN=my-secret npm start
# 访客 http://localhost:8080/ ，编辑 http://localhost:8080/editor
```

## 使用方式

### 编辑（http://localhost:3000/editor）

1. 右上角输入编辑者口令并保存。
2. 在「事件与时间主张」中添加事件；每个事件可添加**任意多条**时间主张，每条必须填写出处（受访人 / 访谈时间 / 档案全宗 / 页码等），矛盾说法可用「考异备注」记录。
3. 用单选按钮为**每个**事件选定一条拟发布主张（选择只保存在当前浏览器中）。
4. 在「先于」关系中声明 A 严格先于 B，可附出处。
5. 「校验能否发布」先预览；「发布新版本」正式生成不可变快照。

### 发布规则（为什么会发布失败）

粗精度日期按其覆盖的闭区间处理：

- 精确到**年**（如「1958 年」）：区间 `1958-01-01 ~ 1958-12-31`
- 精确到**月**（如「1958 年 3 月」）：区间 `1958-03-01 ~ 1958-03-31`
- 精确到**日**：区间即当天

发布时，系统为每个事件在其选定主张的区间内确定一个**具体日期**，并要求每条「先于」关系两端**严格相差至少一天**（不允许同一天）。以下情况会拒绝发布，错误面板会标明涉事事件与关系（点击可定位），**上一已发布版本保持不变**：

1. **缺少主张**：有事件未选定主张（或选定了已删除 / 不属于该事件的主张）；
2. **关系成环**：「先于」关系构成有向环（含自环，自环在录入时即被禁止）；
3. **时间无解**：区间内不存在满足全部严格先后关系的具体日期。错误信息会给出一条导致矛盾的见证链，例如「冬月会议 先于 春月会议」却分别主张 1958 年 12 月、1958 年 1 月。

发布成功后得到递增版本号（第 1 版、第 2 版……），事件、所选主张（精度、区间、出处、考异）、关系与求解日期全部**复制进版本快照**；此后修改草稿不影响任何旧版本。访客页只展示当前最新版本。

### 从任一已发布版本预览并恢复草稿

在编辑台右下「已发布版本」中，每版都有「预览并恢复为此版」按钮：

1. **预览（不改数据）**：对话框列出该版的事件、每条事件的**被选时间主张**（精度 / 区间 / 出处 / 求解日期）与全部「先于」关系，并对照列出**当前草稿中将被替换**的内容（现有事件及其主张数、现有关系）与当前草稿修订号。预览只是只读核对，不落任何数据。
2. **确认**：请求回传**预览时的草稿修订号**与**当时最新版本号**。服务器在单个事务内：
   - 若该版本不存在 → 404；
   - 若确认前草稿被他人增删改过（修订号不一致）或最新版本号已变化 → **409 恢复冲突且不改任何数据**，需重新预览；
   - 否则**原子替换整个草稿**：清空现有事件 / 主张 / 关系，按快照重建事件与「先于」关系，每个事件**只恢复该版被选定的那一条主张**（未选主张从不进快照，无法恢复）；返回**旧快照 id → 新草稿 id 的映射**（`events / claims / relations`）以及重建后的草稿全貌（即编辑台继续校验发布所需的**待选主张**）。编辑台会自动预选每条恢复的主张。
3. 恢复后可照常「校验能否发布」「发布新版本」，仍须遵守编辑口令、求解校验与 `baseVersionNo` 冲突约定（恢复不改变 `baseVersionNo`，也不会自动发布）。

草稿区每一次增删改（事件 / 主张 / 关系，以及恢复本身）都会把**草稿修订号** +1；`GET /api/editor/state` 与恢复接口都会返回 `draftRevision`。**历史快照与访客年表在恢复过程中保持不变**。

### 两名编辑者并发修改（版本冲突）

发布请求必须带 `baseVersionNo`（编辑台打开时自动记录当前最新版本号）。若两名编辑者都从第 N 版开始改，第一人发布产生第 N+1 版后，第二人仍以 `baseVersionNo=N` 提交时：

- 服务器返回 **409 版本冲突**，编辑台弹出冲突框，告知对方发布的第 N+1 版概况；
- **不会**静默覆盖对方版本；
- 第二人需点击「刷新到最新版本并重新确认选择」，重新核对每个事件的主张单选后再发布。

### 访客（http://localhost:3000/）

只渲染最新已发布版本：按系统确定的日期排列的时间线、每条事件所选主张的精度与出处、全部「先于」关系及其出处。草稿、未发布主张、未发布关系均不出现在任何公开接口中。尚无发布版本时仅显示「尚未发布」。

## 数据与备份

- 单文件 SQLite 数据库：容器中位于 `/app/data/chronicle.db`（Docker 卷 `chronicle-data`），本机直跑位于 `./data/chronicle.db`。
- 备份：停止写入后复制该 `.db` 文件即可（或使用 SQLite 的 `.backup` 命令）。
- 历史版本表 `versions / version_events / version_relations` 只追加、不更新不删除，保证不可变。

## 目录结构

```
src/
  server.js     Express 入口、口令中间件、静态界面
  routes.js     公开只读 API 与编辑者草稿/发布/恢复 API
  db.js         SQLite 连接与建表（草稿区 + 版本快照区 + 草稿修订号）
  dates.js      年/月/日精度 → 覆盖区间（公历序数日）
  solver.js     Tarjan 环检测 + 拓扑下界传播求严格先后可行解
  publish.js    发布事务：再校验 + 版本冲突检查 + 写不可变快照
  draft.js      草稿全貌组装、草稿修订号与草稿变更事务
  restore.js    恢复事务：预览只读 + 乐观并发校验 + 按快照原子重建草稿
  seed.js       演示数据
public/         访客页与编辑台（原生 HTML/CSS/JS）
test/           node:test 单元与端到端测试（含成环、无解、409 冲突、恢复）
```

## 主要 HTTP API

公开（无口令）：

- `GET /api/public/chronicle` — 最新已发布版本完整快照
- `GET /api/public/versions` / `GET /api/public/versions/:no` — 版本清单 / 指定版本

编辑（需请求头 `X-Editor-Token`）：

- `GET  /api/editor/state` — 草稿全貌 + 当前版本号
- 事件：`POST /api/editor/events`、`PUT/DELETE /api/editor/events/:id`
- 主张：`POST /api/editor/events/:id/claims`、`PUT/DELETE /api/editor/claims/:claimId`
- 关系：`POST /api/editor/relations`、`DELETE /api/editor/relations/:id`
- `POST /api/editor/validate` — 预校验（不落库）
- `POST /api/editor/publish` — 发布；体含 `selection:[{eventId,claimId}]`、`baseVersionNo`、`editor`、`note`
  - 422：`{errors:[{type:missing|cycle|temporal, eventIds, relationIds, message, detail}]}`
  - 409：`{code:"VERSION_CONFLICT", baseVersionNo, currentVersionNo, currentVersion}`
- 从历史版本恢复草稿：
  - `POST /api/editor/restore/preview` — 体含 `versionNo`；只读返回该版事件/被选主张/关系、当前草稿将被替换的内容、`draftRevision` 与 `latestVersionNo`；版本不存在 → 404 `VERSION_NOT_FOUND`
  - `POST /api/editor/restore/confirm` — 体含 `versionNo`、`draftRevision`、`expectedLatestVersionNo`（取预览返回值）；原子替换整个草稿，返回 `{restoredFromVersionNo, idMap:{events,claims,relations}, state}`（`state` 即新草稿全貌，含待选主张）
    - 409：`{code:"RESTORE_CONFLICT", message, previewDraftRevision, currentDraftRevision, expectedLatestVersionNo, currentVersionNo}`
    - 404：`{code:"VERSION_NOT_FOUND"}`
- 所有草稿增删改接口（含恢复确认）都会推进 `GET /api/editor/state` 返回的 `draftRevision`；预览与发布不推进。
