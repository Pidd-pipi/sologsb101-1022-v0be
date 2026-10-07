import { db } from '@/utils/db'
import { round } from '@/utils/ratio'
import type { Batch, BatchMaterialLedger, BatchSnapshotItem, MaterialCommitResult, MaterialShortage, MaterialUsageItem } from '@/types/batch'
import type { Material } from '@/types/material'
import type { Proportion } from '@/types/proportion'
import { DEFAULT_BASIS_PER_UNIT } from '@/types/batch'

/** 用料折算保留的小数位，避免浮点误差把账对歪 */
export const USAGE_DIGITS = 2

/** 折算单味用量：占比% × 单件基准 × 数量 */
export function calcRequiredAmount(ratio: number, quantity: number, basisPerUnit = DEFAULT_BASIS_PER_UNIT): number {
  if (!Number.isFinite(ratio) || !Number.isFinite(quantity) || quantity <= 0) return 0
  return round((ratio / 100) * basisPerUnit * quantity, USAGE_DIGITS)
}

/** 配比快照 → 用料账条目（不查香料库，单位缺省留空，由 normalize 补） */
export function buildUsageFromSnapshot(
  snapshot: BatchSnapshotItem[],
  quantity: number,
  basisPerUnit = DEFAULT_BASIS_PER_UNIT
): MaterialUsageItem[] {
  return snapshot.map((item) => ({
    materialId: item.materialId,
    materialName: item.materialName,
    ratio: item.ratio,
    role: item.role,
    requiredAmount: calcRequiredAmount(item.ratio, quantity, basisPerUnit),
    unit: '',
    locked: false,
    pending: false
  }))
}

/** 用料账是否为空（老档案批次升级前的状态） */
export function isLedgerEmpty(ledger: BatchMaterialLedger | undefined | null): boolean {
  return !ledger || !Array.isArray(ledger.items) || ledger.items.length === 0
}

export function createEmptyLedger(basisPerUnit = DEFAULT_BASIS_PER_UNIT): BatchMaterialLedger {
  return { basisPerUnit, items: [] }
}

/**
 * 按香方当前配比 + 数量重算一版未锁定用料账。
 * 老条目里已有、但当前配比查不到的味保留为 pending（缺配比，先留空待核对），
 * 已锁定的味原样保留（已入窖批次用料不随改方变动）。
 */
export function recalcLedger(params: {
  ledger: BatchMaterialLedger
  proportions: Proportion[]
  materialMap: Map<string, Material>
  quantity: number
  basisPerUnit?: number
}): BatchMaterialLedger {
  const { ledger, proportions, materialMap, quantity } = params
  const basisPerUnit = params.basisPerUnit ?? ledger.basisPerUnit ?? DEFAULT_BASIS_PER_UNIT
  const items: MaterialUsageItem[] = proportions
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((proportion) => {
      const material = materialMap.get(proportion.materialId)
      return {
        materialId: proportion.materialId,
        materialName: material?.name ?? '香料已删除',
        ratio: round(proportion.ratio, 2),
        role: proportion.role,
        requiredAmount: calcRequiredAmount(proportion.ratio, quantity, basisPerUnit),
        unit: material?.unit ?? '',
        locked: false,
        pending: false
      }
    })

  const nextIds = new Set(items.map((item) => item.materialId))
  ledger.items.forEach((old) => {
    if (old.locked) {
      // 已入窖锁定的用料始终保留
      items.push({ ...old })
      return
    }
    if (!nextIds.has(old.materialId)) {
      // 当前配比里查不到：先留空待核对，不再占用库存（pending 不参与预留合计）
      items.push({
        ...old,
        requiredAmount: 0,
        pending: true,
        locked: false
      })
    }
  })
  return { basisPerUnit, items }
}

/** 用香料库最新名称 / 单位规整账目（香料改名或补单位后同步），不改用量 */
export function normalizeLedger(ledger: BatchMaterialLedger, materialMap: Map<string, Material>): BatchMaterialLedger {
  if (isLedgerEmpty(ledger)) return ledger
  return {
    basisPerUnit: ledger.basisPerUnit,
    items: ledger.items.map((item) => {
      const material = materialMap.get(item.materialId)
      return {
        ...item,
        materialName: material?.name ?? item.materialName,
        unit: material?.unit ?? item.unit
      }
    })
  }
}

