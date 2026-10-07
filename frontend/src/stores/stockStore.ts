import { defineStore } from 'pinia'
import { computed } from 'vue'
import { db } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import type { Batch, BatchSnapshotItem } from '@/types/batch'
import type { Cellar } from '@/types/cellar'
import type { Material } from '@/types/material'
import type { Proportion } from '@/types/proportion'
import {
  StockShortageError,
  stockLineId,
  STOCK_EPSILON,
  type ReconcileMode,
  type StockLine,
  type StockLineStatus,
  type StockShortageItem
} from '@/types/stock'
import { round } from '@/utils/ratio'
import {
  buildRequirements,
  isBatchCellared,
  isLineLocked,
  materialStock,
  occupiedOf,
  wastedOf
} from '@/utils/stock'

/** 开批 / 调量的核对结果：整批拒绝时回带缺料明细，供 UI 说清缺哪几味、差多少 */
export interface ReserveResult {
  ok: boolean
  shortages: StockShortageItem[]
  /** 实际写入的台账条数 */
  lineCount: number
}

export interface StockBalance {
  material: Material
  /** 本地库存容量（克） */
  capacity: number
  /** 预留占用（未入窖，克） */
  reserved: number
  /** 入窖锁定占用（克） */
  locked: number
  /** 已报损累计（克） */
  wasted: number
  /** 剩余可用 = 库存 - 预留 - 锁定（克，可能为负，表示超占需补库存） */
  available: number
  /** 库存数是升级时按现有预留补出的推断值，待人工核对 */
  inferred: boolean
}

/** 全量台账投影下逐料核对：占用（预留+锁定）超出库存即缺口 */
function projectShortages(
  projected: StockLine[],
  materialsById: Map<string, Material>,
  wantedMaterialIds: Set<string>
): StockShortageItem[] {
  const occupied = new Map<string, number>()
  projected
    .filter((line) => line.status !== 'wasted')
    .forEach((line) => {
      occupied.set(line.materialId, round((occupied.get(line.materialId) ?? 0) + line.amount, 2))
    })
  // 本次想占的量按物料汇总（用于「需要多少」）
  const wantedAmount = new Map<string, number>()
  projected
    .filter((line) => wantedMaterialIds.has(line.materialId) && line.status !== 'wasted')
    .forEach((line) => {
      wantedAmount.set(line.materialId, round((wantedAmount.get(line.materialId) ?? 0) + line.amount, 2))
    })
  const shortages: StockShortageItem[] = []
  wantedMaterialIds.forEach((materialId) => {
    const capacity = materialStock(materialsById.get(materialId))
    const used = round(occupied.get(materialId) ?? 0, 2)
    const short = round(used - capacity, 2)
    if (short > STOCK_EPSILON) {
      shortages.push({
        materialId,
        materialName: materialsById.get(materialId)?.name ?? '未知香料',
        required: round(wantedAmount.get(materialId) ?? 0, 2),
        available: round(capacity - (used - (wantedAmount.get(materialId) ?? 0)), 2),
        short
      })
    }
  })
  return shortages
}

/**
 * 用料账 store：香料库（容量）× 配比 × 和香批次并成一条台账（stockLines 表）。
 * 全部写操作在单个 IndexedDB 事务内重读最新数据再落库，保证两个标签页同时
 * 提交同一批领用只有先到的预留生效；后到的一侧由调用方保留草稿并重试。
 */
