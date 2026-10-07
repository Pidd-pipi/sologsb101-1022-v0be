import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, readUiPrefs, writeUiPrefs } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import {
  CELLAR_NEAR_DAYS,
  CELLAR_STATE_FLOW,
  createEmptyCellarFilter,
  type Cellar,
  type CellarContainer,
  type CellarFilterState,
  type CellarRow,
  type CellarState,
  type CellarUrgency
} from '@/types/cellar'
import type { Batch } from '@/types/batch'
import type { Formula } from '@/types/formula'
import { round } from '@/utils/ratio'
import { useStockStore } from '@/stores/stockStore'

/** 一天的毫秒数 */
const DAY_MS = 24 * 60 * 60 * 1000

/** 把 yyyy-MM-dd 解析为当天 0 点的毫秒数，非法日期返回 NaN */
export function parseDate(value: string): number {
  if (!value) return Number.NaN
  const parts = value.split('-').map((item) => Number(item))
  if (parts.length !== 3 || parts.some((item) => !Number.isFinite(item))) return Number.NaN
  return new Date(parts[0], parts[1] - 1, parts[2]).getTime()
}

/** 计算两个日期之间的整天数（to - from） */
export function daysBetween(from: string, to: string): number {
  const start = parseDate(from)
  const end = parseDate(to)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0
  return Math.round((end - start) / DAY_MS)
}

