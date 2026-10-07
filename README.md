# 香方配伍与窖藏陈化档案（gbincense）

面向香道工作室与制香作坊的配方留档工具：把每款香方的香料配比、炮制方式、和香成型、窖藏陈化与品香评鉴逐环记录，形成可复用的香方档案。

核心动作：**建香方与用途 → 维护香料库与炮制方式（含本地库存容量）→ 按君臣佐使配比 → 排和香工序与成型（按配比×数量折料预留）→ 管窖藏批次环境（入窖锁定 / 出窖报废按损耗回冲）→ 录品香评分**。

香料库、配比与和香批次共用**一条用料账**：登记和香批次时按「配比 × 数量」折料，先按本地库存预留，库存撑不住整批拒绝并说清缺哪几味、差多少；两个标签页同时领用只让先到的预留生效；改数量按实到退回多占；配比一变未入窖预留跟着重算、已入窖批次用料锁成当时那份；出窖报废再按损耗回冲。

纯前端单页应用（Vue 3 + TypeScript + Element Plus + Vite + Pinia + Vue Router），**无后端、无数据库服务、无 API 服务**，全部数据保存在浏览器本地（IndexedDB / Dexie + 少量 localStorage 元数据），刷新或重启浏览器后依然存在。

---

## 一、Docker 一键启动（推荐）

```bash
# 1. 首次启动先复制环境变量模板
cp .env.example .env

# 2. 构建并启动
docker compose up -d --build
```

启动完成后访问：**http://localhost:22822**

常用命令：

```bash
docker compose ps                 # 查看服务状态（healthy 表示就绪）
docker compose logs -f frontend   # 查看 nginx 日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 代码改动后重新构建
```

> 端口可在 `.env` 中通过 `FRONTEND_PORT` 修改（默认 `22822`）；容器名固定为 `${COMPOSE_PROJECT_NAME:-gbincense}-frontend`。
> `docker-compose.yml` 已用顶层 `name: gbincense` 兜底，任意目录名（含中文）下 `docker compose config --quiet` 都不会报错。
> 容器无状态：不连接数据库、不挂载命名卷，数据全部在浏览器本地；换设备请用应用内「导出全量 JSON」与「导入 JSON」。

---

## 二、技术栈

| 分类 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3（`<script setup>` + Composition API） | 全部页面与组件使用组合式 API |
| 语言 | TypeScript（`strict: true`，`noUnusedLocals` / `noUnusedParameters` 均开启） | `npm run build` 内含 `vue-tsc --noEmit` 类型检查 |
| UI 组件库 | Element Plus 2.x（含 `@element-plus/icons-vue`） | 表格、抽屉、对话框、表单、滑块、提示 |
| 构建工具 | Vite 6 | 开发服务器端口 22822 |
| 状态管理 | Pinia 2（setup store） | `formulaStore` / `materialStore` / `proportionStore` / `cellarStore` / `stockStore` |
| 路由 | Vue Router 4（history 模式） | nginx 侧配合 `try_files $uri $uri/ /index.html` 做 SPA fallback |
| 本地存储 | Dexie 4（IndexedDB 封装）+ localStorage | 库名 `gbincense`，含结构版本号与 `upgrade` 迁移逻辑 |
| 拖拽排序 | HTML5 原生 `draggable` + `dragstart/dragover/drop` | 未引入 `vuedraggable` / `dnd-kit` 等额外依赖 |
| 容器化 | Docker 多阶段：`node:20-alpine` → `nginx:alpine` | 构建阶段执行类型检查与打包，运行阶段仅托管静态产物 |

---

## 三、本地开发方式

```bash
cd frontend
npm install
npm run dev        # 开发服务器 http://localhost:22822
npm run build      # 类型检查 + 生产构建，产物在 frontend/dist
npm run preview    # 本地预览构建产物（http://localhost:22822）
```

要求 Node.js 20 及以上（与 Docker 构建阶段镜像 `node:20-alpine` 保持一致）。

---

## 四、目录结构与页面路由

