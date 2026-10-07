import type { Batch, BatchSnapshotItem } from '@/types/batch'
import type { Cellar } from '@/types/cellar'
import type { Material } from '@/types/material'
import type { StockLine, StockShortageItem } from '@/types/stock'
import { calcAmount, STOCK_EPSILON, stockLineId } from '@/types/stock'
import { round } from '@/utils/ratio'

/** 台账是否已入窖锁定（含之后出窖/报废）：锁定后用料冻结，不跟配比重算 */
export function isLineLocked(line: StockLine): boolean {
  return line.status === 'locked' || line.status === 'wasted'
}

/** 批次是否已入窖：存在任意一条窖藏记录即锁定，用料冻成开批那份 */
export function isBatchCellared(cellars: Cellar[], batchId: string): boolean {
  return cellars.some((cellar) => cellar.batchId === batchId)
}

/**
 * 按配比快照与数量折出整批用料（预留基线）。
 * 缺配比（快照为空）时返回空数组，由调用方留空待核对。
 */
export function buildRequirements(
  batch: Pick<Batch, 'id' | 'formulaId' | 'quantity'>,
  snapshot: BatchSnapshotItem[],
  materialsById: Map<string, Material>,
  now = Date.now()
): StockLine[] {
  return snapshot
    .slice()
    .sort((a, b) => a.role.localeCompare(b.role))
    .map((item) => {
      const material = materialsById.get(item.materialId)
      const ratio = round(item.ratio, 2)
      const quantity = batch.quantity
      return {
        id: stockLineId(batch.id, item.materialId),
        batchId: batch.id,
        formulaId: batch.formulaId,
        materialId: item.materialId,
        materialName: material?.name ?? item.materialName ?? '未知香料',
        ratio,
        quantity,
        amount: calcAmount(quantity, ratio),
        status: 'reserved' as const,
        lockedAt: 0,
        wastedAmount: 0,
        wastePct: 0,
        wastedAt: 0,
        updatedAt: now
      }
    })
}

/**
 * 库存可用量核对：required 为「本次想占的量」，excludedBatchIds 的台账不计入占用。
 * 返回缺料明细（含 required / available / short），全部满足时为空数组。
 * 库存字段缺失（老档案）视为 0，先把缺口暴露出来待核对，而不是静默放行。
 */
export function checkShortages(params: {
  wanted: StockLine[]
  materialsById: Map<string, Material>
  lines: StockLine[]
  excludeBatchIds?: string[]
}): StockShortageItem[] {
  const { wanted, materialsById, lines, excludeBatchIds = [] } = params
  const exclude = new Set(excludeBatchIds)
  const sumByMaterial = (list: Pick<StockLine, 'materialId' | 'amount'>[]): Map<string, number> => {
    const map = new Map<string, number>()
    list.forEach((line) => map.set(line.materialId, round((map.get(line.materialId) ?? 0) + line.amount, 2)))
    return map
  }
  const occupied = sumByMaterial(
    lines.filter((line) => !exclude.has(line.batchId) && line.status !== 'wasted')
  )
  const wantedByMaterial = sumByMaterial(wanted)
  const shortages: StockShortageItem[] = []
  wantedByMaterial.forEach((required, materialId) => {
    const capacity = materialStock(materialsById.get(materialId))
    const heldByOthers = round(occupied.get(materialId) ?? 0, 2)
    const available = round(capacity - heldByOthers, 2)
    const short = round(required - available, 2)
    if (short > STOCK_EPSILON) {
      const material = materialsById.get(materialId)
      shortages.push({
        materialId,
        materialName: material?.name ?? wanted.find((line) => line.materialId === materialId)?.materialName ?? '未知香料',
        required: round(required, 2),
        available,
        short
      })
    }
  })
  return shortages
}

/** 读取香料库存容量；老档案缺库存数按 0 处理（升级前的兜底） */
export function materialStock(material: Material | undefined): number {
  if (!material) return 0
  return Number.isFinite(material.stock) ? round(Number(material.stock), 2) : 0
}

/**
 * 某香料当前被占用的总量（预留 + 锁定，不含已报损）。
 */
export function occupiedOf(lines: StockLine[], materialId: string): number {
  return round(
    lines
      .filter((line) => line.materialId === materialId && line.status !== 'wasted')
      .reduce((sum, line) => sum + line.amount, 0),
    2
  )
}

/** 已报废损耗量（出窖报废回冲后单独留痕，供账页展示累计损耗） */
export function wastedOf(lines: StockLine[], materialId: string): number {
  return round(
    lines
      .filter((line) => line.materialId === materialId && line.status === 'wasted')
      .reduce((sum, line) => sum + line.wastedAmount, 0),
    2
  )
}