export const useStockStore = defineStore('stock', () => {
  const lineTable = useIdbTable<StockLine>((database) => database.stockLines, { sortByUpdatedAt: false })

  const lines = computed<StockLine[]>(() => lineTable.rows.value)
  const loading = computed(() => lineTable.loading.value)
  const ready = computed(() => lineTable.ready.value)
  const error = computed(() => lineTable.error.value)

  const linesByBatch = computed<Record<string, StockLine[]>>(() => {
    const grouped: Record<string, StockLine[]> = {}
    lines.value.forEach((line) => {
      const list = grouped[line.batchId] ?? []
      list.push(line)
      grouped[line.batchId] = list
    })
    return grouped
  })

  function linesOfBatch(batchId: string): StockLine[] {
    return linesByBatch.value[batchId] ?? []
  }

  function lineOf(batchId: string, materialId: string): StockLine | undefined {
    return lines.value.find((line) => line.batchId === batchId && line.materialId === materialId)
  }

  /** 事务内整批替换台账（确定性主键，删旧写新） */
  async function replaceBatchLinesTx(batchId: string, wanted: StockLine[]): Promise<void> {
    const now = Date.now()
    const oldIds = (await db.stockLines.where('batchId').equals(batchId).primaryKeys()) as string[]
    await db.stockLines.bulkDelete(oldIds)
    if (wanted.length > 0) {
      await db.stockLines.bulkPut(wanted.map((line) => ({ ...line, updatedAt: now })))
    }
  }

  /**
   * 开批预留：按配比快照 × 数量折料，先按本地库存预留；任一味撑不住就整批拒绝。
   * 事务内重读全部台账与库存，两个标签页并发时后提交者会看到先提交者的占用。
   */
  async function reserveForBatch(params: {
    batch: Pick<Batch, 'id' | 'formulaId' | 'quantity'>
    snapshot: BatchSnapshotItem[]
    mode?: ReconcileMode
  }): Promise<ReserveResult> {
    const { batch, snapshot, mode = 'strict' } = params
    return db.transaction('rw', [db.stockLines, db.materials], async () => {
      const [allLines, materials] = await Promise.all([db.stockLines.toArray(), db.materials.toArray()])
      const materialsById = new Map(materials.map((material) => [material.id, material]))
      const existing = allLines.filter((line) => line.batchId === batch.id)

      // 已入窖的批次用料锁死，不再接受开批预留
      if (existing.some(isLineLocked)) {
        return { ok: true, shortages: [], lineCount: existing.length }
      }

      const wanted = buildRequirements(batch, snapshot, materialsById).map((line) => ({
        ...line,
        id: stockLineId(batch.id, line.materialId)
      }))
      const projected = [...allLines.filter((line) => line.batchId !== batch.id), ...wanted]
      const shortages = projectShortages(projected, materialsById, new Set(wanted.map((line) => line.materialId)))
      if (shortages.length > 0 && mode === 'strict') throw new StockShortageError(shortages)

      await replaceBatchLinesTx(batch.id, wanted)
      return { ok: shortages.length === 0, shortages, lineCount: wanted.length }
    })
  }

  /**
   * 改数量（实到）后重算预留：多占的退回、少占的补占；库存撑不住新数量则整批拒绝，
   * 原预留不动。已入窖批次的用料锁死，拒绝调量。
   */
  async function resizeBatch(params: {
    batch: Pick<Batch, 'id' | 'formulaId' | 'quantity'>
    snapshot: BatchSnapshotItem[]
    quantity: number
  }): Promise<ReserveResult> {
    const { batch, snapshot, quantity } = params
    return db.transaction('rw', [db.stockLines, db.materials], async () => {
      const [allLines, materials] = await Promise.all([db.stockLines.toArray(), db.materials.toArray()])
      const existing = allLines.filter((line) => line.batchId === batch.id)
      if (existing.some(isLineLocked)) {
        return { ok: true, shortages: [], lineCount: existing.length }
      }
      const materialsById = new Map(materials.map((material) => [material.id, material]))
      const wanted = buildRequirements({ ...batch, quantity }, snapshot, materialsById)
      const projected = [...allLines.filter((line) => line.batchId !== batch.id), ...wanted]
      const shortages = projectShortages(projected, materialsById, new Set(wanted.map((line) => line.materialId)))
      if (shortages.length > 0) throw new StockShortageError(shortages)
      await replaceBatchLinesTx(batch.id, wanted)
      return { ok: true, shortages: [], lineCount: wanted.length }
    })
  }

  /**
   * 香方配比变化：未入窖的预留按最新配比 × 数量重算；
   * 已入窖批次的用料锁成当时那份，不动。
   * strict 下任一在窖外批次超占即整体拒绝并回带缺口（先补库存或减量后再保存配比）。
   */
  async function recalcFormula(params: {
    formulaId: string
    proportions: Proportion[]
    batches: Batch[]
    cellars: Cellar[]
    mode?: ReconcileMode
  }): Promise<{ updated: number; shortages: StockShortageItem[] }> {
    const { formulaId, proportions, batches, cellars, mode = 'strict' } = params
    const openBatches = batches.filter(
      (batch) => batch.formulaId === formulaId && !isBatchCellared(cellars, batch.id)
    )
    if (openBatches.length === 0) return { updated: 0, shortages: [] }

    return db.transaction('rw', [db.stockLines, db.materials], async () => {
      const [allLines, materials] = await Promise.all([db.stockLines.toArray(), db.materials.toArray()])
      const materialsById = new Map(materials.map((material) => [material.id, material]))
      const affectedBatchIds = new Set(openBatches.map((batch) => batch.id))

      const wantedByBatch = new Map<string, StockLine[]>()
      openBatches.forEach((batch) => {
        const snapshot: BatchSnapshotItem[] = proportions.map((proportion) => ({
          materialId: proportion.materialId,
          materialName: materialsById.get(proportion.materialId)?.name ?? '未知香料',
          ratio: round(proportion.ratio, 2),
          role: proportion.role
        }))
        wantedByBatch.set(batch.id, buildRequirements(batch, snapshot, materialsById))
      })

      const wantedAll = [...wantedByBatch.values()].flat()
      const projected = [
        ...allLines.filter((line) => !affectedBatchIds.has(line.batchId)),
        ...wantedAll
      ]
      const shortages = projectShortages(projected, materialsById, new Set(wantedAll.map((line) => line.materialId)))
      if (shortages.length > 0 && mode === 'strict') throw new StockShortageError(shortages)

      for (const batch of openBatches) {
        await replaceBatchLinesTx(batch.id, wantedByBatch.get(batch.id) ?? [])
      }
      return { updated: openBatches.length, shortages }
    })
  }

  /** 入窖锁定：把该批次的预留冻成开批那份（reserved → locked） */
  async function lockForCellar(params: { batchId: string; cellaredAt?: number }): Promise<number> {
    const { batchId, cellaredAt = Date.now() } = params
    return db.transaction('rw', db.stockLines, async () => {
      const rows = await db.stockLines.where('batchId').equals(batchId).toArray()
      const targets = rows.filter((line) => line.status === 'reserved')
      if (targets.length === 0) return 0
      await db.stockLines.bulkPut(
        targets.map((line) => ({
          ...line,
          status: 'locked' as StockLineStatus,
          lockedAt: cellaredAt,
          updatedAt: Date.now()
        }))
      )
      return targets.length
    })
  }

  /**
   * 出窖报废按损耗回冲：报废批次转为 wasted（整批不再占用库存），
   * 其中损耗量记 wastedAmount、完好部分（amount - 损耗）记为退回；
   * 撤销报废（scrapped=false）时整批恢复为 locked 并重新占用。
   */
  async function applyScrap(params: {
    batchId: string
    scrapped: boolean
    wastePct: number
  }): Promise<{ wasted: number; returned: number; count: number }> {
    const { batchId, scrapped } = params
    const pct = scrapped ? Math.min(100, Math.max(0, round(params.wastePct, 2))) : 0
    return db.transaction('rw', db.stockLines, async () => {
      const rows = await db.stockLines.where('batchId').equals(batchId).toArray()
      const now = Date.now()
      let wasted = 0
      let returned = 0
      const targets = rows.filter((line) => line.status === 'locked' || line.status === 'wasted')
      const next = targets.map((line) => {
        const wasteAmount = scrapped ? round((line.amount * pct) / 100, 2) : 0
        wasted += wasteAmount
        returned += scrapped ? round(line.amount - wasteAmount, 2) : 0
        return {
          ...line,
          status: (scrapped ? 'wasted' : 'locked') as StockLineStatus,
          wastedAmount: wasteAmount,
          wastePct: scrapped ? pct : 0,
          wastedAt: scrapped ? now : 0,
          updatedAt: now
        }
      })
      if (next.length > 0) await db.stockLines.bulkPut(next)
      return { wasted: round(wasted, 2), returned: round(returned, 2), count: next.length }
    })
  }

  /** 删除批次时连带清掉台账 */
  async function removeLinesOfBatch(batchId: string): Promise<number> {
    const ids = (await db.stockLines.where('batchId').equals(batchId).primaryKeys()) as string[]
    if (ids.length === 0) return 0
    await db.stockLines.bulkDelete(ids)
    return ids.length
  }

  /** 删除某香方下全部台账（香方级联删除） */
  async function removeLinesOfFormula(formulaId: string): Promise<number> {
    const ids = (await db.stockLines.where('formulaId').equals(formulaId).primaryKeys()) as string[]
    if (ids.length === 0) return 0
    await db.stockLines.bulkDelete(ids)
    return ids.length
  }

  /** 库存账：每味香料的容量 / 预留 / 锁定 / 报损 / 可用 */
  function balances(materials: Material[]): StockBalance[] {
    return materials.map((material) => {
      const reserved = round(
        lines.value
          .filter((line) => line.materialId === material.id && line.status === 'reserved')
          .reduce((sum, line) => sum + line.amount, 0),
        2
      )
      const locked = round(
        lines.value
          .filter((line) => line.materialId === material.id && line.status === 'locked')
          .reduce((sum, line) => sum + line.amount, 0),
        2
      )
      const wasted = wastedOf(lines.value, material.id)
      const capacity = materialStock(material)
      const available = round(capacity - reserved - locked, 2)
      const inferred = Boolean((material as { stockInferred?: boolean }).stockInferred)
      return { material, capacity, reserved, locked, wasted, available, inferred }
    })
  }

  /** 某味料实时占用（预留+锁定）与已报损 */
  function occupancy(materialId: string): { occupied: number; wasted: number } {
    return { occupied: occupiedOf(lines.value, materialId), wasted: wastedOf(lines.value, materialId) }
  }

  /** 是否缺配比（没有任何台账行）——开批时留空待核对 */
  function isEmptyBatch(batchId: string): boolean {
    return linesOfBatch(batchId).length === 0
  }

  const hasLocked = computed(() => lines.value.some(isLineLocked))

  return {
    lines,
    loading,
    ready,
    error,
    linesByBatch,
    hasLocked,
    linesOfBatch,
    lineOf,
    isEmptyBatch,
    balances,
    occupancy,
    reserveForBatch,
    resizeBatch,
    recalcFormula,
    lockForCellar,
    applyScrap,
    removeLinesOfBatch,
    removeLinesOfFormula
  }
})
