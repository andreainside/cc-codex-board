# cc-codex-board 优化 — 设计 Spec

- 日期:2026-06-06
- 状态:待 review(实现前)
- 范围:对已发布的 cc-codex-board 做 8 项优化(含 1 个 bug 修复)+ 一次发布(0.2.0)。⑦⑧ 为纯前端增量。

## 背景 / 问题

cc-codex-board 是一个本地只读看板,展示所有在跑的 Claude Code / Codex 窗口。当前痛点:

1. **没有主动触发 AI 总结的入口**——`--summary` 只在窗口"完成一个回合"时自动跑,无法对某个窗口按需立刻总结。
2. **空闲窗口越积越多**——CC 窗口只要进程活着就一直显示,空闲的不会下掉。
3. **只能按仓库看**——想"按状态聚合看一眼"没有入口。
4. **顶栏"0 次 LLM 调用"是写死的**(`public/app.js:20-24`),不是真实统计;开了 `--summary` 后也看不到实际花了多少 token。
5. **「等你」漏报**——CC 卡在权限/确认提示时,看板把"跑着"-1 落到"空闲",不显示"等你"。

## 分发 / 升级(回答"已安装用户能否收到优化")

- 主推方式 `npx github:andreainside/cc-codex-board`:npx 每次运行解析默认分支 `main` 最新 commit,按 SHA 缓存;**push 到 main → 用户下次启动自动拿到新代码**(看板是常驻进程,需重启才生效)。
- `git clone` 用户需自行 `git pull`。
- 没有 npm registry 环节,"发布更新" = push 到 GitHub `main`。
- 本次实现完成后:`package.json` `version` → `0.2.0`,README 加一段 CHANGELOG,让"静默更新"可被感知。

## 目标

- 每张卡片一个手动"✨ 总结"按钮(含正在跑的窗口)。
- 空闲窗口三段生命周期:主视图 → 存档/复盘视图 → 丢弃;存档可**手动恢复**进主视图。
- 主视图支持"按仓库 / 按状态"切换。
- 主视图「专注」过滤:一键只看「等你 + 跑着」(隐藏空闲与等CI/复评)。
- 顶栏显示看板自启动以来的真实 LLM 用量(调用次数 · token · 估算花费)。
- 修复「等你」(needs-you) 漏报:CC 卡在权限/确认提示时正确显示「等你」而非把「跑着」-1。
- 每个对话可加用户备注(localStorage,按 sessionId 存),方便辨别管理。
- 「按仓库」视图内按文件夹 / worktree 二级分组,同文件夹的聚在一起。

## 非目标(维持原 SPEC 约束)

- 仍**不写**用户的 transcript / repo。新增的两个"动作"(`POST /api/summarize` 触发 AI 标题、`POST /api/restore` 从存档恢复)都只读现有会话内容 / 改看板自身内存态,原 SPEC "无任何 action" 的措辞为此收一个明确口子。
- 不引入持久化 DB:用量计数随进程重启清零;前端视图偏好存浏览器 `localStorage`。
- 存档**不**读已关闭会话的磁盘 transcript(不新增数据路径);窗口一旦真正关闭/采集不到,立刻消失,不进存档。
- 仍零运行时依赖,Node ≥ 18。

---

## 特性 ① 空闲窗口三段生命周期(主 / 存档 / 丢弃)

### 行为
按"距最后活动时间"(idle age = `now - lastActivityAt`)对 **`idle` 状态**窗口分桶:

| idle age | 去向 |
|---|---|
| < 4h | 主视图(现状) |
| 4h – 30h | 存档/复盘视图(移出主视图) |
| > 30h | 丢弃(不显示) |

- 仅 `idle` 走这条流水线。`needs-you / running / waiting-ci-review` **永远留主视图**,不进存档、不被丢弃(只要还采集得到)。
- 窗口再次活动 → `lastActivityAt` 更新 → 自动回主视图。
- 存档卡片复用现有卡片渲染,**按最近活动倒序**排,每张加一行「已空闲 Xh」。