```
sologsb101-1022/
├── README.md
├── docker-compose.yml          # 顶层 name 兜底，无 version 字段，无挂卷
├── .env / .env.example         # COMPOSE_PROJECT_NAME=gbincense、FRONTEND_PORT=22822
├── .gitignore
├── sologsb101-1022.md          # 提示词原文（只读）
└── frontend/
    ├── Dockerfile              # node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # SPA fallback + gzip + /assets/ 长缓存
    ├── .dockerignore
    ├── package.json / package-lock.json
    ├── tsconfig.json / vite.config.ts / index.html
    ├── public/favicon.svg
    └── src/
        ├── main.ts             # 入口：先 initDatabase() 播种，再挂载应用
        ├── App.vue             # 顶部导航（7 个模块）+ 底部数据说明
        ├── env.d.ts
        ├── styles/main.css
        ├── types/              # formula.ts material.ts proportion.ts batch.ts cellar.ts tasting.ts stock.ts
        ├── stores/             # formulaStore.ts materialStore.ts proportionStore.ts cellarStore.ts stockStore.ts
        ├── components/common/  # GradeTag.vue FilterBar.vue StatBadge.vue EmptyPanel.vue
        ├── hooks/              # useProportion.ts useIdbTable.ts
        ├── pages/              # FormulaList.vue MaterialLib.vue ProportionBoard.vue
        │                       # BatchList.vue StockLedger.vue CellarView.vue TastingBoard.vue
        ├── router/index.ts
        └── utils/              # ratio.ts stock.ts db.ts export.ts
```

| 路由 | 页面 | 主要职责 | 消费模型 |
| --- | --- | --- | --- |
| `/formulas` | 香方台账 | 新建/编辑香方、按香型与用途与状态筛选、卡片回显配比合计与品香均分、状态流转（草稿 → 在用 → 停用）、单方 JSON 导出与导入校验 | Formula、Tasting、Proportion、Batch |
| `/materials` | 香料库与炮制 | 香料增删改、按等级/产地/炮制方式检索、就地改炮制方式、显示被哪些香方引用、清理闲置香料 | Material、Proportion |
| `/proportions` | 配比与君臣佐使 | 君臣佐使编排、占比实时校验 100%、一键等比缩放与归一化、**HTML5 原生拖拽排序写回 `seq`**、按权重一键重排 | Proportion、Formula、Material |
| `/batches` | 和香工序与成型 | 登记和香批次（按配比×数量折料并从本地库存预留，不足整批拒绝）、改数量按实到重算预留、快照与当前方子逐味对照、开批次前校验配比是否平衡 | Batch、Formula、Proportion、StockLine |
| `/stock` | 用料账 | 香料库存余量（库存/预留/锁定/可用/报损）、逐批用料流水（预留中/入窖锁定/出窖报损）、超占与待核对库存提醒 | StockLine、Material、Batch |
| `/cellar` | 窖藏与环境 | 入窖即锁定用料、温湿度就地录入、按剩余天数排序的临近出窖提醒、状态流转（窖藏中 → 已出窖）、**出窖报废按损耗比例回冲**、批量处理逾期 | Cellar、Batch、Formula、StockLine |
| `/tastings` | 品香评鉴与导出 | 香韵 / 留香 / 烟气评分录入、同批次多次评鉴取均分并回写香方列表、结构版本查看、全量 JSON 导出与导入校验 | Tasting、Batch、全部模型 |

`/` 与未匹配路径均重定向到 `/formulas`；页面组件全部懒加载，`router.afterEach` 同步 `document.title`。

---

## 五、IndexedDB 库名与数据存储说明

- **库名**：`gbincense`（`frontend/src/utils/db.ts` 中的 `new IncenseDatabase()` → `super('gbincense')`）。
- **结构版本号**：`export const DB_VERSION = 3`，同时写入 localStorage 键 `gbincense:db-version` 便于比对。

| 表 | 主键与索引 | 说明 |
| --- | --- | --- |
| `formulas` | `id, name, scentType, usage, state, createdAt, totalRatio, updatedAt` | 香方主档，`totalRatio` 由配比页实时回写 |
| `materials` | `id, name, origin, grade, processMethod, updatedAt` | 香料库与炮制方式，`stock` 为本地库存容量（克） |
| `proportions` | `id, formulaId, materialId, role, seq, updatedAt` | 君臣佐使配比，`seq` 为拖拽编排顺序 |
| `batches` | `id, formulaId, mixedAt, formingMethod, updatedAt` | 和香批次，含 `snapshot` 配比快照 |
| `cellars` | `id, batchId, startDate, endDate, state, updatedAt` | 窖藏批次与环境读数，含报废 `scrapped/wastePct` |
| `tastings` | `id, batchId, tastedAt, smokeScore, updatedAt` | 品香评鉴 |
| `stockLines` | `id, batchId, formulaId, materialId, status, updatedAt` | 用料台账：一味料×一批次一行，预留/锁定/报损三态 |

