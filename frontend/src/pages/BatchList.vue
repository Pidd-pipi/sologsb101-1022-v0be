<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Delete, Document, Edit, Histogram, Plus } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar, { type FilterModel } from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useFormulaStore } from '@/stores/formulaStore'
import { useMaterialStore } from '@/stores/materialStore'
import { useProportionStore } from '@/stores/proportionStore'
import { useCellarStore } from '@/stores/cellarStore'
import { useStockStore } from '@/stores/stockStore'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useProportion } from '@/hooks/useProportion'
import { db } from '@/utils/db'
import { round } from '@/utils/ratio'
import { StockShortageError, STOCK_UNIT } from '@/types/stock'
import {
  FORMING_METHODS,
  createEmptyBatchFilter,
  type Batch,
  type BatchFilterState,
  type BatchRow,
  type BatchSnapshotItem,
  type FormingMethod
} from '@/types/batch'

const route = useRoute()
const router = useRouter()
const formulaStore = useFormulaStore()
const materialStore = useMaterialStore()
const proportionStore = useProportionStore()
const cellarStore = useCellarStore()
const stockStore = useStockStore()
const batchTable = useIdbTable<Batch>((database) => database.batches)
/** 用 useProportion 校验和香前的配比合计，避免用未平衡的方子开批次 */
const { rows: selectedProportionRows, total: selectedRatioTotal, checkLevel, checkMessage } = useProportion()

const filter = ref<BatchFilterState>(createEmptyBatchFilter())
const dialogVisible = ref(false)
const detailVisible = ref(false)
const submitting = ref(false)
const editingId = ref<string | null>(null)
const formRef = ref<FormInstance>()
const detailBatchId = ref<string | null>(null)

const form = reactive<{
  formulaId: string
  mixedAt: string
  formingMethod: FormingMethod
  quantity: number
  operator: string
}>({
  formulaId: '',
  mixedAt: new Date().toISOString().slice(0, 10),
  formingMethod: '挤条',
  quantity: 100,
  operator: ''
})

const rules: FormRules = {
  formulaId: [{ required: true, message: '请选择香方', trigger: 'change' }],
  mixedAt: [{ required: true, message: '请选择和香日期', trigger: 'change' }],
  formingMethod: [{ required: true, message: '请选择成型方式', trigger: 'change' }],
  quantity: [
    { required: true, message: '请填写数量', trigger: 'blur' },
    {
      validator: (_rule, value: number, callback: (error?: Error) => void) => {
        if (!Number.isFinite(value) || value <= 0) callback(new Error('数量需大于 0'))
        else callback()
      },
      trigger: 'blur'
    }
  ],
  operator: [{ required: true, message: '请填写制香人', trigger: 'blur' }]
}

const formulaOptions = computed(() =>
  formulaStore.formulas.map((formula) => ({
    label: `${formula.name}（${formula.scentType} · 配比合计 ${round(formula.totalRatio, 2)}%）`,
    value: formula.id
  }))
)

const filterModel = computed<FilterModel>(() => ({
  keyword: filter.value.keyword,
  formula: filter.value.formulas,
  forming: filter.value.formingMethods
}))

const filterSelects = computed(() => [
  {
    key: 'formula',
    label: '香方',
    options: formulaStore.formulas.map((formula) => ({ label: formula.name, value: formula.id }))
  },
  { key: 'forming', label: '成型方式', options: FORMING_METHODS.map((item) => ({ label: item, value: item })) }
])

function pushQuery(): void {
  const query: Record<string, string> = {}
  if (filter.value.keyword.trim()) query.kw = filter.value.keyword.trim()
  if (filter.value.formulas.length) query.formula = filter.value.formulas.join(',')
  if (filter.value.formingMethods.length) query.forming = filter.value.formingMethods.join(',')
  void router.replace({ query })
}

function toArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item))
  if (typeof value === 'string' && value.length > 0) return value.split(',').filter((item) => item.length > 0)
  return []
}

function readQuery(): void {
  const query = route.query
  filter.value = {
    keyword: typeof query.kw === 'string' ? query.kw : '',
    formulas: toArray(query.formula),
    formingMethods: toArray(query.forming).filter((item): item is FormingMethod =>
      (FORMING_METHODS as string[]).includes(item)
    )
  }
}

if (Object.keys(route.query).length > 0) readQuery()