### 阈值 / 配置(`config.js`)
- `idleArchiveMs` 默认 `4 * 3600_000`;`idleDropMs` 默认 `30 * 3600_000`。
- CLI:`--idle-archive <小时>`、`--idle-drop <小时>`(`0` = 关闭该段)。config.json 用 `idleArchiveHours` / `idleDropHours`。
- 关闭语义:`--idle-archive 0` ⇒ 不分存档(全留主视图);`--idle-drop 0` ⇒ 永不丢弃。

### 采集层影响
- **CC**:进程存活才采集(不变)。CC 空闲窗口本就一直被采集 → 分桶是纯下游过滤;idle >30h 的在 `buildBoard` 里丢弃(进程虽活着,看板停止显示)。
- **Codex**:无进程,liveness 按 mtime。为让 Codex 空闲会话能进存档,采集窗口从 `codexActiveWindowMs`(2h)放宽到 `idleDropMs`(30h),`scanWindowMs` 相应覆盖 30h + 余量。
  - 副作用:主视图会开始显示空闲 2–4h 的 Codex(与 CC 的"空闲<4h 留主视图"对齐)。
  - 边界:Codex 的 `waiting-ci-review` 若 >30h 无活动则采集不到 → 被动丢弃;"非 idle 不丢弃"是采集窗口内的尽力保证(已记录,可接受)。

### 存档机制 / 手动恢复
- **30h 直接丢**:idle 且(有效)最后活动距今 > `idleDropMs`(30h)→ 从存档移除,不再显示。CC 进程可能仍活着,看板停止显示;Codex 因采集窗口=30h 自然不再采集。
- **手动恢复**:存档卡片加 `[↩ 恢复]`。`POST /api/restore { id }` → board provider 在内存 `restoredAt` Map 记 `restoredAt[id]=now`,同步回 200。
- **有效活动时间** `effectiveActivity = max(真实 lastActivityAt, restoredAt[id] || 0)`,**仅用于生命周期分桶**(不改 status 推导——恢复后仍是 idle 状态,只是回到主视图)。恢复后 idle age 归零 → 回主视图,获得新的 4h 主视图窗口期,之后照常 archive(4-30h)→ drop(30h)。窗口真正活动会自然刷新 `lastActivityAt`,与 restore 取较大值。
- `restoredAt` 为内存态(重启清零,符合无 DB);按 `idleDropMs` 定期清理过期条目。

### 数据流(`buildBoard`)
状态推导后,用 `age = now - effectiveActivity` 给每个窗口打 `zone`:
```
if (status !== 'idle')            zone = 'main'
else if (idleArchiveMs 关闭)       zone = 'main'
else if (age < idleArchiveMs)      zone = 'main'
else if (idleDropMs 开 && age > idleDropMs)  zone = 'dropped'   // 不进 payload
else                               zone = 'archive'
```
主视图的 `summary` / `groups` / `windows` 只含 `zone==='main'`;存档单独成桶。`buildBoard` 需注入 `restoredAt` 读取器(由 board provider 提供)。

### Payload(新增字段)
```jsonc
{
  "generatedAt": 0,
  "meta": { "summaryEnabled": false, "llmUsage": { /* 见③ */ } },
  "summary": { "total": 0, "counts": {} },   // 仅主视图
  "windows": [/* 主视图窗口,扁平,供"按状态"视图用 */],
  "groups":  [/* 主视图按仓库分组 */],
  "archive": { "count": 0, "windows": [/* 存档窗口,最近活动倒序 */] }
}
```
卡片"已空闲 Xh"由前端按 `lastActivityAt` 算,无需新增字段。

### 测试
- `idle 1h → main`、`idle 5h → archive`、`idle 31h → dropped`、`needs-you 40h → main`、`running → main`。
- 集成 fixture:一个空闲 5h 的 Codex rollout 出现在 `archive`。
- `--idle-archive 0` / `--idle-drop 0` 的关闭语义。
- 恢复:`restoredAt[id]=now` 后,原本 5h 空闲(应在 archive)的窗口回到 `main`;`POST /api/restore` 未知 id → 404、非 POST → 405。

---

## 特性 ⑤ 修复「等你」(needs-you) 漏报

### 现象
终端 CC 弹出"是否允许 / 确认"时,看板不显示「等你」,反而把「跑着」-1(落到「空闲」)。

