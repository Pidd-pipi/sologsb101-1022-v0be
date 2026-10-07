<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Delete, Document, Edit, Histogram, Plus, RefreshRight } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar, { type FilterModel } from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useFormulaStore } from '@/stores/formulaStore'
import { useMaterialStore } from '@/stores/materialStore'
import { useProportionStore } from '@/stores/proportionStore'
import { useCellarStore } from '@/stores/cellarStore'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useProportion } from '@/hooks/useProportion'
import { db, createId } from '@/utils/db'
import { round } from '@/utils/ratio'
import {
  createBatchWithUsage,
  isLedgerEmpty,
  previewCapacity,
  recalcLedger,
  updateBatchQuantity
} from '@/utils/materialLedger'
import {
  DEFAULT_BASIS_PER_UNIT,
  FORMING_METHODS,
  createEmptyBatchFilter,
  type Batch,
  type BatchFilterState,
  type BatchMaterialLedger,
  type BatchRow,
  type BatchSnapshotItem,
  type FormingMethod,
  type MaterialCommitResult
} from '@/types/batch'
import type { Material } from '@/types/material'

const route = useRoute()
const router = useRouter()
const formulaStore = useFormulaStore()
const materialStore = useMaterialStore()
const proportionStore = useProportionStore()
const cellarStore = useCellarStore()
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

/** 容量预检结果（按最新余量实时计算），表单内逐味展示用量与缺口 */
const capacityCheck = ref<MaterialCommitResult>({ ok: true, shortages: [], message: '' })
const capacityChecking = ref(false)
/** 被整批拒绝后保留的草稿：用户改小数量或补库存后按最新余量重试 */
const draftRejected = ref(false)
let capacitySeq = 0

const materialMap = computed(() => {
  const map = new Map<string, Material>()
  materialStore.materials.forEach((material) => map.set(material.id, material))
  return map
})

/** 表单当前（香方 × 数量）折算的逐味用料账 */
const draftLedger = computed<BatchMaterialLedger>(() => {
  if (!form.formulaId) return { basisPerUnit: DEFAULT_BASIS_PER_UNIT, items: [] }
  return recalcLedger({
    ledger: { basisPerUnit: DEFAULT_BASIS_PER_UNIT, items: [] },
    proportions: proportionStore.proportionsByFormula(form.formulaId),
    materialMap: materialMap.value,
    quantity: form.quantity
  })
})

async function refreshCapacityCheck(): Promise<void> {
  if (!form.formulaId || form.quantity <= 0) {
    capacityCheck.value = { ok: true, shortages: [], message: '' }
    return
  }
  const seq = ++capacitySeq
  capacityChecking.value = true
  try {
    const result = await previewCapacity({
      proportions: proportionStore.proportionsByFormula(form.formulaId),
      materialMap: materialMap.value,
      quantity: form.quantity,
      excludeBatchId: editingId.value
    })
    if (seq === capacitySeq) capacityCheck.value = result
  } finally {
    if (seq === capacitySeq) capacityChecking.value = false
  }
}