/** 今天（本地时区）的 yyyy-MM-dd */
export function todayIso(): string {
  const now = new Date()
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  const day = `${now.getDate()}`.padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/**
 * 窖藏 store：维护窖藏批次、环境读数与排序方式，
 * 派生临近出窖提醒（逾期 / 临近 / 正常 / 已出窖）。
 */
export const useCellarStore = defineStore('cellar', () => {
  const cellarTable = useIdbTable<Cellar>((database) => database.cellars)
  const batchTable = useIdbTable<Batch>((database) => database.batches, { sortByUpdatedAt: false })
  const formulaTable = useIdbTable<Formula>((database) => database.formulas, { sortByUpdatedAt: false })
  // 入窖锁定 / 出窖报废回冲走用料账；延迟取 store 以避开模块初始化环
  const stockStore = useStockStore()

  const prefs = readUiPrefs()
  const sortMode = ref<'remain' | 'start'>(prefs.cellarSort)
  const filter = ref<CellarFilterState>(createEmptyCellarFilter())
  const currentCellarId = ref<string | null>(null)

  const cellars = computed<Cellar[]>(() => cellarTable.rows.value)
  const batches = computed<Batch[]>(() => batchTable.rows.value)
  const formulas = computed<Formula[]>(() => formulaTable.rows.value)
  const loading = computed(() => cellarTable.loading.value)
  const ready = computed(() => cellarTable.ready.value)
  const error = computed(() => cellarTable.error.value)

  const currentCellar = computed<Cellar | null>(
    () => cellars.value.find((cellar) => cellar.id === currentCellarId.value) ?? null
  )

  const batchMap = computed<Record<string, Batch>>(() => {
    const map: Record<string, Batch> = {}
    batches.value.forEach((batch) => {
      map[batch.id] = batch
    })
    return map
  })

  const formulaNameMap = computed<Record<string, string>>(() => {
    const map: Record<string, string> = {}
    formulas.value.forEach((formula) => {
      map[formula.id] = formula.name
    })
    return map
  })

  /** 批次标签：香方名 · 和香日期 · 成型方式 */
  function batchLabel(batchId: string): string {
    const batch = batchMap.value[batchId]
    if (!batch) return '批次已删除'
    const name = formulaNameMap.value[batch.formulaId] ?? '香方已删除'
    return `${name} · ${batch.mixedAt} · ${batch.formingMethod}`
  }

  function urgencyOf(cellar: Cellar): CellarUrgency {
    if (cellar.state === '已出窖') return 'done'
    const remain = daysBetween(todayIso(), cellar.endDate)
    if (remain < 0) return 'overdue'
    if (remain <= CELLAR_NEAR_DAYS) return 'near'
    return 'normal'
  }

  /** 全部窖藏行：附带批次、香方与剩余天数 */
  const rows = computed<CellarRow[]>(() =>
    cellars.value.map((cellar) => {
      const batch = batchMap.value[cellar.batchId]
      return {
        cellar,
        batchLabel: batchLabel(cellar.batchId),
        formulaName: batch ? formulaNameMap.value[batch.formulaId] ?? '香方已删除' : '香方已删除',
        quantity: batch?.quantity ?? 0,
        remainDays: daysBetween(todayIso(), cellar.endDate),
        agedDays: daysBetween(cellar.startDate, todayIso()),
        urgency: urgencyOf(cellar)
      }
    })
  )

  /** 按排序方式排列：临近出窖（剩余天数升序）/ 按入窖日期 */
  const sortedRows = computed<CellarRow[]>(() => {
    const list = [...rows.value]
    if (sortMode.value === 'start') {
      return list.sort((a, b) => b.cellar.startDate.localeCompare(a.cellar.startDate))
    }
    return list.sort((a, b) => {
      const rank = (row: CellarRow): number => (row.urgency === 'done' ? 1 : 0)
      const rankDiff = rank(a) - rank(b)
      if (rankDiff !== 0) return rankDiff
      return a.remainDays - b.remainDays
    })
  })

  const filteredRows = computed<CellarRow[]>(() =>
    sortedRows.value.filter((row) => {
      const keyword = filter.value.keyword.trim()
      if (keyword.length > 0) {
        const haystack = `${row.batchLabel}${row.formulaName}${row.cellar.container}${row.cellar.state}`
        if (!haystack.includes(keyword)) return false
      }
      if (filter.value.states.length > 0 && !filter.value.states.includes(row.cellar.state)) return false
      if (filter.value.containers.length > 0 && !filter.value.containers.includes(row.cellar.container)) return false
      return true
    })
  )

  /** 临近出窖提醒：逾期 + 14 天内到期的在窖批次 */
  const alerts = computed<CellarRow[]>(() =>
    sortedRows.value.filter((row) => row.urgency === 'overdue' || row.urgency === 'near')
  )

  const agingCount = computed(() => cellars.value.filter((cellar) => cellar.state === '窖藏中').length)
  const doneCount = computed(() => cellars.value.filter((cellar) => cellar.state === '已出窖').length)

  const averageTemperature = computed(() => {
    const list = cellars.value.filter((cellar) => cellar.state === '窖藏中')
    if (list.length === 0) return 0
    return round(list.reduce((sum, cellar) => sum + cellar.temperatureC, 0) / list.length, 1)
  })

  const averageHumidity = computed(() => {
    const list = cellars.value.filter((cellar) => cellar.state === '窖藏中')
    if (list.length === 0) return 0
    return round(list.reduce((sum, cellar) => sum + cellar.humidityPct, 0) / list.length, 1)
  })

  /** 温湿度是否在建议区间内（18~26℃ / 50~70%） */
  const environmentWarning = computed(() =>
    cellars.value
      .filter((cellar) => cellar.state === '窖藏中')
      .filter((cellar) => cellar.temperatureC < 18 || cellar.temperatureC > 26 || cellar.humidityPct < 50 || cellar.humidityPct > 70)
      .map((cellar) => ({
        cellarId: cellar.id,
        label: batchLabel(cellar.batchId),
        temperatureC: cellar.temperatureC,
        humidityPct: cellar.humidityPct
      }))
  )

  const hasFilter = computed(
    () =>
      filter.value.keyword.trim().length > 0 ||
      filter.value.states.length > 0 ||
      filter.value.containers.length > 0
  )

  function setSortMode(mode: 'remain' | 'start'): void {
    sortMode.value = mode
    writeUiPrefs({ ...readUiPrefs(), cellarSort: mode })
  }

  function setCurrentCellar(id: string | null): void {
    currentCellarId.value = id
  }

  function patchFilter(patch: Partial<CellarFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptyCellarFilter()
  }

  function cellarById(id: string): Cellar | undefined {
    return cellars.value.find((cellar) => cellar.id === id)
  }

  function cellarsOfBatch(batchId: string): Cellar[] {
    return cellars.value.filter((cellar) => cellar.batchId === batchId)
  }

  async function createCellar(payload: {
    batchId: string
    startDate: string
    endDate: string
    temperatureC: number
    humidityPct: number
    container: CellarContainer
    state?: CellarState
    scrapped?: boolean
    wastePct?: number
  }): Promise<Cellar> {
    const state = payload.state ?? '窖藏中'
    const scrapped = payload.scrapped ?? false
    const wastePct = typeof payload.wastePct === 'number' ? round(payload.wastePct, 1) : 0
    // 入窖先在台账事务外落窖藏记录，再把该批预留锁成开批那份；若建窖即报废，再回冲
    const cellar = await cellarTable.create(
      {
        batchId: payload.batchId,
        startDate: payload.startDate,
        endDate: payload.endDate,
        temperatureC: round(payload.temperatureC, 1),
        humidityPct: round(payload.humidityPct, 1),
        container: payload.container,
        state,
        scrapped: scrapped && state === '已出窖',
        wastePct: scrapped && state === '已出窖' ? wastePct : 0,
        scrappedAt: scrapped && state === '已出窖' ? payload.startDate : ''
      },
      'cellar'
    )
    await stockStore.lockForCellar({ batchId: payload.batchId })
    if (scrapped && state === '已出窖') {
      await stockStore.applyScrap({ batchId: payload.batchId, scrapped: true, wastePct })
    }
    return cellar
  }

  /** 批次脱离窖藏（删窖藏 / 编辑换到别的批次）：撤销报废并把锁定用料退回预留 */
  async function detachBatchFromCellar(batchId: string): Promise<void> {
    const remaining = await db.cellars.where('batchId').equals(batchId).count()
    if (remaining > 0) return
    await stockStore.applyScrap({ batchId, scrapped: false, wastePct: 0 })
    const rows = await db.stockLines.where('batchId').equals(batchId).toArray()
    const now = Date.now()
    await db.stockLines.bulkPut(
      rows
        .filter((line) => line.status === 'locked')
        .map((line) => ({ ...line, status: 'reserved' as const, lockedAt: 0, updatedAt: now }))
    )
  }

  async function updateCellar(id: string, patch: Partial<Cellar>): Promise<void> {
    const prev = cellarById(id)
    const next: Partial<Cellar> = { ...patch }
    if (patch.temperatureC !== undefined) next.temperatureC = round(patch.temperatureC, 1)
    if (patch.humidityPct !== undefined) next.humidityPct = round(patch.humidityPct, 1)
    await cellarTable.update(id, next)
    // 编辑时换了关联批次：旧批次解锁退回预留（若无其它窖藏），新批次入窖锁定
    if (prev && patch.batchId && patch.batchId !== prev.batchId) {
      await detachBatchFromCellar(prev.batchId)
      await stockStore.lockForCellar({ batchId: patch.batchId })
    }
  }

  /** 状态流转：窖藏中 → 已出窖（可回退）。报废登记走 markScrap 以携带损耗比例 */
  async function advanceState(id: string): Promise<CellarState | null> {
    const cellar = cellarById(id)
    if (!cellar) return null
    const next = CELLAR_STATE_FLOW[cellar.state]
    const patch: Partial<Cellar> = { state: next }
    if (next === '已出窖' && cellar.endDate > todayIso()) {
      patch.endDate = todayIso()
    }
    // 普通出窖不算报废；若此前登记过报废，回退/流转时同步撤销报废占用
    if (next === '已出窖' && !cellar.scrapped) {
      patch.scrapped = false
    }
    await cellarTable.update(id, patch)
    if (next === '窖藏中') {
      // 回退为在窖：撤销报废，用料恢复为锁定占用
      await stockStore.applyScrap({ batchId: cellar.batchId, scrapped: false, wastePct: 0 })
      await db.cellars.update(id, { scrapped: false, wastePct: 0, scrappedAt: '', updatedAt: Date.now() })
    }
    return next
  }

  /**
   * 出窖登记：scrapped=true 表示报废，按 wastePct 损耗回冲用料账
   * （损耗转 wasted 留痕，未损部分释放回可用库存）。
   */
  async function markScrap(
    id: string,
    scrapped: boolean,
    wastePct: number
  ): Promise<{ wasted: number; returned: number }> {
    const cellar = cellarById(id)
    if (!cellar) return { wasted: 0, returned: 0 }
    const result = await stockStore.applyScrap({
      batchId: cellar.batchId,
      scrapped,
      wastePct
    })
    await cellarTable.update(id, {
      scrapped,
      wastePct: scrapped ? round(wastePct, 1) : 0,
      scrappedAt: scrapped ? todayIso() : '',
      state: '已出窖',
      endDate: cellar.endDate > todayIso() ? todayIso() : cellar.endDate
    })
    return { wasted: result.wasted, returned: result.returned }
  }

  async function setState(id: string, state: CellarState): Promise<void> {
    await cellarTable.update(id, { state })
  }

  /** 一键出窖：把全部逾期的在窖批次置为已出窖 */
  async function releaseOverdue(): Promise<number> {
    const targets = rows.value.filter((row) => row.cellar.state === '窖藏中' && row.remainDays < 0)
    if (targets.length === 0) return 0
    const now = Date.now()
    await db.transaction('rw', db.cellars, async () => {
      for (const row of targets) {
        await db.cellars.update(row.cellar.id, { state: '已出窖', updatedAt: now })
      }
    })
    return targets.length
  }

  async function removeCellar(id: string): Promise<void> {
    const cellar = cellarById(id)
    await cellarTable.remove(id)
    if (currentCellarId.value === id) currentCellarId.value = null
    if (cellar) await detachBatchFromCellar(cellar.batchId)
  }

  async function removeCellarsOfBatch(batchId: string): Promise<number> {
    const ids = cellarsOfBatch(batchId).map((cellar) => cellar.id)
    if (ids.length === 0) return 0
    await cellarTable.bulkRemove(ids)
    return ids.length
  }

  return {
    cellars,
    batches,
    formulas,
    loading,
    ready,
    error,
    sortMode,
    filter,
    currentCellarId,
    currentCellar,
    rows,
    sortedRows,
    filteredRows,
    alerts,
    agingCount,
    doneCount,
    averageTemperature,
    averageHumidity,
    environmentWarning,
    hasFilter,
    batchMap,
    batchLabel,
    setSortMode,
    setCurrentCellar,
    patchFilter,
    resetFilter,
    cellarById,
    cellarsOfBatch,
    createCellar,
    updateCellar,
    advanceState,
    markScrap,
    setState,
    releaseOverdue,
    removeCellar,
    removeCellarsOfBatch
  }
})