/**
 * 预览一版（配比 × 数量）的容量校验，不落库；批次表单实时显示每味用量 / 缺口。
 * excludeBatchId 为正在编辑的批次，校验时排除其自身的预留。
 */
export async function previewCapacity(params: {
  proportions: Proportion[]
  materialMap: Map<string, Material>
  quantity: number
  basisPerUnit?: number
  excludeBatchId?: string | null
}): Promise<MaterialCommitResult> {
  const ledger = recalcLedger({
    ledger: createEmptyLedger(params.basisPerUnit),
    proportions: params.proportions,
    materialMap: params.materialMap,
    quantity: params.quantity
  })
  return checkCapacity(ledger, params.excludeBatchId ?? null)
}

/** 该批次当前实际占用库存的用料（未锁定 + 未缺配比的味） */
export function activeItems(batch: Batch): MaterialUsageItem[] {
  return batch.materialUsage.items.filter((item) => !item.pending)
}

/** 汇总一批对某味香料的占用量 */
export function batchRequiredOf(batch: Batch, materialId: string): number {
  return round(
    activeItems(batch)
      .filter((item) => item.materialId === materialId)
      .reduce((sum, item) => sum + item.requiredAmount, 0),
    USAGE_DIGITS
  )
}

/**
 * 校验一版用料账能否被库存容纳：库存容量（material.stock）扣除
 * 其它未入窖批次（excludeBatchId 除外）的预留后，逐味比较。
 * 缺库存数的老香料（stock 为 undefined / 负数视为 0）按 0 容量处理。
 */
export async function checkCapacity(
  ledger: BatchMaterialLedger,
  excludeBatchId: string | null
): Promise<MaterialCommitResult> {
  if (isLedgerEmpty(ledger)) {
    return { ok: true, shortages: [], message: '' }
  }
  const [materials, batches, cellars] = await Promise.all([
    db.materials.toArray(),
    db.batches.toArray(),
    db.cellars.toArray()
  ])
  const materialMap = new Map(materials.map((material) => [material.id, material]))
  // 凡有窖藏记录（在窖 / 已出窖）的批次都已锁定用料，不再占用库存容量
  const cellaredBatchIds = new Set(cellars.map((cellar) => cellar.batchId))

  /** 其它未入窖批次对各味的预留合计 */
  const reserved = new Map<string, number>()
  batches
    .filter((batch) => batch.id !== excludeBatchId && !cellaredBatchIds.has(batch.id))
    .forEach((batch) => {
      activeItems(batch).forEach((item) => {
        reserved.set(item.materialId, round((reserved.get(item.materialId) ?? 0) + item.requiredAmount, USAGE_DIGITS))
      })
    })

  const shortages: MaterialShortage[] = []
  ledger.items
    .filter((item) => !item.pending)
    .forEach((item) => {
      const material = materialMap.get(item.materialId)
      const stock = material && Number.isFinite(material.stock) && material.stock > 0 ? round(material.stock, USAGE_DIGITS) : 0
      const reservedByOthers = reserved.get(item.materialId) ?? 0
      const available = round(Math.max(stock - reservedByOthers, 0), USAGE_DIGITS)
      if (item.requiredAmount > available + 1e-6) {
        shortages.push({
          materialId: item.materialId,
          materialName: material?.name ?? item.materialName,
          unit: material?.unit ?? item.unit,
          requiredAmount: item.requiredAmount,
          stock,
          available,
          reservedByOthers,
          shortAmount: round(item.requiredAmount - available, USAGE_DIGITS)
        })
      }
    })

  if (shortages.length === 0) return { ok: true, shortages: [], message: '' }
  const detail = shortages.map((item) => `「${item.materialName}」差 ${item.shortAmount}${item.unit || ''}`).join('、')
  return {
    ok: false,
    shortages,
    message: `库存容量不足，整批未预留：${detail}`
  }
}

/** 容量校验失败错误：携带逐味缺口，供页面留草稿后按最新余量重试 */
export class LedgerRejectedError extends Error {
  result: MaterialCommitResult
  constructor(result: MaterialCommitResult) {
    super(result.message)
    this.name = 'LedgerRejectedError'
    this.result = result
  }
}