watch(
  () => route.query,
  (query) => {
    if (Object.keys(query).length === 0 && hasFilter.value) {
      filter.value = createEmptyBatchFilter()
      return
    }
    readQuery()
  }
)

const hasFilter = computed(
  () =>
    filter.value.keyword.trim().length > 0 ||
    filter.value.formulas.length > 0 ||
    filter.value.formingMethods.length > 0
)

const rows = computed<BatchRow[]>(() =>
  batchTable.rows.value.map((batch) => {
    const currentRatioTotal = proportionStore.totalByFormula[batch.formulaId] ?? 0
    const snapshotRatioTotal = round(
      batch.snapshot.reduce((sum, item) => sum + item.ratio, 0),
      2
    )
    const cellars = cellarStore.cellarsOfBatch(batch.id)
    const stockLines = stockStore.linesOfBatch(batch.id)
    return {
      batch,
      formulaName: formulaStore.formulaName(batch.formulaId),
      snapshotCount: batch.snapshot.length,
      currentRatioTotal,
      snapshotRatioTotal,
      cellared: cellars.length > 0,
      cellarState: cellars.length === 0 ? '未入窖' : cellars.map((cellar) => cellar.state).join(' / '),
      stockLines
    }
  })
)

const filteredRows = computed<BatchRow[]>(() =>
  rows.value.filter((row) => {
    const keyword = filter.value.keyword.trim()
    if (keyword.length > 0) {
      const haystack = `${row.formulaName}${row.batch.formingMethod}${row.batch.operator}${row.batch.mixedAt}`
      if (!haystack.includes(keyword)) return false
    }
    if (filter.value.formulas.length > 0 && !filter.value.formulas.includes(row.batch.formulaId)) return false
    if (filter.value.formingMethods.length > 0 && !filter.value.formingMethods.includes(row.batch.formingMethod))
      return false
    return true
  })
)

const totalQuantity = computed(() => filteredRows.value.reduce((sum, row) => sum + row.batch.quantity, 0))
const cellaredCount = computed(() => rows.value.filter((row) => row.cellared).length)
const driftedCount = computed(() =>
  rows.value.filter((row) => Math.abs(row.currentRatioTotal - row.snapshotRatioTotal) > 0.01).length
)
const averageQuantity = computed(() =>
  rows.value.length === 0 ? 0 : Math.round(rows.value.reduce((sum, row) => sum + row.batch.quantity, 0) / rows.value.length)
)

const detailRow = computed<BatchRow | null>(() => rows.value.find((row) => row.batch.id === detailBatchId.value) ?? null)

/** 香方 id → 配比味数，用于快照对照时回显 */
const proportionCountMap = computed<Record<string, number>>(() => proportionStore.materialCountMap)

/** 对照快照与当前方子：返回差异说明文案 */
function snapshotDiff(item: BatchSnapshotItem, row: BatchRow): string {
  const currentItem = proportionStore
    .proportionsByFormula(row.batch.formulaId)
    .find((proportion) => proportion.materialId === item.materialId)
  if (!currentItem) return '已从方中移除'
  const delta = round(currentItem.ratio - item.ratio, 2)
  if (delta === 0) return '与当前一致'
  return `当前 ${currentItem.ratio}%（${delta > 0 ? '+' : ''}${delta}%）`
}

function handleFilterChange(value: FilterModel): void {
  filter.value = {
    keyword: value.keyword,
    formulas: Array.isArray(value.formula) ? (value.formula as string[]) : [],
    formingMethods: Array.isArray(value.forming) ? (value.forming as FormingMethod[]) : []
  }
  pushQuery()
}

function handleReset(): void {
  filter.value = createEmptyBatchFilter()
  pushQuery()
}

async function buildSnapshot(formulaId: string): Promise<BatchSnapshotItem[]> {
  const proportions = proportionStore.proportionsByFormula(formulaId)
  if (proportions.length > 0) {
    return proportions
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .map((proportion) => ({
        materialId: proportion.materialId,
        materialName: materialStore.materialName(proportion.materialId),
        ratio: round(proportion.ratio, 2),
        role: proportion.role
      }))
  }
  const list = await db.proportions.where('formulaId').equals(formulaId).toArray()
  return list.map((proportion) => ({
    materialId: proportion.materialId,
    materialName: materialStore.materialName(proportion.materialId),
    ratio: round(proportion.ratio, 2),
    role: proportion.role
  }))
}