### 根因(已用真实数据确认)
- CLI 会话的 `status` 只有 `idle` / `busy`;等待权限/确认时翻成 **`idle`**(不再 busy)。
- `extractAwaitingInput`(`cc-transcript.js`)只在"最后一条 assistant **文本**以 `?`/`？` 结尾"时返回 true。权限/确认/计划批准本质是一个待批的 **`tool_use`**,最后的 assistant 没有以问号结尾的文本(甚至没有文本块)→ 检测不到 → `deriveStatus` 落到 `idle`。
- 于是 `busy → idle`(跑着 -1),但 `awaitingInput=false` → 不升级为 `needs-you`。

### 修复
`extractAwaitingInput` 增加"**待决工具调用**"信号:
- 扫描 transcript,收集 `tool_use` 的 `id` 与其后 `tool_result` 的 `tool_use_id`;**存在 tool_use 未被 tool_result 解决** = 该回合停在一个待批工具上。
- `awaitingInput = (最后 assistant 文本以 ?/？ 结尾) OR (存在待决 tool_use 且其后无真实用户输入)`。
- 仍由 `deriveStatus` 的 `!running` 兜底:`busy` 的窗口即便有在飞的工具也判 `running`(正确);只有 `idle` + 待决 tool_use 才升级 `needs-you`。
- 验证:扫描最近 40 个 transcript,已结束回合的待决 tool_use 数均为 0(tool_result 正确闭合,含被中断的情形)→ 信号干净,不对正常结束会话误报。

### 落地数据(实现期补 fixture)
当前快照无"正卡在权限提示"的会话,无法直接抓 awaiting 态。实现时在终端 CC 卡住一次权限提示,把该 transcript 存成 fixture,锁死单测:`idle + 待决 tool_use → needs-you`;`busy + 待决 tool_use → running`;`工具已闭合 → 不误报`。

---

## 特性 ② 每卡手动总结按钮

### 后端
- `summarizer.js` 新增 `summarizeNow(window)`:与 `runSummary` 相同,但**绕过** `enabled` 检查、`running` 跳过、回合门控与失败退避;仍用 `inflight` 去重(防重复点击)。返回 `{ title }` 或抛错。
- `POST /api/summarize`,body `{ id }`:
  - 从当前(缓存的)board 找到该 id 的窗口(主视图 + 存档都可被找到)。
  - 调 `summarizeNow`,成功后标题进缓存(下次轮询 `getTitle` 也能拿到),**同步**返回 `{ id, headline }` 供前端立刻更新该卡。
  - 校验:仅 `127.0.0.1`;`id` 必须是已知窗口(未知 → 404);非 POST → 405;body 体积上限。
- 接线:`createRequestHandler` 注入 `summarizeWindow(id)`;`createBoardProvider` 实现它(复用持久化的 summarizer 实例 + `getBoard` 查窗口)。

### 关键取舍(已采纳推荐)
- **同步**返回:按钮转圈几秒 → 标题立即出现。本地单用户,占用一个连接几秒可接受。
- **没开 `--summary` 也能点**:点击即授权;`getTitle` 不看 `enabled`,缓存命中即可让 `chooseHeadline` 用 AI 标题。此时顶栏用量计数会变非 0(诚实反映)。
- **总结正在跑的窗口 = 快照**:窗口推进后 `signature`(`lastActivityAt`)变化 → 缓存失效 → 标题退回非 LLM,需要再点。不做"常驻手动标题"(YAGNI)。
- 自动总结仍受 `enabled` 门控:手动不改变"默认零 LLM"。

### 前端
- 卡片底部加 `[✨ 总结]`(`data-id` + `data-action="summarize"`,事件委托在 board 上)。
- 点击 → 禁用按钮 + 转圈 → `POST /api/summarize` → 成功用返回的 headline 就地更新该卡标题 → 解禁。失败提示并解禁。

### 测试
- `summarizeNow` 单测:忽略 `enabled`/`running`/门控;`inflight` 去重。
- server 单测:合法 id → 调注入函数并返回 headline;未知 id → 404;GET 该路径 → 405。

---

## 特性 ③ 顶栏真实 LLM 用量

### 后端
- `summarizer` 的 `claude -p` 调用加 `--output-format json`;解析:
  - `result` → 标题(交给 `parseSummaryOutput`)。
  - `usage` → `input_tokens` / `output_tokens` / `cache_*_tokens`;`total_cost_usd` → 估算花费。
  - JSON 解析失败 → 回退当作纯文本(无 usage),不崩。
