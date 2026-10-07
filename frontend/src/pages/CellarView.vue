<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Bell, Delete, Edit, Plus, Sort } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar, { type FilterModel } from '@/components/common/FilterBar.vue'
import GradeTag from '@/components/common/GradeTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useCellarStore, parseDate } from '@/stores/cellarStore'
import { useFormulaStore } from '@/stores/formulaStore'
import { useStockStore } from '@/stores/stockStore'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useProportion } from '@/hooks/useProportion'
import { db } from '@/utils/db'
import { round } from '@/utils/ratio'
import { STOCK_UNIT } from '@/types/stock'
import {
  CELLAR_CONTAINERS,
  CELLAR_NEAR_DAYS,
  CELLAR_STATES,
  type Cellar,
  type CellarContainer,
  type CellarFilterState,
  type CellarRow,
  type CellarState,
  type CellarUrgency
} from '@/types/cellar'
import type { Batch, FormingMethod } from '@/types/batch'
import type { Proportion } from '@/types/proportion'

const route = useRoute()
const router = useRouter()
const cellarStore = useCellarStore()
const formulaStore = useFormulaStore()
const stockStore = useStockStore()
const batchTable = useIdbTable<Batch>((database) => database.batches, { sortByUpdatedAt: false })
const proportionTable = useIdbTable<Proportion>((database) => database.proportions, { sortByUpdatedAt: false })

const dialogVisible = ref(false)
const submitting = ref(false)
const editingId = ref<string | null>(null)
const formRef = ref<FormInstance>()

/** 出窖报废对话框 */
const scrapVisible = ref(false)
const scrapTargetId = ref<string | null>(null)
const scrapPct = ref(10)
const scrapSubmitting = ref(false)


const form = reactive<{
  batchId: string
  startDate: string
  endDate: string
  temperatureC: number
  humidityPct: number
  container: CellarContainer
  state: CellarState
}>({
  batchId: '',
  startDate: new Date().toISOString().slice(0, 10),
  endDate: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  temperatureC: 22,
  humidityPct: 60,
  container: '陶罐',
  state: '窖藏中'
})

const rules: FormRules = {
  batchId: [{ required: true, message: '请选择关联和香批次', trigger: 'change' }],
  startDate: [{ required: true, message: '请选择入窖日期', trigger: 'change' }],
  endDate: [
    { required: true, message: '请选择计划出窖日期', trigger: 'change' },
    {
      validator: (_rule, value: string, callback: (error?: Error) => void) => {
        const start = parseDate(form.startDate)
        const end = parseDate(value)
        if (Number.isFinite(start) && Number.isFinite(end) && end <= start) {
          callback(new Error('计划出窖日期需晚于入窖日期'))
        } else {
          callback()
        }
      },
      trigger: 'change'
    }
  ],
  temperatureC: [
    { required: true, message: '请填写窖藏温度', trigger: 'blur' },
    {
      validator: (_rule, value: number, callback: (error?: Error) => void) => {
        if (!Number.isFinite(value) || value < -10 || value > 50) callback(new Error('温度建议在 -10 ~ 50 ℃'))
        else callback()
      },
      trigger: 'blur'
    }
  ],
  humidityPct: [
    { required: true, message: '请填写窖藏湿度', trigger: 'blur' },
    {
      validator: (_rule, value: number, callback: (error?: Error) => void) => {
        if (!Number.isFinite(value) || value < 0 || value > 100) callback(new Error('湿度应在 0 ~ 100 %'))
        else callback()
      },
      trigger: 'blur'
    }
  ]
}

/** 入窖表单所选批次对应的香方，用于校验该方配比是否已平衡 */
const watchedFormulaId = computed(() => {
  const batch = batchTable.rows.value.find((item) => item.id === form.batchId)
  return batch?.formulaId ?? null
})
const {
  checkLevel: ratioLevel,
  checkMessage: ratioMessage,
  total: ratioTotal,
  rows: ratioRows
} = useProportion({ formulaId: watchedFormulaId })

const filterModel = computed<FilterModel>(() => ({
  keyword: cellarStore.filter.keyword,
  state: cellarStore.filter.states,
  container: cellarStore.filter.containers
}))

const filterSelects = computed(() => [
  { key: 'state', label: '状态', options: CELLAR_STATES.map((item) => ({ label: item, value: item })) },
  { key: 'container', label: '容器', options: CELLAR_CONTAINERS.map((item) => ({ label: item, value: item })) }
])