function openCreate(): void {
  editingId.value = null
  form.formulaId = formulaStore.currentFormulaId ?? formulaStore.formulas[0]?.id ?? ''
  form.mixedAt = new Date().toISOString().slice(0, 10)
  form.formingMethod = '挤条'
  form.quantity = 100
  form.operator = ''
  dialogVisible.value = true
}

function openEdit(batch: Batch): void {
  editingId.value = batch.id
  form.formulaId = batch.formulaId
  form.mixedAt = batch.mixedAt
  form.formingMethod = batch.formingMethod
  form.quantity = batch.quantity
  form.operator = batch.operator
  dialogVisible.value = true
}

function shortageText(error: unknown): string {
  if (error instanceof StockShortageError) {
    return error.shortages.map((item) => `${item.materialName} 差 ${item.short}${STOCK_UNIT}`).join('；')
  }
  return error instanceof Error ? error.message : '库存核对失败'
}

/** 开批预留预览：按当前配比 × 数量折出每味料与库存缺口，供对话框实时展示 */
const reservePreview = computed(() => {
  if (!form.formulaId) return { items: [] as Array<{ name: string; amount: number; available: number; short: number }>, shortages: [] as Array<{ name: string; short: number }> }
  const proportions = proportionStore.proportionsByFormula(form.formulaId)
  const items = proportions.map((proportion) => {
    const material = materialStore.materialById(proportion.materialId)
    const occupancy = stockStore.occupancy(proportion.materialId)
    const capacity = typeof material?.stock === 'number' ? material.stock : 0
    const amount = round((form.quantity * proportion.ratio) / 100, 2)
    // 编辑本批时，本批现有台账不计入占用
    const selfLines = editingId.value ? stockStore.linesOfBatch(editingId.value) : []
    const selfAmount = round(
      selfLines.filter((line) => line.materialId === proportion.materialId).reduce((sum, line) => sum + line.amount, 0),
      2
    )
    const available = round(capacity - (occupancy.occupied - selfAmount), 2)
    return { name: material?.name ?? '未知香料', amount, available, short: round(amount - available, 2) }
  })
  const shortages = items.filter((item) => item.short > 0.01)
  return { items, shortages }
})

/** 缺料提示文案：说清缺哪几味、差多少 */
const shortageSummary = computed(() =>
  reservePreview.value.shortages.map((item) => `${item.name} 差 ${item.short}${STOCK_UNIT}`).join('；')
)