- 累加器 `usage = { calls, inputTokens, outputTokens, costUsd }`(自动 + 手动都计);新增 `getUsage()`。
- `buildBoard`:`meta.llmUsage = summarizer.getUsage()`(保留 `meta.summaryEnabled`)。

### 前端(`app.js` 顶栏 hint)
- `calls === 0` → 「本地只读 · 0 次 LLM 调用」(此时是**真实**的 0)。
- `calls > 0` → 「本地只读 · {calls} 次调用 · {tok} tok · ${cost}」。
  - `tok` = (input+output) 经 `formatTokens`(`34.5K` / `1.2M`,放进 `render.js` 便于测试)。
  - `cost` 为 `claude -p` 自报估算(订阅口径为估值);为 0 或缺失则省略。
- 计数随进程重启清零(无 DB)。

### 测试
- summarizer 从 JSON 输出解析 usage 并累加;解析失败回退纯文本仍出标题。
- `formatTokens` 纯函数单测。

---

## 特性 ④ 主视图"按仓库 / 按状态"切换

### 前端
- `render.js`:`renderBoard(board, now, opts = {})`,`opts.view`(`'main'` 默认 / `'archive'`)+ `opts.grouping`(`'repo'` 默认 / `'status'`)。向后兼容(旧调用默认 main+repo,现有测试不变)。
  - `grouping==='status'`:用 `board.windows` 按 `STATUS_PRIORITY` 分 4 段;段头「● {label} ({count})」带颜色;空段只留段头(充当"按状态聚合"概览);非空段渲染卡片网格。
  - `view==='archive'`:渲染 `board.archive.windows`,最近活动倒序,每卡加「已空闲 Xh」+ `[↩ 恢复]`(仍保留 `[✨ 总结]`)。
- 控件(`index.html` + `app.js`):顶栏 `[按仓库][按状态]` 分段控件 + `[🗄 存档 (N)]` 按钮;进存档视图时显示 `[← 返回]`。
- 状态:主视图 grouping 存 `localStorage`(键 `ccb-grouping`);`view`(main/archive)为瞬时(按钮切换)。`app.js` 缓存上一份 board,切换/总结后立即重渲染,不等下次轮询。

### 测试
- `render` 单测:`grouping==='status'`(needs-you 段在前、各段计数正确);`view==='archive'`(列表 + 「已空闲」标签);卡片含 `[✨ 总结]` 按钮。

---

## 特性 ⑥ 主视图「专注」过滤(只看 等你 + 跑着)

### 行为
顶栏「专注」开关(与「按仓库/按状态」「🗄 存档」并排)。开启后主视图只显示 `needs-you` 和 `running` 的窗口,隐藏 `idle` 与 `waiting-ci-review`。与分组方式**正交**(repo / status 下都生效)。汇总条仍显示完整计数(总览不变)。状态存 `localStorage`(键 `ccb-focus`)。存档视图不受影响。

### 前端
- `render.js`:`renderBoard(board, now, { ..., focus })`;`focus` 时把 `board.windows` / 各 group 的 windows 过滤到 `status ∈ {needs-you, running}`,repo 分组下丢空组;全被过滤时显示"专注模式:当前没有「等你/跑着」"。
- `app.js` + `index.html`:加「专注」按钮 + `ccb-focus` 持久化。

### 测试
- `render` 单测:focus 下 repo 与 status 分组都只剩 needs-you/running 的卡片(idle、waiting-ci-review 的 `data-id` 不出现)。

---

## 特性 ⑦ 每对话备注(localStorage,按 sessionId)

### 行为
每张卡片在标题下方有一行备注:有备注显示 `📝 "文字" ✎`,无备注显示淡色 `📝 备注…`。点击进入行内编辑(预填当前值),**Enter / 失焦保存**、**Esc 取消**、清空即删除。在所有视图(主/存档/专注、按仓库/按状态)都显示。

### 存储与键
- 浏览器 `localStorage`,键 `ccb-note:<sessionId>`。**按 `sessionId` 存**(不是易变的 `cc:<pid>`),所以关掉/重开窗口、pid 变了备注仍在。每浏览器独立(用户选择)。
- **纯前端,零后端、零写盘**,完全保持看板"机器上只读"。