function pushQuery(): void {
  const query: Record<string, string> = {}
  const { keyword, states, containers } = cellarStore.filter
  if (keyword.trim()) query.kw = keyword.trim()
  if (states.length) query.state = states.join(',')
  if (containers.length) query.container = containers.join(',')
  if (cellarStore.sortMode === 'start') query.sort = 'start'
  void router.replace({ query })
}

function toArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item))
  if (typeof value === 'string' && value.length > 0) return value.split(',').filter((item) => item.length > 0)
  return []
}

function readQuery(): void {
  const query = route.query
  cellarStore.patchFilter({
    keyword: typeof query.kw === 'string' ? query.kw : '',
    states: toArray(query.state).filter((item): item is CellarState => (CELLAR_STATES as string[]).includes(item)),
    containers: toArray(query.container).filter((item): item is CellarContainer =>
      (CELLAR_CONTAINERS as string[]).includes(item)
    )
  })
  if (query.sort === 'start' || query.sort === 'remain') cellarStore.setSortMode(query.sort)
}

if (Object.keys(route.query).length > 0) readQuery()

watch(
  () => route.query,
  (query) => {
    if (Object.keys(query).length === 0 && cellarStore.hasFilter) {
      cellarStore.resetFilter()
      return
    }
    readQuery()
  }
)

/** 未入窖的批次，供新建窖藏时选择 */
const availableBatches = computed(() =>
  batchTable.rows.value.filter((batch) => {
    if (editingId.value && batch.id === editingId.value) return true
    return cellarStore.cellarsOfBatch(batch.id).length === 0
  })
)

const batchOptions = computed(() =>
  availableBatches.value.map((batch) => {
    const formula = formulaStore.formulaById(batch.formulaId)
    return {
      label: `${formula?.name ?? '香方已删除'} · ${batch.mixedAt} · ${batch.formingMethod} · ${batch.quantity} 支`,
      value: batch.id
    }
  })
)

/** 香方 id → 配比味数，用于批次卡片回显 */
const proportionCountMap = computed<Record<string, number>>(() => {
  const map: Record<string, number> = {}
  proportionTable.rows.value.forEach((proportion) => {
    map[proportion.formulaId] = (map[proportion.formulaId] ?? 0) + 1
  })
  return map
})

function batchFormulaMaterialCount(batchId: string): number {
  const batch = batchTable.rows.value.find((item) => item.id === batchId)
  if (!batch) return 0
  return proportionCountMap.value[batch.formulaId] ?? batch.snapshot.length
}

const rows = computed<CellarRow[]>(() => cellarStore.filteredRows)

function urgencyTone(urgency: CellarUrgency): 'success' | 'warning' | 'danger' | 'info' {
  if (urgency === 'overdue') return 'danger'
  if (urgency === 'near') return 'warning'
  if (urgency === 'done') return 'success'
  return 'info'
}

function urgencyLabel(row: CellarRow): string {
  if (row.cellar.state === '已出窖') return '已出窖'
  if (row.remainDays < 0) return `已逾期 ${Math.abs(row.remainDays)} 天`
  if (row.remainDays <= CELLAR_NEAR_DAYS) return `剩 ${row.remainDays} 天出窖`
  return `剩 ${row.remainDays} 天`
}

function handleFilterChange(value: FilterModel): void {
  const next: Partial<CellarFilterState> = {
    keyword: value.keyword,
    states: Array.isArray(value.state) ? (value.state as CellarState[]) : [],
    containers: Array.isArray(value.container) ? (value.container as CellarContainer[]) : []
  }
  cellarStore.patchFilter(next)
  pushQuery()
}

function handleReset(): void {
  cellarStore.resetFilter()
  pushQuery()
}

function changeSort(mode: 'remain' | 'start'): void {
  cellarStore.setSortMode(mode)
  pushQuery()
  ElMessage.success(mode === 'remain' ? '已按临近出窖排序' : '已按入窖日期排序')
}

function openCreate(): void {
  editingId.value = null
  const first = availableBatches.value[0]
  form.batchId = first?.id ?? ''
  form.startDate = new Date().toISOString().slice(0, 10)
  form.endDate = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  form.temperatureC = 22
  form.humidityPct = 60
  form.container = '陶罐'
  form.state = '窖藏中'
  dialogVisible.value = true
}

