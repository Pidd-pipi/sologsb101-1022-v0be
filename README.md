# 香方配伍与窖藏陈化档案（gbincense）

面向香道工作室与制香作坊的配方留档工具：把每款香方的香料配比、炮制方式、和香成型、窖藏陈化与品香评鉴逐环记录，形成可复用的香方档案。

核心动作：**建香方与用途 → 维护香料库与炮制方式 → 按君臣佐使配比 → 排和香工序与成型 → 管窖藏批次环境 → 录品香评分**。

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
| 状态管理 | Pinia 2（setup store） | `formulaStore` / `materialStore` / `proportionStore` / `cellarStore` |
| 用料账 | `utils/materialLedger.ts` | 库存容量预留、配比×数量折算、入窖锁定、出窖报废回冲（全部跑在 Dexie 事务内） |
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
        ├── App.vue             # 顶部导航（6 个模块）+ 底部数据说明
        ├── env.d.ts
        ├── styles/main.css
        ├── types/              # formula.ts material.ts proportion.ts batch.ts cellar.ts tasting.ts
        ├── stores/             # formulaStore.ts materialStore.ts proportionStore.ts cellarStore.ts
        ├── components/common/  # GradeTag.vue FilterBar.vue StatBadge.vue EmptyPanel.vue
        ├── hooks/              # useProportion.ts useIdbTable.ts
        ├── pages/              # FormulaList.vue MaterialLib.vue ProportionBoard.vue
        │                       # BatchList.vue CellarView.vue TastingBoard.vue
        ├── router/index.ts
        └── utils/              # ratio.ts db.ts export.ts
```

| 路由 | 页面 | 主要职责 | 消费模型 |
| --- | --- | --- | --- |
| `/formulas` | 香方台账 | 新建/编辑香方、按香型与用途与状态筛选、卡片回显配比合计与品香均分、状态流转（草稿 → 在用 → 停用）、单方 JSON 导出与导入校验 | Formula、Tasting、Proportion、Batch |
| `/materials` | 香料库与炮制 | 香料增删改、按等级/产地/炮制方式检索、就地改炮制方式、显示被哪些香方引用、清理闲置香料 | Material、Proportion |
| `/proportions` | 配比与君臣佐使 | 君臣佐使编排、占比实时校验 100%、一键等比缩放与归一化、**HTML5 原生拖拽排序写回 `seq`**、按权重一键重排 | Proportion、Formula、Material |
| `/batches` | 和香工序与成型 | 登记和香批次（自动固化配比快照）、快照与当前方子逐味对照、开批次前校验配比是否平衡 | Batch、Formula、Proportion |
| `/cellar` | 窖藏与环境 | 入窖/出窖登记、温湿度就地录入、按剩余天数排序的临近出窖提醒、状态流转（窖藏中 → 已出窖）、批量处理逾期 | Cellar、Batch、Formula |
| `/tastings` | 品香评鉴与导出 | 香韵 / 留香 / 烟气评分录入、同批次多次评鉴取均分并回写香方列表、结构版本查看、全量 JSON 导出与导入校验 | Tasting、Batch、全部模型 |

`/` 与未匹配路径均重定向到 `/formulas`；页面组件全部懒加载，`router.afterEach` 同步 `document.title`。

---

## 五、IndexedDB 库名与数据存储说明

- **库名**：`gbincense`（`frontend/src/utils/db.ts` 中的 `new IncenseDatabase()` → `super('gbincense')`）。
- **结构版本号**：`export const DB_VERSION = 3`，同时写入 localStorage 键 `gbincense:db-version` 便于比对。

| 表 | 主键与索引 | 说明 |
| --- | --- | --- |
| `formulas` | `id, name, scentType, usage, state, createdAt, totalRatio, updatedAt` | 香方主档，`totalRatio` 由配比页实时回写 |
| `materials` | `id, name, origin, grade, processMethod, stock, updatedAt` | 香料库与炮制方式；`stock`/`unit` 为本地库存容量（v3 新增） |
| `proportions` | `id, formulaId, materialId, role, seq, updatedAt` | 君臣佐使配比，`seq` 为拖拽编排顺序 |
| `batches` | `id, formulaId, mixedAt, formingMethod, updatedAt` | 和香批次，含 `snapshot` 配比快照与 `materialUsage` 用料账（v3 新增） |
| `cellars` | `id, batchId, startDate, endDate, state, updatedAt` | 窖藏批次与环境读数；`spoilCount`/`spoilRatePct` 记录出窖报废（v3 新增） |
| `tastings` | `id, batchId, tastedAt, smokeScore, updatedAt` | 品香评鉴 |

### 用料账（库存 / 配比 / 批次一本账）

登记和香批次时按「配比占比 × 数量」逐味折算用料（`Batch.materialUsage`），全程以本地库存 `material.stock` 为容量：

1. **开批预留**：先扣未入窖批次的预留合计再比库存；任一味不够就**整批拒绝**（不写批次），逐味列出缺哪几味、差多少（含它批已留量）。
2. **多标签页并发**：建批与容量复验在同一个 IndexedDB 事务内，两个标签页同时提交同一批领用，只有先到者的预留生效，后到者复验失败、本侧留草稿，可点「按最新余量重试」。
3. **改数量**：数量调小按实到数量重算，多占自然退回；调大需重新过容量，撑不住保留原数量。
4. **改配比**：香方配比变动后自动（250ms 防抖）重算该方**未入窖**批次预留；已入窖批次用料 `locked` 锁成入窖当时那份。库存不足的批次保留原预留并在配比页提示。
5. **入窖 / 出窖**：入窖即锁定用料并释放预留容量；出窖登记报废数，按报废率把报废单位对应的用料**回冲**库存（`writeBackAmount`），改报废数 / 状态回退做差额对称结算。
6. **老档案升级（v2→v3）**：批次先按固化快照补用料账，快照缺失但配比还在的按当前配比补，**缺配比的味留空（`pending`）待核对**且不占库存；香料 `stock` 按现有未入窖预留补出（预留多少补多少），单位缺省 `g`；已入窖批次账目锁定，窖藏报废字段补 0。

- **版本迁移**：`version(1).stores({...})` 为初版结构；`version(DB_VERSION).stores({...}).upgrade(async (tx) => {...})` 为真实迁移，会 `toCollection().modify(...)` 改写历史数据：
  1. 配比表补齐 `seq`（按 `formulaId` 分组顺序编号）与 `updatedAt`；
  2. 批次表补齐 `snapshot` 数组与 `snapshotAt`；
  3. 品香表补齐 `lastingMin` 默认值。
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