watch(
  () => [form.formulaId, form.quantity, materialStore.materials.length, materialStore.batches.length, materialStore.cellars.length],
  () => {
    draftRejected.value = false
    void refreshCapacityCheck()
  }
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
    return {
      batch,
      formulaName: formulaStore.formulaName(batch.formulaId),
      snapshotCount: batch.snapshot.length,
      currentRatioTotal,
      snapshotRatioTotal,
      cellared: cellars.length > 0,
      cellarState: cellars.length === 0 ? '未入窖' : cellars.map((cellar) => cellar.state).join(' / ')
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
  draftRejected.value = false
  dialogVisible.value = true
  void refreshCapacityCheck()
}

function openEdit(batch: Batch): void {
  editingId.value = batch.id
  form.formulaId = batch.formulaId
  form.mixedAt = batch.mixedAt
  form.formingMethod = batch.formingMethod
  form.quantity = batch.quantity
  form.operator = batch.operator
  draftRejected.value = false
  dialogVisible.value = true
  void refreshCapacityCheck()
}

async function submitForm(): Promise<void> {
  if (!formRef.value) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    if (editingId.value) {
      if (editingCellared.value) {
        // 入窖批次：只允许改和香日期 / 成型方式 / 制香人，香方与数量锁死
        await batchTable.update(editingId.value, {
          mixedAt: form.mixedAt,
          formingMethod: form.formingMethod,
          operator: form.operator.trim()
        })
        ElMessage.success('批次已更新；该批已入窖，用料锁成当时那份，数量不可改')
        dialogVisible.value = false
        return
      }
      const result = await updateBatchQuantity({
        batchId: editingId.value,
        quantity: form.quantity,
        patch: {
          formulaId: form.formulaId,
          mixedAt: form.mixedAt,
          formingMethod: form.formingMethod,
          operator: form.operator.trim()
        },
        proportions: proportionStore.proportionsByFormula(form.formulaId),
        materialMap: materialMap.value
      })
      if (!result.ok) {
        // 容量撑不住：整批拒绝，保留原数量，表单留草稿按最新余量重试
        capacityCheck.value = result
        draftRejected.value = true
        ElMessage.error(result.message)
        return
      }
      ElMessage.success('批次已更新，多占用料已按实到数量退回库存')
    } else {
      const snapshot = await buildSnapshot(form.formulaId)
      const ledger = recalcLedger({
        ledger: { basisPerUnit: DEFAULT_BASIS_PER_UNIT, items: [] },
        proportions: proportionStore.proportionsByFormula(form.formulaId),
        materialMap: materialMap.value,
        quantity: form.quantity
      })
      const batchRecord: Omit<Batch, 'updatedAt'> = {
        id: createId('batch'),
        formulaId: form.formulaId,
        mixedAt: form.mixedAt,
        formingMethod: form.formingMethod,
        quantity: form.quantity,
        operator: form.operator.trim(),
        snapshot,
        snapshotAt: Date.now(),
        materialUsage: ledger
      }
      const { batch, result } = await createBatchWithUsage({ batch: batchRecord })
      if (!result.ok) {
        // 容量不足或另一标签页抢先预留：本侧留草稿，按最新余量重试
        capacityCheck.value = result
        draftRejected.value = true
        ElMessage.error(result.message)
        return
      }
      ElMessage.success(`已预留 ${ledger.items.filter((item) => !item.pending).length} 味香料并生成批次，自动固化配比快照`)
      detailBatchId.value = batch.id
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

/** 拒绝后按最新余量重新预检（用户改小数量 / 补完库存后点） */
function retryWithLatestBalance(): void {
  draftRejected.value = false
  void refreshCapacityCheck().then(() => {
    if (capacityCheck.value.ok) ElMessage.success('最新余量已足够，可再次提交')
    else ElMessage.warning(capacityCheck.value.message)
  })
}

/** 批次行上的预留合计（未锁定、非待核对的味） */
function rowReservedAmount(row: BatchRow): number {
  return round(
    row.batch.materialUsage.items
      .filter((item) => !item.locked && !item.pending)
      .reduce((sum, item) => sum + item.requiredAmount, 0),
    2
  )
}

function rowPendingCount(row: BatchRow): number {
  return row.batch.materialUsage.items.filter((item) => item.pending).length
}

/** 表单草稿里某味对应的缺口 */
function shortageOf(materialId: string) {
  return capacityCheck.value.shortages.find((item) => item.materialId === materialId)
}

/** 编辑中的批次是否已入窖（入窖后用料锁定，数量 / 香方不再允许改动） */
const editingCellared = computed(() => {
  if (!editingId.value) return false
  const batch = batchTable.rows.value.find((item) => item.id === editingId.value)
  if (!batch) return false
  return cellarStore.cellarsOfBatch(batch.id).length > 0
})

/** 编辑中的批次自身当前对某味的预留（预检已排除自身，显示余量时要加回来） */
function rowBatchCurrentReserved(materialId: string): number {
  if (!editingId.value) return 0
  const current = batchTable.rows.value.find((batch) => batch.id === editingId.value)
  if (!current || isLedgerEmpty(current.materialUsage)) return 0
  return round(
    current.materialUsage.items
      .filter((item) => !item.pending && item.materialId === materialId)
      .reduce((sum, item) => sum + item.requiredAmount, 0),
    2
  )
}

/** 表单草稿某味展示用的当前余量（不缺时） */
function availableForDraft(materialId: string): number {
  const material = materialStore.materialById(materialId)
  const stock = material?.stock ?? 0
  const reservedByOthers = (materialStore.reservedByMaterial[materialId] ?? 0) - rowBatchCurrentReserved(materialId)
  return round(Math.max(stock - reservedByOthers, 0), 2)
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
  const writeBackTotal = round(
    row.batch.materialUsage.items.reduce((sum, item) => sum + (item.writeBackAmount ?? 0), 0),
    2
  )
  // 已出窖批次曾按报废回冲进库存的料，随批次删除一并核销（不重复留在库存里）
  await db.transaction('rw', [db.batches, db.cellars, db.tastings, db.materials], async () => {
    if (writeBackTotal > 0 || cellarIds.length > 0) {
      for (const item of row.batch.materialUsage.items) {
        if (!item.writeBackAmount || item.writeBackAmount <= 0) continue
        const material = await db.materials.get(item.materialId)
        if (!material) continue
        const stock = round((Number.isFinite(material.stock) ? material.stock : 0) - item.writeBackAmount, 2)
        await db.materials.update(item.materialId, { stock: Math.max(stock, 0), updatedAt: Date.now() })
      }
    }
    await db.tastings.bulkDelete(tastingIds)
    await db.cellars.bulkDelete(cellarIds)
    await db.batches.delete(row.batch.id)
  })
  ElMessage.success(
    `已删除批次，连带清除窖藏 ${cellarIds.length} 条、品香 ${tastingIds.length} 条` +
      (writeBackTotal > 0 ? `，核销已回冲库存 ${writeBackTotal}` : '')
  )
}

async function refreshSnapshot(row: BatchRow): Promise<void> {
  const snapshot = await buildSnapshot(row.batch.formulaId)
  // 已入窖批次的用料锁成当时那份，只重置配比快照展示，不动用料账
  if (row.cellared) {
    await batchTable.update(row.batch.id, { snapshot, snapshotAt: Date.now() })
    ElMessage.warning('该批次已入窖，用料已锁定，仅更新配比快照展示')
    return
  }
  const ledger = recalcLedger({
    ledger: row.batch.materialUsage,
    proportions: proportionStore.proportionsByFormula(row.batch.formulaId),
    materialMap: materialMap.value,
    quantity: row.batch.quantity
  })
  await db.batches.update(row.batch.id, { snapshot, snapshotAt: Date.now(), materialUsage: ledger })
  ElMessage.success('已按当前配比重算预留并重置快照')
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
        <el-table-column label="和香日期" prop="batch.mixedAt" width="120" />
        <el-table-column label="成型方式" prop="batch.formingMethod" width="100" />
        <el-table-column label="数量" width="90">
          <template #default="{ row }: { row: BatchRow }">
            <span class="mono">{{ row.batch.quantity }}</span>
          </template>
        </el-table-column>
        <el-table-column label="制香人" prop="batch.operator" width="100" />
        <el-table-column label="用料账" min-width="200">
          <template #default="{ row }: { row: BatchRow }">
            <div v-if="isLedgerEmpty(row.batch.materialUsage)" class="cell-sub ratio-warn">缺配比，用料账留空待核对</div>
            <template v-else>
              <div class="cell-sub">
                <el-tag v-if="row.cellared" size="small" type="warning" effect="plain" round>入窖锁定</el-tag>
                <el-tag v-else size="small" type="success" effect="plain" round>预留中 {{ rowReservedAmount(row) }}</el-tag>
                <span class="muted">共 {{ row.batch.materialUsage.items.length }} 味</span>
              </div>
              <div v-if="rowPendingCount(row) > 0" class="cell-sub ratio-warn">
                {{ rowPendingCount(row) }} 味缺配比待核对
              </div>
              <div v-if="row.cellared" class="cell-sub muted mono">
                用料合计 {{ round(row.batch.materialUsage.items.reduce((s, i) => s + i.requiredAmount, 0), 2) }}
              </div>
            </template>
          </template>
        </el-table-column>
        <el-table-column label="窖藏状态" width="120">
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
          <el-select v-model="form.formulaId" filterable placeholder="选择香方" style="width: 100%" :disabled="editingCellared">
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
          <el-input-number
            v-model="form.quantity"
            :min="1"
            :max="99999"
            :step="10"
            :disabled="editingCellared"
            style="width: 200px"
          />
          <span class="muted form-hint">支 / 丸 / 饼</span>
          <span v-if="editingCellared" class="cell-sub ratio-warn">已入窖锁定，数量不可改（多占亦不退回）</span>
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
        <el-alert
          v-if="draftRejected && !capacityCheck.ok"
          class="ratio-alert"
          type="error"
          show-icon
          :closable="false"
          title="库存容量不足，本批未预留（草稿已保留）"
          :description="capacityCheck.message"
        >
          <template #default>
            <div>{{ capacityCheck.message }}</div>
            <el-button class="retry-btn" size="small" type="primary" plain :icon="RefreshRight" @click="retryWithLatestBalance">
              按最新余量重试
            </el-button>
          </template>
        </el-alert>
        <div v-if="form.formulaId && draftLedger.items.length > 0" class="usage-preview">
          <div class="usage-preview__head">
            <span>本批用料（配比 × {{ form.quantity }} 件）</span>
            <el-tag
              size="small"
              :type="capacityCheck.ok ? 'success' : 'danger'"
              effect="plain"
              round
            >
              {{ capacityChecking ? '核对余量中…' : capacityCheck.ok ? '本地库存可预留' : `缺 ${capacityCheck.shortages.length} 味` }}
            </el-tag>
          </div>
          <el-table :data="draftLedger.items" size="small" row-key="materialId" border>
            <el-table-column label="香料" prop="materialName" min-width="110" />
            <el-table-column label="角色" prop="role" width="56" />
            <el-table-column label="占比" width="68">
              <template #default="{ row }">{{ row.ratio }}%</template>
            </el-table-column>
            <el-table-column label="领用" width="92">
              <template #default="{ row }">
                <span class="mono">{{ row.requiredAmount }}{{ row.unit }}</span>
              </template>
            </el-table-column>
            <el-table-column label="库存 / 余量" min-width="130">
              <template #default="{ row }">
                <template v-if="row.pending">
                  <span class="ratio-warn">缺配比待核对</span>
                </template>
                <template v-else>
                  <div class="cell-sub mono">
                    库存 {{ shortageOf(row.materialId)?.stock ?? materialStore.materialById(row.materialId)?.stock ?? 0 }}{{ row.unit }}
                    · 余 <span :class="shortageOf(row.materialId) ? 'ratio-error' : 'ratio-ok'">
                      {{ shortageOf(row.materialId)?.available ?? availableForDraft(row.materialId) }}
                    </span>
                  </div>
                  <div v-if="shortageOf(row.materialId)" class="cell-sub ratio-error">
                    差 {{ shortageOf(row.materialId)?.shortAmount }}{{ row.unit }}
                    <span class="muted">（它批已留 {{ shortageOf(row.materialId)?.reservedByOthers }}{{ row.unit }}）</span>
                  </div>
                </template>
              </template>
            </el-table-column>
          </el-table>
          <p class="cell-sub muted usage-preview__note">
            先按本地库存预留：入窖前可随改方 / 改数量重算，入窖后锁成当时那份，出窖报废再按损耗回冲。
          </p>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button
          v-if="draftRejected"
          type="warning"
          plain
          :icon="RefreshRight"
          :loading="capacityChecking"
          @click="retryWithLatestBalance"
        >
          按最新余量重试
        </el-button>
        <el-button
          type="primary"
          :loading="submitting"
          :disabled="!capacityCheck.ok"
          @click="submitForm"
        >
          {{ editingId ? '保存修改（多占退回 / 少占补留）' : '生成批次并预留库存' }}
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

        <template v-if="!isLedgerEmpty(detailRow.batch.materialUsage)">
          <h4 class="snapshot-subtitle">用料账（{{ detailRow.cellared ? '入窖锁定' : '按当前配比预留' }}）</h4>
          <el-table :data="detailRow.batch.materialUsage.items" size="small" row-key="materialId" border>
            <el-table-column label="香料" prop="materialName" min-width="100" />
            <el-table-column label="占比" width="64">
              <template #default="{ row }">{{ row.ratio }}%</template>
            </el-table-column>
            <el-table-column label="用量" width="90">
              <template #default="{ row }">
                <span class="mono">{{ row.pending ? '—' : row.requiredAmount }}{{ row.unit }}</span>
              </template>
            </el-table-column>
            <el-table-column label="状态" min-width="120">
              <template #default="{ row }">
                <el-tag v-if="row.pending" size="small" type="info" effect="plain">缺配比待核对</el-tag>
                <el-tag v-else-if="row.locked" size="small" type="warning" effect="plain">已锁定</el-tag>
                <el-tag v-else size="small" type="success" effect="plain">预留中</el-tag>
                <span v-if="row.writeBackAmount" class="cell-sub ratio-ok">
                  出窖回冲 {{ row.writeBackAmount }}{{ row.unit }}
                </span>
              </template>
            </el-table-column>
          </el-table>
        </template>

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

.usage-preview {
  margin-top: 4px;
  border: 1px solid #e4d9c8;
  border-radius: 8px;
  padding: 10px 12px;
  background: #fdfaf4;
}

.usage-preview__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 600;
  color: #6b4a2c;
}

.usage-preview__note {
  margin: 8px 0 0;
}

.retry-btn {
  margin-top: 8px;
}

.snapshot-subtitle {
  margin: 18px 0 8px;
  font-size: 14px;
  color: #6b4a2c;
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