function openEdit(cellar: Cellar): void {
  editingId.value = cellar.id
  form.batchId = cellar.batchId
  form.startDate = cellar.startDate
  form.endDate = cellar.endDate
  form.temperatureC = cellar.temperatureC
  form.humidityPct = cellar.humidityPct
  form.container = cellar.container
  form.state = cellar.state
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!formRef.value) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    if (editingId.value) {
      await cellarStore.updateCellar(editingId.value, {
        batchId: form.batchId,
        startDate: form.startDate,
        endDate: form.endDate,
        temperatureC: form.temperatureC,
        humidityPct: form.humidityPct,
        container: form.container,
        state: form.state
      })
      ElMessage.success('窖藏环境记录已更新')
    } else {
      await cellarStore.createCellar({
        batchId: form.batchId,
        startDate: form.startDate,
        endDate: form.endDate,
        temperatureC: form.temperatureC,
        humidityPct: form.humidityPct,
        container: form.container,
        state: form.state
      })
      ElMessage.success('已登记窖藏批次，临近出窖会自动提醒')
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function advanceState(row: CellarRow): Promise<void> {
  const next = await cellarStore.advanceState(row.cellar.id)
  if (next) ElMessage.success(`「${row.formulaName}」已流转为「${next}」`)
}

/** 报废预览：该批锁定用料合计，按当前损耗比例折算损耗与完好退回 */
const scrapPreview = computed(() => {
  if (!scrapTargetId.value) return { total: 0, wasted: 0, returned: 0, lines: [] as Array<{ name: string; amount: number; wasted: number }> }
  const cellar = cellarStore.cellarById(scrapTargetId.value)
  if (!cellar) return { total: 0, wasted: 0, returned: 0, lines: [] }
  const lines = stockStore.linesOfBatch(cellar.batchId).filter((line) => line.status !== 'reserved')
  const detail = lines.map((line) => ({
    name: line.materialName,
    amount: line.amount,
    wasted: round((line.amount * scrapPct.value) / 100, 2)
  }))
  const total = round(lines.reduce((sum, line) => sum + line.amount, 0), 2)
  const wasted = round((total * scrapPct.value) / 100, 2)
  return { total, wasted, returned: round(total - wasted, 2), lines: detail }
})

function openScrap(row: CellarRow): void {
  scrapTargetId.value = row.cellar.id
  scrapPct.value = typeof row.cellar.wastePct === 'number' && row.cellar.wastePct > 0 ? row.cellar.wastePct : 10
  scrapVisible.value = true
}

async function submitScrap(): Promise<void> {
  if (!scrapTargetId.value) return
  scrapSubmitting.value = true
  try {
    const result = await cellarStore.markScrap(scrapTargetId.value, true, scrapPct.value)
    ElMessage.success(
      `已按损耗回冲：报废损耗 ${result.wasted}${STOCK_UNIT}，完好退回库存 ${result.returned}${STOCK_UNIT}`
    )
    scrapVisible.value = false
  } finally {
    scrapSubmitting.value = false
  }
}

/** 撤销报废：用料恢复为入窖锁定占用 */
async function undoScrap(row: CellarRow): Promise<void> {
  const result = await cellarStore.markScrap(row.cellar.id, false, 0)
  void result
  ElMessage.success('已撤销报废，该批用料恢复为入窖锁定占用')
}

async function updateReading(row: CellarRow, field: 'temperatureC' | 'humidityPct', value: number): Promise<void> {
  const next = round(value, 1)
  if (next === row.cellar[field]) return
  await cellarStore.updateCellar(row.cellar.id, { [field]: next } as Partial<Cellar>)
  const outOfRange = field === 'temperatureC' ? next < 18 || next > 26 : next < 50 || next > 70
  ElMessage({
    type: outOfRange ? 'warning' : 'success',
    message:
      field === 'temperatureC'
        ? `温度已记录 ${next} ℃${outOfRange ? '（超出 18~26 ℃ 建议区间）' : ''}`
        : `湿度已记录 ${next}%${outOfRange ? '（超出 50~70% 建议区间）' : ''}`
  })
}

async function removeCellar(row: CellarRow): Promise<void> {
  const confirmed = await ElMessageBox.confirm(
    `删除「${row.formulaName}」的这条窖藏记录？批次本身与品香记录会保留。`,
    '删除确认',
    { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
  ).catch(() => false)
  if (!confirmed) return
  await cellarStore.removeCellar(row.cellar.id)
  ElMessage.success('窖藏记录已删除')
}

async function releaseOverdue(): Promise<void> {
  const count = await cellarStore.releaseOverdue()
  if (count === 0) {
    ElMessage.info('当前没有逾期的在窖批次')
    return
  }
  ElMessage.success(`已将 ${count} 个逾期批次置为「已出窖」`)
}

async function goTasting(row: CellarRow): Promise<void> {
  await db.batches.update(row.cellar.batchId, { updatedAt: Date.now() })
  void router.push({ path: '/tastings', query: { batch: row.cellar.batchId } })
}

const formingText = (batchId: string): FormingMethod | '—' =>
  batchTable.rows.value.find((batch) => batch.id === batchId)?.formingMethod ?? '—'
</script>

<template>
  <div>
    <div class="page-title">
      <div>
        <h2>窖藏批次与环境</h2>
        <p>
          共 {{ cellarStore.cellars.length }} 条窖藏记录 · 在窖 {{ cellarStore.agingCount }} 个 · 待提醒
          {{ cellarStore.alerts.length }} 个 · 均温 {{ cellarStore.averageTemperature }} ℃ / 均湿
          {{ cellarStore.averageHumidity }}%
        </p>
      </div>
      <div class="page-title__actions">
        <el-button :icon="Sort" @click="changeSort(cellarStore.sortMode === 'remain' ? 'start' : 'remain')">
          切换为{{ cellarStore.sortMode === 'remain' ? '按入窖日期' : '按临近出窖' }}排序
        </el-button>
        <el-button :icon="Bell" @click="releaseOverdue">批量处理逾期</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">登记窖藏</el-button>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="窖藏记录" :value="cellarStore.cellars.length" suffix="条" icon="Coin" tone="primary" />
      <StatBadge label="在窖" :value="cellarStore.agingCount" suffix="个" icon="Histogram" tone="warning" />
      <StatBadge label="已出窖" :value="cellarStore.doneCount" suffix="个" icon="Files" tone="success" />
      <StatBadge
        label="临近出窖"
        :value="cellarStore.alerts.length"
        suffix="个"
        icon="WarningFilled"
        tone="danger"
        :hint="`剩余天数 ≤ ${CELLAR_NEAR_DAYS} 天或已逾期`"
      />
      <StatBadge label="在窖均温" :value="cellarStore.averageTemperature" suffix="℃" icon="TrendCharts" tone="info" />
      <StatBadge label="在窖均湿" :value="cellarStore.averageHumidity" suffix="%" icon="PieChart" tone="info" />
    </div>

    <el-alert
      v-if="cellarStore.alerts.length > 0"
      class="cellar-alert"
      type="warning"
      show-icon
      :closable="false"
      :title="`临近出窖提醒：${cellarStore.alerts.length} 个批次需要关注`"
    >
      <template #default>
        <ul class="alert-list">
          <li v-for="row in cellarStore.alerts.slice(0, 5)" :key="row.cellar.id">
            {{ row.formulaName }} · 计划 {{ row.cellar.endDate }} · {{ urgencyLabel(row) }}
          </li>
        </ul>
      </template>
    </el-alert>

    <el-alert
      v-if="cellarStore.environmentWarning.length > 0"
      class="cellar-alert"
      type="error"
      show-icon
      :closable="false"
      :title="`环境超限 ${cellarStore.environmentWarning.length} 条（建议 18~26 ℃ / 50~70%）`"
    />

    <FilterBar
      :model-value="filterModel"
      :selects="filterSelects"
      keyword-placeholder="按香方名 / 容器 / 状态搜索"
      @change="handleFilterChange"
      @reset="handleReset"
    />

    <div class="section-card cellar-table">
      <div v-if="rows.length === 0" class="cellar-empty">
        <EmptyPanel
          title="暂无窖藏记录"
          :description="
            cellarStore.cellars.length === 0
              ? '和香成型后即可入窖：登记起止日期、温湿度与容器，系统会按天数提醒临近出窖。'
              : '当前筛选条件下没有匹配的窖藏记录，可重置条件或登记新记录。'
          "
          action-text="登记窖藏"
          @action="openCreate"
        />
      </div>

      <el-table v-else :data="rows" row-key="cellar.id" stripe>
        <el-table-column label="批次 / 香方" min-width="210">
          <template #default="{ row }: { row: CellarRow }">
            <div class="cell-main">{{ row.formulaName }}</div>
            <div class="cell-sub muted">
              {{ formingText(row.cellar.batchId) }} · {{ row.quantity }} 支 · 配比
              {{ batchFormulaMaterialCount(row.cellar.batchId) }} 味
            </div>
          </template>
        </el-table-column>
        <el-table-column label="窖藏天数" width="150">
          <template #default="{ row }: { row: CellarRow }">
            <div class="cell-sub">已窖 {{ row.agedDays }} 天</div>
            <div class="cell-sub" :class="row.urgency === 'overdue' ? 'ratio-error' : row.urgency === 'near' ? 'ratio-warn' : 'muted'">
              {{ urgencyLabel(row) }}
            </div>
          </template>
        </el-table-column>
        <el-table-column label="起止日期" width="200">
          <template #default="{ row }: { row: CellarRow }">
            <div class="cell-sub mono">{{ row.cellar.startDate }} → {{ row.cellar.endDate }}</div>
          </template>
        </el-table-column>
        <el-table-column label="温度 ℃" width="130">
          <template #default="{ row }: { row: CellarRow }">
            <el-input-number
              :model-value="row.cellar.temperatureC"
              :min="-10"
              :max="50"
              :step="0.5"
              :precision="1"
              size="small"
              controls-position="right"
              style="width: 108px"
              @change="(value: number | undefined) => updateReading(row, 'temperatureC', value ?? 0)"
            />
          </template>
        </el-table-column>
        <el-table-column label="湿度 %" width="130">
          <template #default="{ row }: { row: CellarRow }">
            <el-input-number
              :model-value="row.cellar.humidityPct"
              :min="0"
              :max="100"
              :step="1"
              :precision="1"
              size="small"
              controls-position="right"
              style="width: 108px"
              @change="(value: number | undefined) => updateReading(row, 'humidityPct', value ?? 0)"
            />
          </template>
        </el-table-column>
        <el-table-column label="容器 / 状态" width="200">
          <template #default="{ row }: { row: CellarRow }">
            <GradeTag plain size="small" :label="row.cellar.container" />
            <el-tag class="state-tag" :type="urgencyTone(row.urgency)" effect="plain" round>
              {{ row.cellar.state }}
            </el-tag>
            <el-tag v-if="row.cellar.scrapped" class="state-tag" type="danger" effect="dark" round size="small">
              报废 {{ row.cellar.wastePct ?? 0 }}%
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="360" fixed="right">
          <template #default="{ row }: { row: CellarRow }">
            <el-button
              size="small"
              type="warning"
              plain
              @click="advanceState(row)"
            >
              {{ row.cellar.state === '窖藏中' ? '正常出窖' : '回退为在窖' }}
            </el-button>
            <el-button size="small" type="danger" plain @click="openScrap(row)">
              {{ row.cellar.scrapped ? '调整报废' : '出窖报废' }}
            </el-button>
            <el-button v-if="row.cellar.scrapped" size="small" text @click="undoScrap(row)">撤销报废</el-button>
            <el-button size="small" text @click="goTasting(row)">去品香</el-button>
            <el-button size="small" text type="primary" :icon="Edit" @click="openEdit(row.cellar)">编辑</el-button>
            <el-button size="small" text type="danger" :icon="Delete" @click="removeCellar(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑窖藏记录' : '登记窖藏批次'" width="580px" append-to-body>
      <el-form ref="formRef" :model="form" :rules="rules" label-width="112px">
        <el-form-item label="和香批次" prop="batchId">
          <el-select v-model="form.batchId" filterable placeholder="选择未入窖的批次" style="width: 100%">
            <el-option v-for="item in batchOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="入窖日期" prop="startDate">
          <el-date-picker
            v-model="form.startDate"
            type="date"
            value-format="YYYY-MM-DD"
            style="width: 100%"
            placeholder="选择入窖日期"
          />
        </el-form-item>
        <el-form-item label="计划出窖" prop="endDate">
          <el-date-picker
            v-model="form.endDate"
            type="date"
            value-format="YYYY-MM-DD"
            style="width: 100%"
            placeholder="选择计划出窖日期"
          />
        </el-form-item>
        <el-form-item label="温度 ℃" prop="temperatureC">
          <el-input-number v-model="form.temperatureC" :min="-10" :max="50" :step="0.5" :precision="1" style="width: 180px" />
          <span class="muted form-hint">建议 18 ~ 26 ℃</span>
        </el-form-item>
        <el-form-item label="湿度 %" prop="humidityPct">
          <el-input-number v-model="form.humidityPct" :min="0" :max="100" :step="1" :precision="1" style="width: 180px" />
          <span class="muted form-hint">建议 50 ~ 70 %</span>
        </el-form-item>
        <el-form-item label="容器" prop="container">
          <el-radio-group v-model="form.container">
            <el-radio v-for="item in CELLAR_CONTAINERS" :key="item" :value="item">{{ item }}</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="状态" prop="state">
          <el-select v-model="form.state" style="width: 100%">
            <el-option v-for="item in CELLAR_STATES" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
        <el-alert
          v-if="watchedFormulaId"
          class="ratio-alert"
          :type="ratioLevel === 'ok' ? 'success' : ratioLevel === 'warn' ? 'warning' : 'error'"
          :closable="false"
          show-icon
          :title="`该批次所属香方配比合计：${ratioTotal}%（${ratioRows.length} 味）`"
          :description="ratioMessage"
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存修改' : '登记入窖' }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="scrapVisible" title="出窖报废登记（按损耗回冲用料）" width="560px" append-to-body>
      <div v-if="scrapPreview.lines.length > 0">
        <el-alert
          type="warning"
          :closable="false"
          show-icon
          title="报废批次的用料账整批转为报损：损耗部分记报废，未损部分退回可用库存"
          class="ratio-alert"
        />
        <div class="scrap-row">
          <span>损耗比例</span>
          <el-slider v-model="scrapPct" :min="0" :max="100" :step="1" show-input style="flex: 1; margin-left: 16px" />
        </div>
        <div class="scrap-summary">
          <StatBadge label="锁定用料" :value="scrapPreview.total" :suffix="STOCK_UNIT" size="small" icon="Coin" tone="primary" />
          <StatBadge label="报废损耗" :value="scrapPreview.wasted" :suffix="STOCK_UNIT" size="small" icon="WarningFilled" tone="danger" />
          <StatBadge label="完好退回" :value="scrapPreview.returned" :suffix="STOCK_UNIT" size="small" icon="Files" tone="success" />
        </div>
        <el-table :data="scrapPreview.lines" size="small" row-key="name" style="margin-top: 10px">
          <el-table-column label="香料" prop="name" min-width="120" />
          <el-table-column label="锁定用量" width="120">
            <template #default="{ row }: { row: { amount: number } }">
              <span class="mono">{{ row.amount }}{{ STOCK_UNIT }}</span>
            </template>
          </el-table-column>
          <el-table-column label="损耗" width="120">
            <template #default="{ row }: { row: { wasted: number } }">
              <span class="mono ratio-error">{{ row.wasted }}{{ STOCK_UNIT }}</span>
            </template>
          </el-table-column>
        </el-table>
      </div>
      <el-empty v-else description="该批次没有锁定的用料台账（可能缺配比），无料可回冲" />
      <template #footer>
        <el-button @click="scrapVisible = false">取消</el-button>
        <el-button type="danger" :loading="scrapSubmitting" :disabled="scrapPreview.lines.length === 0" @click="submitScrap">
          确认报废并回冲
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.cellar-alert {
  margin-bottom: 12px;
}

.alert-list {
  margin: 4px 0 0;
  padding-left: 18px;
  font-size: 12px;
}

.cellar-table {
  margin-top: 16px;
}

.cellar-empty {
  padding: 8px 0;
}

.cell-main {
  font-weight: 600;
}

.cell-sub {
  font-size: 12px;
  line-height: 1.6;
}

.state-tag {
  margin-left: 6px;
}

.form-hint {
  margin-left: 10px;
  font-size: 12px;
}

.ratio-alert {
  margin-bottom: 12px;
}

.scrap-row {
  display: flex;
  align-items: center;
  margin: 8px 0;
  font-size: 13px;
}

.scrap-summary {
  display: flex;
  gap: 8px;
  margin: 10px 0;
}
</style>