- **用料账流转**：开批 `reserved`（按配比×数量折料，库存不足整批拒绝）→ 入窖 `locked`（用料冻成开批那份，配比再变也不动）→ 出窖报废 `wasted`（按 `wastePct` 记损耗，未损部分释放回可用）。所有写操作在单个 Dexie 事务内重读最新余量再落库，天然串行化：两个标签页同时领用，先提交的事务占用生效，后提交的一方读到最新余量后被拒，由页面保留草稿重试。
- **版本迁移**：`version(1).stores({...})` 为初版结构；v2 回填 `seq` / `snapshot` / `lastingMin`；**v3** 新增 `materials.stock` 与 `stockLines` 表，并在 `.upgrade()` 中：
  1. 老档案缺库存数：按「现有未入窖预留 + 已入窖锁定」占用把每味料的 `stock` 补成恰好够用的值，打 `stockInferred` 标记待人工核对，无占用的补 0；
  2. 按现有批次快照/当前配比补出 `stockLines`：已入窖（窖藏中/已出窖）的批次锁成快照那份，未入窖的按当前配比预留；**缺配比（空快照）的批次先留空不建台账**，待核对；
  3. 窖藏补齐 `scrapped / wastePct / scrappedAt` 报废字段。
- **首屏自动播种**：`main.ts` 在挂载前调用 `initDatabase()`，其中包含 `if ((await db.formulas.count()) === 0) { await seedDatabase() }`，写入 3 款香方 → 7 条配比 / 2 个和香批次 → 2 条窖藏 / 2 条品香（香方 → 配比/批次 → 窖藏/品香 三层互相引用）。播种使用固定 id + `bulkPut`，**幂等**，重复调用不会产生重复数据。
- **localStorage 元数据**：`gbincense:db-version`（结构版本）、`gbincense:last-backup-at`（上次导出时间）、`gbincense:ui-prefs`（当前香方、配比与窖藏排序方式）。
- **导出 / 导入**：`utils/export.ts` 提供 `exportFormulaJson()`（单方）与 `exportSnapshotJson()`（全量），导入前用 `validateFormulaJson()` / `validateSnapshotJson()` 做字段与枚举校验，校验失败会提示具体错误且不写库。
- **无命名卷、无后端**：数据只在本浏览器，清理浏览器站点数据即清空；应用内提供「重置演示数据」按钮可恢复样例档案。

---

## 六、常见问题

1. **端口被占用**：修改 `.env` 中的 `FRONTEND_PORT`（例如 `FRONTEND_PORT=22823`）后重新 `docker compose up -d --build`；本地开发改 `frontend/vite.config.ts` 的 `server.port`。
2. **favicon 或静态资源 403**：`Dockerfile` 在 `COPY --from=builder /app/dist /usr/share/nginx/html` 之后紧接 `RUN chmod -R a+rX /usr/share/nginx/html`，避免宿主机源文件权限为 `0600` 时 nginx worker（uid=101）读不到文件，已被规避。
3. **刷新子路由 404**：`nginx.conf` 已配置 `try_files $uri $uri/ /index.html;`；若自行部署到其它 Web 服务器，请同样配置 history fallback。
4. **换浏览器 / 换设备看不到数据**：数据仅存于当前浏览器的 IndexedDB，请在「品香评鉴」页导出全量 JSON，再在新环境导入。
5. **配比合计不是 100%**：配比页顶部会实时显示合计与偏差，可点「一键等比缩放至 100%」或「按君臣佐使重排」后微调；批次页登记前也会提示当前方子是否平衡。
6. **浏览器隐私模式**：部分浏览器的无痕窗口会禁用或限制 IndexedDB，可能导致看不到演示数据，请使用普通窗口访问。