/**
 * 开批：在一个 Dexie 事务里写批次 + 按库存预留。
 * 两个标签页同时提交同一批领用（同样的配比 / 数量）时，IndexedDB 事务串行，
 * 后到者在事务内复验会读到先到者已占的预留而失败，只有先到的预留生效。
 */
export async function createBatchWithUsage(params: {
  batch: Omit<Batch, 'updatedAt'>
}): Promise<{ batch: Batch; result: MaterialCommitResult }> {
  const { batch } = params
  const check = await checkCapacity(batch.materialUsage, null)
  if (!check.ok) return { batch: { ...batch, updatedAt: Date.now() }, result: check }
  let result: MaterialCommitResult = { ok: true, shortages: [], message: '' }
  const stored: Batch = { ...batch, updatedAt: Date.now() }
  try {
    await db.transaction('rw', [db.batches, db.materials, db.cellars], async () => {
      // 事务内按最新数据复验：另一标签页可能已抢先预留
      const recheck = await checkCapacity(batch.materialUsage, null)
      if (!recheck.ok) {
        result = recheck
        // 抛错仅用于回滚本事务（批次不写库），外层捕获后转成 { ok: false }
        throw new LedgerRejectedError(recheck)
      }
      await db.batches.add(stored)
    })
  } catch (err) {
    if (err instanceof LedgerRejectedError) return { batch: stored, result }
    throw err
  }
  return { batch: stored, result }
}

/**
 * 改数量：按实到数量重算预留。
 * 数量调小 → 占用减少，多占的自然退回（给后续批次让位）；
 * 数量调大 → 新增占用必须过容量校验，撑不住整批拒绝、保留原数量。
 */
export async function updateBatchQuantity(params: {
  batchId: string
  quantity: number
  patch: Partial<Batch>
  proportions: Proportion[]
  materialMap: Map<string, Material>
}): Promise<MaterialCommitResult> {
  const { batchId, quantity, patch, proportions, materialMap } = params
  const current = await db.batches.get(batchId)
  if (!current) return { ok: false, shortages: [], message: '批次不存在' }
  const ledger = recalcLedger({
    ledger: current.materialUsage ?? createEmptyLedger(),
    proportions,
    materialMap,
    quantity
  })
  const check = await checkCapacity(ledger, batchId)
  if (!check.ok) return check
  let result: MaterialCommitResult = { ok: true, shortages: [], message: '' }
  try {
    await db.transaction('rw', [db.batches, db.materials, db.cellars], async () => {
      const recheck = await checkCapacity(ledger, batchId)
      if (!recheck.ok) {
        result = recheck
        throw new LedgerRejectedError(recheck)
      }
      await db.batches.update(batchId, { ...patch, quantity, materialUsage: ledger, updatedAt: Date.now() })
    })
  } catch (err) {
    if (err instanceof LedgerRejectedError) return result
    throw err
  }
  return result
}

/**
 * 入窖锁定：把批次用料锁成入窖当时那一份（含 pending 味），并释放库存容量。
 * 锁定后的批次不再参与「其它批次预留」合计。
 */
export async function lockBatchUsage(batchId: string): Promise<void> {
  await db.transaction('rw', [db.batches, db.cellars], async () => {
    const batch = await db.batches.get(batchId)
    if (!batch || isLedgerEmpty(batch.materialUsage)) return
    const items = batch.materialUsage.items.map((item) => ({ ...item, locked: true }))
    await db.batches.update(batchId, {
      materialUsage: { basisPerUnit: batch.materialUsage.basisPerUnit, items },
      updatedAt: Date.now()
    })
  })
}

/**
 * 解除锁定（删除 / 改挂窖藏记录时）：用料恢复为随配比重算的预留状态。
 * pending 味保持留空待核对，不重新占库存。
 */
export async function unlockBatchUsage(batchId: string): Promise<void> {
  await db.transaction('rw', db.batches, async () => {
    const batch = await db.batches.get(batchId)
    if (!batch || isLedgerEmpty(batch.materialUsage)) return
    const items = batch.materialUsage.items.map((item) => ({
      ...item,
      locked: false,
      writeBackAmount: undefined,
      spoilAmount: undefined,
      writeBackRatePct: undefined
    }))
    await db.batches.update(batchId, {
      materialUsage: { basisPerUnit: batch.materialUsage.basisPerUnit, items },
      updatedAt: Date.now()
    })
  })
}