async function submitForm(): Promise<void> {
  if (!formRef.value) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    if (editingId.value) {
      const batchId = editingId.value
      // 已入窖批次用料锁死：香方、数量都不能改，只允许改日期/成型/制香人
      const locked = stockStore.linesOfBatch(batchId).some((line) => line.status !== 'reserved')
      const original = batchTable.rows.value.find((item) => item.id === batchId)
      if (original && locked && (original.quantity !== form.quantity || original.formulaId !== form.formulaId)) {
        ElMessage.error('该批次已入窖，用料锁成开批那份，香方与数量不能再改')
        return
      }
      const formulaChanged = Boolean(original && original.formulaId !== form.formulaId)
      const quantityChanged = Boolean(original && original.quantity !== form.quantity)
      const needReserve = formulaChanged || quantityChanged

      // 香方变了用新香方快照，数量变了沿用原快照；先算好新预留再决定是否落库
      const newSnapshot = formulaChanged ? await buildSnapshot(form.formulaId) : original?.snapshot ?? []

      if (needReserve && newSnapshot.length > 0 && original) {
        try {
          // 先按新值试算预留（事务内核对最新库存），成功后再改批次
          await stockStore.resizeBatch({
            batch: { id: batchId, formulaId: form.formulaId, quantity: original.quantity },
            snapshot: newSnapshot,
            quantity: form.quantity
          })
        } catch (error) {
          // 库存撑不住：批次与预留都维持原样，表单留草稿，按最新余量重试
          ElMessageBox.alert(
            `库存撑不住，已整批拒绝并保持原批次与预留：${shortageText(error)}。表单已保留为草稿，可调小数量或补库存后重试。`,
            '调整被拒绝',
            { type: 'warning', confirmButtonText: '知道了' }
          )
          return
        }
      }

      await db.batches.update(batchId, {
        formulaId: form.formulaId,
        mixedAt: form.mixedAt,
        formingMethod: form.formingMethod,
        quantity: form.quantity,
        operator: form.operator.trim(),
        // 换香方时快照一并换成新方的，缺配比则留空待核对
        ...(formulaChanged ? { snapshot: newSnapshot, snapshotAt: Date.now() } : {})
      })

      // 换到一个没有配比的香方：清空该批台账，留空待核对
      if (formulaChanged && newSnapshot.length === 0) {
        await stockStore.removeLinesOfBatch(batchId)
      }

      if (quantityChanged && !formulaChanged) {
        ElMessage.success('批次已更新，多占的用料已按实到退回、少占的已补占')
      } else if (formulaChanged) {
        ElMessage.success(
          newSnapshot.length > 0 ? '批次已转到新香方，预留已按新配比重算' : '批次已转香方；新方缺配比，用料账留空待核对'
        )
      } else {
        ElMessage.success('批次已更新')
      }
    } else {
      const snapshot = await buildSnapshot(form.formulaId)
      if (snapshot.length === 0) {
        ElMessage.warning('该香方还没有配比，批次可先保存但用料账留空，待配比核对后再补预留')
      }
      // 先建批次再预留；预留失败（库存不足或被另一标签页抢先）则删除批次，整批拒绝
      const batch = await batchTable.create(
        {
          formulaId: form.formulaId,
          mixedAt: form.mixedAt,
          formingMethod: form.formingMethod,
          quantity: form.quantity,
          operator: form.operator.trim(),
          snapshot,
          snapshotAt: Date.now()
        },
        'batch'
      )
      if (snapshot.length > 0) {
        try {
          await stockStore.reserveForBatch({
            batch: { id: batch.id, formulaId: form.formulaId, quantity: form.quantity },
            snapshot
          })
          ElMessage.success(`已登记批次并按配比预留 ${snapshot.length} 味香料，库存撑不住时会整批拒绝`)
        } catch (error) {
          // 回滚刚建的批次，让该侧留草稿（对话框保留），按最新余量重试
          await db.batches.delete(batch.id)
          await stockStore.removeLinesOfBatch(batch.id)
          ElMessageBox.alert(
            `库存不足，本批已整批拒绝（未生成批次、未占库存）：${shortageText(error)}。表单已保留为草稿，请按最新余量调整后重试。`,
            '领料被拒绝',
            { type: 'error', confirmButtonText: '重试提交' }
          )
          return
        }
      } else {
        ElMessage.success('已生成批次，配比留空待核对后补预留')
      }
      detailBatchId.value = batch.id
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function removeBatch(row: BatchRow): Promise<void> {
  const cellars = cellarStore.cellarsOfBatch(row.batch.id)
  const confirmed = await ElMessageBox.confirm(
    `删除批次「${row.formulaName} · ${row.batch.mixedAt}」将同时删除其 ${cellars.length} 条窖藏与全部品香记录，是否继续？`,
    '删除确认',
    { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
  ).catch(() => false)
  if (!confirmed) return
  const cellarIds = cellars.map((cellar) => cellar.id)
  const tastingIds = await db.tastings.where('batchId').equals(row.batch.id).primaryKeys()
  await db.transaction(
    'rw',
    [db.batches, db.cellars, db.tastings, db.stockLines],
    async () => {
      await db.tastings.bulkDelete(tastingIds)
      await db.cellars.bulkDelete(cellarIds)
      await db.stockLines.where('batchId').equals(row.batch.id).delete()
      await db.batches.delete(row.batch.id)
    }
  )
  ElMessage.success(
    `已删除批次，连带清除窖藏 ${cellarIds.length} 条、品香 ${tastingIds.length} 条，并释放全部预留/锁定用料`
  )
}

async function refreshSnapshot(row: BatchRow): Promise<void> {
  // 已入窖批次的用料锁成当时那份，只能重算快照文案，不能动台账
  const locked = row.stockLines.some((line) => line.status !== 'reserved')
  const snapshot = await buildSnapshot(row.batch.formulaId)
  await batchTable.update(row.batch.id, { snapshot, snapshotAt: Date.now() })
  if (!locked && snapshot.length > 0) {
    try {
      await stockStore.resizeBatch({
        batch: { id: row.batch.id, formulaId: row.batch.formulaId, quantity: row.batch.quantity },
        snapshot,
        quantity: row.batch.quantity
      })
      ElMessage.success('已按当前配比重置快照并重算预留')
    } catch (error) {
      ElMessage.warning(`快照已重置，但库存撑不住新配比：${shortageText(error)}，台账维持原样`)
    }
  } else if (locked) {
    ElMessage.success('已重置快照文案；该批次已入窖，用料锁成开批那份不变')
  } else {
    ElMessage.success('已按当前配比重置快照')
  }
}

function openDetail(row: BatchRow): void {
  detailBatchId.value = row.batch.id
  detailVisible.value = true
}

function goCellar(row: BatchRow): void {
  cellarStore.patchFilter({ keyword: row.formulaName })
  void router.push('/cellar')
}

function goProportion(row: BatchRow): void {
  formulaStore.setCurrentFormula(row.batch.formulaId)
  void router.push('/proportions')
}

/** 批次折料总量：非报废台账的 amount 合计（克） */
function stockTotal(row: BatchRow): number {
  return round(
    row.stockLines.filter((line) => line.status !== 'wasted').reduce((sum, line) => sum + line.amount, 0),
    2
  )
}

/** 批次累计报损量（克） */
function stockWasted(row: BatchRow): number {
  return round(
    row.stockLines
      .filter((line) => line.status === 'wasted')
      .reduce((sum, line) => sum + line.wastedAmount, 0),
    2
  )
}

function stockStatusLabel(row: BatchRow): string {
  if (row.stockLines.some((line) => line.status === 'wasted')) return '出窖报损'
  if (row.stockLines.some((line) => line.status === 'locked')) return '入窖锁定'
  return '预留中'
}

function stockStatusTone(row: BatchRow): 'success' | 'warning' | 'info' {
  if (row.stockLines.some((line) => line.status === 'wasted')) return 'warning'
  if (row.stockLines.some((line) => line.status === 'locked')) return 'success'
  return 'info'
}
</script>

<template>
  <div>
    <div class="page-title">
      <div>
        <h2>和香工序与成型登记</h2>
        <p>
          共 {{ rows.length }} 个批次 · 已入窖 {{ cellaredCount }} 个 · 配比改动 {{ driftedCount }} 个 · 当前筛选
          {{ filteredRows.length }} 个
        </p>
      </div>
      <div class="page-title__actions">
        <el-button type="primary" :icon="Plus" @click="openCreate">登记和香批次</el-button>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="批次总数" :value="rows.length" suffix="个" icon="Box" tone="primary" />
      <StatBadge label="筛选中数量" :value="totalQuantity" suffix="支/丸" icon="Histogram" tone="info" />
      <StatBadge label="已入窖" :value="cellaredCount" suffix="个" icon="Coin" tone="success" />
      <StatBadge label="配比已改动" :value="driftedCount" suffix="个" icon="Document" tone="warning" hint="当前配比合计与批次快照不一致" />
      <StatBadge label="平均产量" :value="averageQuantity" suffix="支/丸" icon="TrendCharts" tone="default" />
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="filterSelects"
      keyword-placeholder="按香方名 / 制香人 / 和香日期搜索"
      @change="handleFilterChange"
      @reset="handleReset"
    />

    <div class="section-card batch-table">
      <div v-if="filteredRows.length === 0" class="batch-empty">
        <EmptyPanel
          title="暂无和香批次"
          :description="
            rows.length === 0
              ? '和香前先在配比页把君臣佐使调到合计 100%，再回到这里登记成型批次与制香人。'
              : '当前筛选条件下没有匹配的批次，可重置条件或登记新批次。'
          "
          action-text="登记和香批次"
          :show-seed="false"
          @action="openCreate"
        />
      </div>

      <el-table v-else :data="filteredRows" row-key="batch.id" stripe>
        <el-table-column label="香方 / 批次号" min-width="200">
          <template #default="{ row }: { row: BatchRow }">
            <div class="cell-main">{{ row.formulaName }}</div>
            <div class="cell-sub muted mono">批次 {{ row.batch.id.slice(-8) }} · 快照 {{ row.snapshotCount }} 味</div>
          </template>
        </el-table-column>
        <el-table-column label="和香日期" prop="batch.mixedAt" width="130" />
        <el-table-column label="成型方式" prop="batch.formingMethod" width="120" />
        <el-table-column label="数量" width="110">
          <template #default="{ row }: { row: BatchRow }">
            <span class="mono">{{ row.batch.quantity }}</span>
          </template>
        </el-table-column>
        <el-table-column label="用料账" min-width="170">
          <template #default="{ row }: { row: BatchRow }">
            <template v-if="row.stockLines.length > 0">
              <div class="cell-sub">
                共折料 <span class="mono">{{ stockTotal(row) }}{{ STOCK_UNIT }}</span> ·
                <el-tag
                  size="small"
                  effect="plain"
                  round
                  :type="stockStatusTone(row)"
                >{{ stockStatusLabel(row) }}</el-tag>
              </div>
              <div v-if="stockWasted(row) > 0" class="cell-sub ratio-error">
                报损 {{ stockWasted(row) }}{{ STOCK_UNIT }}
              </div>
            </template>
            <el-tooltip v-else content="该批次缺配比，用料账留空待核对" placement="top">
              <el-tag size="small" type="warning" effect="plain" round>缺配比 · 待核对</el-tag>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="制香人" prop="batch.operator" width="120" />
        <el-table-column label="配比对照" min-width="190">
          <template #default="{ row }: { row: BatchRow }">
            <div class="cell-sub">
              快照合计 <span class="mono">{{ row.snapshotRatioTotal }}%</span> · 当前合计
              <span class="mono">{{ row.currentRatioTotal }}%</span>
            </div>
            <div class="cell-sub" :class="Math.abs(row.currentRatioTotal - row.snapshotRatioTotal) > 0.01 ? 'ratio-error' : 'ratio-ok'">
              {{ Math.abs(row.currentRatioTotal - row.snapshotRatioTotal) > 0.01 ? '改方后配比已变化' : '配比与快照一致' }}
            </div>
          </template>
        </el-table-column>
        <el-table-column label="窖藏状态" width="140">
          <template #default="{ row }: { row: BatchRow }">
            <el-tag :type="row.cellared ? 'success' : 'info'" effect="plain" round>{{ row.cellarState }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="300" fixed="right">
          <template #default="{ row }: { row: BatchRow }">
            <el-button size="small" text type="primary" :icon="Document" @click="openDetail(row)">快照对照</el-button>
            <el-button size="small" text @click="goCellar(row)">窖藏</el-button>
            <el-button size="small" text :icon="Edit" @click="openEdit(row.batch)">编辑</el-button>
            <el-button size="small" text type="danger" :icon="Delete" @click="removeBatch(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑和香批次' : '登记和香批次'" width="580px" append-to-body>
      <el-form ref="formRef" :model="form" :rules="rules" label-width="104px">
        <el-form-item label="香方" prop="formulaId">
          <el-select v-model="form.formulaId" filterable placeholder="选择香方" style="width: 100%">
            <el-option v-for="item in formulaOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="和香日期" prop="mixedAt">
          <el-date-picker
            v-model="form.mixedAt"
            type="date"
            value-format="YYYY-MM-DD"
            style="width: 100%"
            placeholder="选择和香日期"
          />
        </el-form-item>
        <el-form-item label="成型方式" prop="formingMethod">
          <el-radio-group v-model="form.formingMethod">
            <el-radio v-for="item in FORMING_METHODS" :key="item" :value="item">{{ item }}</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="数量" prop="quantity">
          <el-input-number v-model="form.quantity" :min="1" :max="99999" :step="10" style="width: 200px" />
          <span class="muted form-hint">支 / 丸 / 饼</span>
        </el-form-item>
        <el-form-item label="制香人" prop="operator">
          <el-input v-model="form.operator" placeholder="如：林砚舟" maxlength="20" />
        </el-form-item>
        <el-alert
          v-if="form.formulaId"
          class="ratio-alert"
          :type="checkLevel === 'ok' ? 'success' : checkLevel === 'warn' ? 'warning' : 'error'"
          :closable="false"
          show-icon
          :title="`当前方子配比：${selectedRatioTotal}%（${selectedProportionRows.length} 味）`"
          :description="checkMessage"
        />
        <div v-if="form.formulaId" class="reserve-box">
          <div class="reserve-box__head">
            <span>按配比 × 数量折料预留（本地库存）</span>
            <el-tag v-if="reservePreview.shortages.length > 0" type="error" effect="dark" size="small">
              库存不足，整批将被拒绝
            </el-tag>
            <el-tag v-else-if="reservePreview.items.length > 0" type="success" effect="plain" size="small">
              库存可满足
            </el-tag>
            <el-tag v-else type="warning" effect="plain" size="small">缺配比，先留空待核对</el-tag>
          </div>
          <el-table v-if="reservePreview.items.length > 0" :data="reservePreview.items" size="small" row-key="name">
            <el-table-column label="香料" prop="name" min-width="110" />
            <el-table-column label="本批用量" width="110">
              <template #default="{ row }: { row: { amount: number } }">
                <span class="mono">{{ row.amount }}{{ STOCK_UNIT }}</span>
              </template>
            </el-table-column>
            <el-table-column label="当前可用" width="110">
              <template #default="{ row }: { row: { available: number } }">
                <span class="mono" :class="row.available < 0 ? 'ratio-error' : ''">{{ row.available }}{{ STOCK_UNIT }}</span>
              </template>
            </el-table-column>
            <el-table-column label="缺口" min-width="100">
              <template #default="{ row }: { row: { short: number } }">
                <span v-if="row.short > 0.01" class="ratio-error mono">差 {{ row.short }}{{ STOCK_UNIT }}</span>
                <span v-else class="ratio-ok">够</span>
              </template>
            </el-table-column>
          </el-table>
          <p v-if="shortageSummary" class="reserve-box__short">{{ shortageSummary }}</p>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存修改' : '生成批次并固化快照' }}
        </el-button>
      </template>
    </el-dialog>

    <el-drawer v-model="detailVisible" title="配比快照对照" size="520px" append-to-body>
      <template v-if="detailRow">
        <div class="snapshot-head">
          <h3>{{ detailRow.formulaName }}</h3>
          <p class="muted">
            和香 {{ detailRow.batch.mixedAt }} · {{ detailRow.batch.formingMethod }} · {{ detailRow.batch.quantity }} 支 ·
            {{ detailRow.batch.operator }}
          </p>
          <p class="muted">快照固化于 {{ new Date(detailRow.batch.snapshotAt || Date.now()).toLocaleString('zh-CN') }}</p>
        </div>

        <div class="snapshot-badges">
          <StatBadge label="快照合计" :value="detailRow.snapshotRatioTotal" suffix="%" size="small" icon="Histogram" tone="info" />
          <StatBadge label="当前合计" :value="detailRow.currentRatioTotal" suffix="%" size="small" icon="Histogram" tone="primary" />
          <StatBadge
            label="当前味数"
            :value="proportionCountMap[detailRow.batch.formulaId] ?? 0"
            suffix="味"
            size="small"
            icon="Files"
            tone="default"
          />
        </div>

        <el-table :data="detailRow.batch.snapshot" size="small" row-key="materialId">
          <el-table-column label="香料" prop="materialName" min-width="120" />
          <el-table-column label="角色" prop="role" width="70" />
          <el-table-column label="快照占比" width="100">
            <template #default="{ row }: { row: BatchSnapshotItem }">
              <span class="mono">{{ row.ratio }}%</span>
            </template>
          </el-table-column>
          <el-table-column label="与当前对比" min-width="140">
            <template #default="{ row }: { row: BatchSnapshotItem }">
              <span class="cell-sub">{{ snapshotDiff(row, detailRow) }}</span>
            </template>
          </el-table-column>
        </el-table>

        <div class="snapshot-actions">
          <el-button :icon="Document" @click="refreshSnapshot(detailRow)">按当前配比重置快照</el-button>
          <el-button :icon="Histogram" @click="goProportion(detailRow)">去改配比</el-button>
        </div>
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.batch-table {
  margin-top: 16px;
}

.batch-empty {
  padding: 8px 0;
}

.cell-main {
  font-weight: 600;
}

.cell-sub {
  font-size: 12px;
  line-height: 1.6;
}

.form-hint {
  margin-left: 10px;
  font-size: 12px;
}

.ratio-alert {
  margin-bottom: 12px;
}

.reserve-box {
  margin: 4px 0 12px;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: var(--el-fill-color-blank);
}

.reserve-box__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 600;
}

.reserve-box__short {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--el-color-danger);
}

.snapshot-head h3 {
  margin: 0 0 4px;
}

.snapshot-head p {
  margin: 0 0 4px;
  font-size: 12px;
}

.snapshot-badges {
  display: flex;
  gap: 8px;
  margin: 12px 0;
}

.snapshot-actions {
  display: flex;
  gap: 8px;
  margin-top: 16px;
}
</style>