### 前端
- `render.js`:`renderBoard`/`renderCard` 接受 `opts.notes`(`sessionId → text` 映射),纯函数渲染备注元素(带 `data-session`、`data-action="note"`);空备注渲染添加占位。
- `app.js`:`loadNotes()` 从 localStorage 扫 `ccb-note:` 前缀构建映射,传入 `renderBoard`;board 点击委托处理 `data-action="note"` → 行内 `<input>` 预填 → Enter/失焦存 localStorage、Esc 取消 → 重渲染;编辑期间用 `editing` 标志**暂停 5s 轮询重渲染**,避免输入被清掉。

### 测试
- `render` 单测:给定 notes 映射,有备注的卡显示文字 + `data-session`;无备注显示占位;sessionId 不在映射 → 占位。

---

## 特性 ⑧ 「按仓库」内按文件夹 / worktree 二级分组

### 行为
仅影响 **按仓库** 视图。每个仓库组内,窗口再按 `cwd` 细分:仓库下有 **≥2 个不同文件夹** → 渲染 `📁 文件夹` 小节(worktree 各自成节);只有 **1 个文件夹** → 保持扁平(不加多余小节)。按状态 / 存档视图不变。

### 前端(纯 `render.js`)
- `folderLabel(cwd)`:取路径末 1–2 段(如 `worktrees/sleep-trend`),便于辨认 worktree;不做"(主)"标注(cwd 无法可靠判断主 checkout)。
- `groupByFolder(windows, now, cardOpts)`:按 `cwd` 分桶(保留已排序的窗口顺序 = 状态优先级顺序);桶数 ≤1 扁平,否则按 Map 插入顺序渲染小节。
- `renderBoard` 的 repo 分组分支用 `groupByFolder` 替换原来的扁平 grid;`cardOpts`(含 notes)透传到 `renderCard`。

### 测试
- `render` 单测:仓库组含 2 个不同 cwd → 出现 2 个 `📁` 小节标题;仅 1 个 cwd → 无小节(扁平);`folderLabel` 取末 2 段。

---

## 跨切面 / 收尾
- **HTTP 端点**:`GET /api/windows`(现有,payload 扩 `archive`/`meta.llmUsage`)、`POST /api/summarize {id}`(②)、`POST /api/restore {id}`(①恢复)。两个 POST 仅 `127.0.0.1`、校验 id、非 POST→405、未知 id→404、body 体积上限。`createRequestHandler` 注入 `summarizeWindow(id)` 与 `restoreWindow(id)`;`createBoardProvider` 持有 summarizer 实例与 `restoredAt` Map 来实现它们。
- `app.js`:增加 `lastBoard` 缓存、`view`(main/archive)/`grouping`(repo/status) 状态、按钮事件委托(`✨ 总结` / `↩ 恢复`)、即时重渲染(不等下次轮询)。
- README / SPEC:记录新标志(`--idle-archive` `--idle-drop` 等)、两个"动作"端点(手动总结 / 恢复,说明**仍永不写 transcript/repo**)、存档生命周期、用量计数、视图切换、「等你」修复;收紧"无 action"措辞。
- `package.json` `version` → `0.2.0` + CHANGELOG 一句。
- 维持零依赖、`node --test` 全绿。

## 风险 / 待 review 确认点
1. Codex 采集窗口 2h → 30h(上文副作用);如需给 Codex 单独阈值,在此调整。
2. 空闲阈值默认 4h(出主视图)/ 30h(丢弃)(会改变所有"更新后"用户的主视图——空闲>4h 的会移出);可调。
3. 手动总结=同步、可对 running、无 `--summary` 也可点——均按推荐采纳。
4. 新增 `POST /api/summarize` 与 `POST /api/restore` 是对原"只读/无 action"的让步(仍不写用户文件,只读会话/改看板内存态)。
5. 「等你」修复用"待决 tool_use"信号 + `!running` 兜底;实现期需抓一个真实"权限提示"transcript 做 fixture 锁死。
6. 恢复语义:`restore` 把生命周期时钟重置到 now(回主视图 4h,然后照常 archive→drop);如希望"只延 4h、不重置 30h 丢弃"另说。