/**
 * 出窖报废按损耗回冲库存，并可对称结算（回退为在窖时把已退的再领回）：
 * 报废的单位没有成香，其锁定用料按报废率退回香料库；成品对应部分维持已消耗。
 * 库存增量 = 锁定用料 × (新报废率 - 原报废率)，重复出窖 / 改报废数都不会重复退。
 * 返回各味实际回冲的香料数量（正值=退回库存，负值=重新领出）。
 */
export async function settleSpoil(
  batchId: string,
  nextRatePct: number,
  prevRatePct: number
): Promise<Array<{ materialId: string; delta: number }>> {
  const nextRate = Math.min(Math.max(nextRatePct, 0), 100) / 100
  const prevRate = Math.min(Math.max(prevRatePct, 0), 100) / 100
  const deltas: Array<{ materialId: string; delta: number }> = []
  await db.transaction('rw', [db.batches, db.materials], async () => {
    const batch = await db.batches.get(batchId)
    if (!batch || isLedgerEmpty(batch.materialUsage)) return
    const amountByMaterial = new Map<string, number>()
    const items = batch.materialUsage.items.map((item) => {
      if (item.pending || !item.locked) return item
      const deltaRate = round(nextRate - prevRate, 6)
      const delta = round(item.requiredAmount * deltaRate, USAGE_DIGITS)
      if (delta !== 0) {
        amountByMaterial.set(item.materialId, round((amountByMaterial.get(item.materialId) ?? 0) + delta, USAGE_DIGITS))
        deltas.push({ materialId: item.materialId, delta })
      }
      const writeBack = round(item.requiredAmount * nextRate, USAGE_DIGITS)
      return {
        ...item,
        writeBackAmount: nextRate > 0 ? writeBack : undefined,
        spoilAmount: nextRate > 0 ? writeBack : undefined,
        writeBackRatePct: nextRate > 0 ? round(nextRate * 100, 2) : undefined
      }
    })
    for (const [materialId, delta] of amountByMaterial) {
      const material = await db.materials.get(materialId)
      if (!material) continue
      const stock = round((Number.isFinite(material.stock) ? material.stock : 0) + delta, USAGE_DIGITS)
      await db.materials.update(materialId, { stock: Math.max(stock, 0), updatedAt: Date.now() })
    }
    await db.batches.update(batchId, {
      materialUsage: { basisPerUnit: batch.materialUsage.basisPerUnit, items },
      updatedAt: Date.now()
    })
  })
  return deltas
}

/**
 * 香方配比变更后重算该方下所有未入窖（且未锁定）批次的预留。
 * 任一批容量不够则跳过该批（保留原预留，页面提示），不影响其它批。
 * 返回因库存不足未能重算的批次。
 */
export async function recalcReservationsForFormula(formulaId: string): Promise<Batch[]> {
  const rejected: Batch[] = []
  const [proportions, materials, batches, cellars] = await Promise.all([
    db.proportions.where('formulaId').equals(formulaId).toArray(),
    db.materials.toArray(),
    db.batches.where('formulaId').equals(formulaId).toArray(),
    db.cellars.toArray()
  ])
  const materialMap = new Map(materials.map((material) => [material.id, material]))
  const cellaredBatchIds = new Set(cellars.map((cellar) => cellar.batchId))

  for (const batch of batches) {
    if (cellaredBatchIds.has(batch.id)) continue
    const ledger = recalcLedger({
      ledger: batch.materialUsage ?? createEmptyLedger(),
      proportions,
      materialMap,
      quantity: batch.quantity
    })
    const check = await checkCapacity(ledger, batch.id)
    if (!check.ok) {
      rejected.push(batch)
      continue
    }
    let committed = true
    await db.transaction('rw', [db.batches, db.materials, db.cellars], async () => {
      const recheck = await checkCapacity(ledger, batch.id)
      if (!recheck.ok) {
        committed = false
        return
      }
      await db.batches.update(batch.id, { materialUsage: ledger, updatedAt: Date.now() })
    })
    if (!committed) rejected.push(batch)
  }
  return rejected
}
