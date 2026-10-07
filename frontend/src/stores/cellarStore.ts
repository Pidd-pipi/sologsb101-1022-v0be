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
import { lockBatchUsage, settleSpoil, unlockBatchUsage } from '@/utils/materialLedger'

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
      const quantity = batch?.quantity ?? 0
      const spoilRate =
        cellar.spoilRatePct > 0
          ? cellar.spoilRatePct
          : cellar.spoilCount > 0 && quantity > 0
            ? round((cellar.spoilCount / quantity) * 100, 2)
            : 0
      return {
        cellar,
        batchLabel: batchLabel(cellar.batchId),
        formulaName: batch ? formulaNameMap.value[batch.formulaId] ?? '香方已删除' : '香方已删除',
        quantity,
        remainDays: daysBetween(todayIso(), cellar.endDate),
        agedDays: daysBetween(cellar.startDate, todayIso()),
        urgency: urgencyOf(cellar),
        spoilRatePct: spoilRate
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

  /** 窖藏记录的报废比例：优先记录值，缺省按报废数 / 批次数量折算 */
  function spoilRateOf(cellar: Cellar, quantity?: number): number {
    if (cellar.spoilRatePct > 0) return cellar.spoilRatePct
    const qty = quantity ?? batchMap.value[cellar.batchId]?.quantity ?? 0
    if (cellar.spoilCount > 0 && qty > 0) return round((cellar.spoilCount / qty) * 100, 2)
    return 0
  }

  /** 按窖藏记录是否存在，把批次用料锁定 / 解锁（删除窖藏后恢复为可重算预留） */
  async function resyncBatchLock(batchId: string): Promise<void> {
    const exists = await db.cellars.where('batchId').equals(batchId).count()
    if (exists > 0) {
      await lockBatchUsage(batchId)
    } else {
      await unlockBatchUsage(batchId)
    }
  }

  async function createCellar(payload: {
    batchId: string
    startDate: string
    endDate: string
    temperatureC: number
    humidityPct: number
    container: CellarContainer
    state?: CellarState
    spoilCount?: number
  }): Promise<Cellar> {
    const quantity = batchMap.value[payload.batchId]?.quantity ?? 0
    const spoilCount = Math.max(Math.round(payload.spoilCount ?? 0), 0)
    const state = payload.state ?? '窖藏中'
    const cellar = await cellarTable.create(
      {
        batchId: payload.batchId,
        startDate: payload.startDate,
        endDate: payload.endDate,
        temperatureC: round(payload.temperatureC, 1),
        humidityPct: round(payload.humidityPct, 1),
        container: payload.container,
        state,
        spoilCount: state === '已出窖' ? Math.min(spoilCount, quantity) : 0,
        spoilRatePct: 0
      },
      'cellar'
    )
    // 入窖即把用料锁成当时那份；登记即已出窖的，同时按报废率回冲
    await lockBatchUsage(cellar.batchId)
    if (cellar.state === '已出窖') {
      const rate = spoilRateOf(cellar, quantity)
      await settleSpoil(cellar.batchId, rate, 0)
      await cellarTable.update(cellar.id, { spoilRatePct: rate })
    }
    return cellar
  }

  async function updateCellar(id: string, patch: Partial<Cellar>): Promise<void> {
    const cellar = cellarById(id)
    if (!cellar) return
    const next: Partial<Cellar> = { ...patch }
    if (patch.temperatureC !== undefined) next.temperatureC = round(patch.temperatureC, 1)
    if (patch.humidityPct !== undefined) next.humidityPct = round(patch.humidityPct, 1)

    const prevBatchId = cellar.batchId
    const nextBatchId = patch.batchId ?? prevBatchId
    const quantity = batchMap.value[nextBatchId]?.quantity ?? 0
    if (patch.spoilCount !== undefined) {
      next.spoilCount = Math.min(Math.max(Math.round(patch.spoilCount), 0), quantity)
    }
    const nextState = patch.state ?? cellar.state
    const effectiveCellar: Cellar = { ...cellar, ...next, state: nextState, batchId: nextBatchId }
    const prevRate = cellar.state === '已出窖' ? spoilRateOf(cellar) : 0
    const nextRate =
      nextState === '已出窖' ? spoilRateOf(effectiveCellar, quantity) : 0
    next.spoilRatePct = nextRate

    // 批次改挂：旧批次（若无其它窖藏）解锁恢复预留，新批次锁定
    if (nextBatchId !== prevBatchId) {
      await cellarTable.update(id, next)
      await resyncBatchLock(prevBatchId)
      await lockBatchUsage(nextBatchId)
      if (nextState === '已出窖') await settleSpoil(nextBatchId, nextRate, 0)
      return
    }
    if (nextState === '已出窖' || cellar.state === '已出窖') {
      await settleSpoil(nextBatchId, nextRate, prevRate)
    }
    await cellarTable.update(id, next)
  }

  /** 状态流转：窖藏中 → 已出窖（按报废数回冲库存），已出窖 → 窖藏中（把回冲领回） */
  async function advanceState(id: string): Promise<CellarState | null> {
    const cellar = cellarById(id)
    if (!cellar) return null
    const next = CELLAR_STATE_FLOW[cellar.state]
    const quantity = batchMap.value[cellar.batchId]?.quantity ?? 0
    const patch: Partial<Cellar> = { state: next }
    if (next === '已出窖' && cellar.endDate > todayIso()) {
      patch.endDate = todayIso()
    }
    if (next === '已出窖') {
      const rate = spoilRateOf(cellar, quantity)
      await settleSpoil(cellar.batchId, rate, 0)
      patch.spoilRatePct = rate
    } else {
      // 回退为在窖：出窖时退回库存的报废用料重新领回
      await settleSpoil(cellar.batchId, 0, spoilRateOf(cellar, quantity))
      patch.spoilCount = 0
      patch.spoilRatePct = 0
    }
    await cellarTable.update(id, patch)
    return next
  }

  async function setState(id: string, state: CellarState): Promise<void> {
    const cellar = cellarById(id)
    if (!cellar || cellar.state === state) return
    await updateCellar(id, { state })
  }

  /** 出窖后补登 / 改报废数：按报废率增量回冲库存 */
  async function setSpoilCount(id: string, spoilCount: number): Promise<void> {
    await updateCellar(id, { spoilCount })
  }

  /** 一键出窖：把全部逾期的在窖批次置为已出窖（无报废登记，锁定用料维持消耗不回冲） */
  async function releaseOverdue(): Promise<number> {
    const targets = rows.value.filter((row) => row.cellar.state === '窖藏中' && row.remainDays < 0)
    if (targets.length === 0) return 0
    const now = Date.now()
    await db.transaction('rw', db.cellars, async () => {
      for (const row of targets) {
        await db.cellars.update(row.cellar.id, {
          state: '已出窖',
          endDate: todayIso(),
          spoilCount: 0,
          spoilRatePct: 0,
          updatedAt: now
        })
      }
    })
    return targets.length
  }

  async function removeCellar(id: string): Promise<void> {
    const cellar = cellarById(id)
    if (!cellar) return
    const { batchId, state } = cellar
    const quantity = batchMap.value[batchId]?.quantity ?? 0
    // 已出窖且登记过报废：先把回冲进库存的料领回，再删记录
    if (state === '已出窖') {
      await settleSpoil(batchId, 0, spoilRateOf(cellar, quantity))
    }
    await cellarTable.remove(id)
    await resyncBatchLock(batchId)
    if (currentCellarId.value === id) currentCellarId.value = null
  }

  async function removeCellarsOfBatch(batchId: string): Promise<number> {
    const list = cellarsOfBatch(batchId)
    const ids = list.map((cellar) => cellar.id)
    if (ids.length === 0) return 0
    const settled = list.some((cellar) => cellar.state === '已出窖' && spoilRateOf(cellar) > 0)
    if (settled) await settleSpoil(batchId, 0, Math.max(...list.map((cellar) => spoilRateOf(cellar))))
    await cellarTable.bulkRemove(ids)
    await unlockBatchUsage(batchId)
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
    setState,
    setSpoilCount,
    spoilRateOf,
    releaseOverdue,
    removeCellar,
    removeCellarsOfBatch
  }
})
