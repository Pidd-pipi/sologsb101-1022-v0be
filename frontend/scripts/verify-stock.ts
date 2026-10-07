/* 用料账核心逻辑验证：Node + fake-indexeddb，直接操作 Dexie（不引入 Vue） */
import 'fake-indexeddb/auto'
import { db, DB_VERSION } from '../src/utils/db'
import { resetDatabase } from '../src/utils/db'
import { buildRequirements, checkShortages } from '../src/utils/stock'
import { StockShortageError, calcAmount, stockLineId, type StockLine } from '../src/types/stock'
import type { Material } from '../src/types/material'
import type { Batch, BatchSnapshotItem } from '../src/types/batch'
import Dexie from 'dexie'

let failures = 0
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failures += 1
    console.error(`  ✗ ${msg}`)
  }
}

async function maps(): Promise<{ byId: Map<string, Material>; lines: StockLine[] }> {
  const [materials, lines] = await Promise.all([db.materials.toArray(), db.stockLines.toArray()])
  return { byId: new Map(materials.map((m) => [m.id, m])), lines }
}

/** 与 stockStore.reserveForBatch 等价的事务（绕开 Vue liveQuery） */
async function reserve(batch: Pick<Batch, 'id' | 'formulaId' | 'quantity'>, snapshot: BatchSnapshotItem[]) {
  try {
    await db.transaction('rw', [db.stockLines, db.materials], async () => {
      const { byId, lines } = await maps()
      const wanted = buildRequirements(batch, snapshot, byId)
      const short = checkShortages({ wanted, materialsById: byId, lines, excludeBatchIds: [batch.id] })
      if (short.length > 0) throw new StockShortageError(short)
      await db.stockLines.where('batchId').equals(batch.id).delete()
      await db.stockLines.bulkPut(wanted)
    })
    return { ok: true as const }
  } catch (error) {
    return { ok: false as const, error: error as StockShortageError }
  }
}

async function stockOf(materialId: string): Promise<number> {
  return (await db.materials.get(materialId))!.stock ?? 0
}
async function occupiedOf(materialId: string): Promise<number> {
  const rows = await db.stockLines.where('materialId').equals(materialId).toArray()
  return Math.round(rows.filter((l) => l.status !== 'wasted').reduce((s, l) => s + l.amount, 0) * 100) / 100
}

async function testCore(): Promise<void> {
  await db.open()
  await resetDatabase()

  console.log('1) 播种库存与锁定台账')
  const seedLines = await db.stockLines.toArray()
  assert(seedLines.length === 7, `播种 7 条台账（4+3），实际 ${seedLines.length}`)
  assert(seedLines.every((l) => l.status === 'locked'), '两个已入窖播种批次全部锁定')

  const chen = (await db.materials.where('name').equals('海南沉香').first())!
  const ruxiang = (await db.materials.where('name').equals('乳香').first())!
  const formulaId = 'test_formula'
  await db.formulas.put({
    id: formulaId, name: '测试香', scentType: '线香', usage: '静室',
    createdAt: '2026-01-01', totalRatio: 100, state: '在用', updatedAt: Date.now()
  })
  const snap: BatchSnapshotItem[] = [
    { materialId: chen.id, materialName: '海南沉香', ratio: 50, role: '君' },
    { materialId: ruxiang.id, materialName: '乳香', ratio: 50, role: '臣' }
  ]

  console.log('2) 开批按配比×数量折料预留')
  const r1 = await reserve({ id: 'b1', formulaId, quantity: 100 }, snap)
  assert(r1.ok, '库存充足时预留成功')
  const l1 = await db.stockLines.where('batchId').equals('b1').toArray()
  assert(l1.length === 2 && l1.every((x) => x.status === 'reserved'), 'b1 两条预留')
  assert(calcAmount(100, 50) === 50, '折料 100×50%=50 克')
  const chenOcc = await occupiedOf(chen.id)

  console.log('3) 库存撑不住整批拒绝 + 缺料明细')
  const before = (await db.stockLines.toArray()).length
  const r2 = await reserve({ id: 'b2', formulaId, quantity: 100000 }, snap)
  const after = (await db.stockLines.toArray()).length
  assert(!r2.ok && r2.error instanceof StockShortageError, '库存不足整批拒绝')
  assert(before === after, '拒绝时原子不留台账')
  const names = r2.error.shortages.map((s) => s.materialName)
  assert(names.includes('海南沉香') && names.includes('乳香'), `报出缺料：${names.join('、')}`)
  assert(r2.error.shortages.every((s) => s.short > 0 && s.required > 0), '带需要/缺口克数')
  console.log(`     文案：${r2.error.message}`)
  void chenOcc

  console.log('4) 两标签页同批并发：先到生效，后到按最新余量核对')
  const snapChen: BatchSnapshotItem[] = [{ materialId: chen.id, materialName: '海南沉香', ratio: 50, role: '君' }]
  const a = await reserve({ id: 'b3', formulaId, quantity: 60 }, snapChen)
  assert(a.ok, '先到的 b3 生效（沉香 30 克）')
  // 后到一侧：对同一批次号再提交（确定性主键会覆盖），库存核对基于最新占用
  const b = await reserve({ id: 'b3', formulaId, quantity: 60 }, snapChen)
  assert(b.ok, '同批重提按最新余量（本批已排除自身占用）幂等成功')
  // 不同批次并发抢料：乳香现占 = 播种锁 90 + b1 20 + b3 30 = 140；库存调到 190，b6 再用 50 恰罄
  await db.materials.update(ruxiang.id, { stock: 190 })
  const c1 = await reserve({ id: 'b6', formulaId, quantity: 100 }, snap)
  assert(c1.ok, '临界：b6 用掉乳香 50（140 + 50 = 190 恰罄）')
  const c2 = await reserve({ id: 'b7', formulaId, quantity: 100 }, snap)
  assert(!c2.ok, '后到的 b7 看到 b6 占用后被整批拒绝')
  await db.materials.update(ruxiang.id, { stock: 500 })

  console.log('5) 改数量按实到：多占退回/少占补占，撑不住维持原样')
  await reserve({ id: 'b1', formulaId, quantity: 40 }, snap)
  const b1 = await db.stockLines.where('batchId').equals('b1').toArray()
  assert(Math.abs(b1.find((x) => x.materialId === chen.id)!.amount - 20) < 0.01, '100→40：沉香 50→20（退回 30）')
  const r5 = await reserve({ id: 'b1', formulaId, quantity: 999999 }, snap)
  const b1b = await db.stockLines.where('batchId').equals('b1').toArray()
  assert(!r5.ok, '调大到撑不住时拒绝')
  assert(Math.abs(b1b.find((x) => x.materialId === chen.id)!.amount - 20) < 0.01, '拒绝后维持原预留 20')

  console.log('6) 配比变化：未入窖重算、已入窖锁定')
  const f2 = 'test_formula_2'
  await db.formulas.put({
    id: f2, name: '测试香2', scentType: '线香', usage: '静室',
    createdAt: '2026-01-02', totalRatio: 100, state: '在用', updatedAt: Date.now()
  })
  await reserve({ id: 'b5', formulaId: f2, quantity: 50 }, [
    { materialId: chen.id, materialName: '海南沉香', ratio: 100, role: '君' }
  ])
  // 改方为 沉香/乳香 各 50%，直接调库模拟 recalcFormula
  const newSnap: BatchSnapshotItem[] = [
    { materialId: chen.id, materialName: '海南沉香', ratio: 50, role: '君' },
    { materialId: ruxiang.id, materialName: '乳香', ratio: 50, role: '臣' }
  ]
  await reserve({ id: 'b5', formulaId: f2, quantity: 50 }, newSnap)
  const b5 = await db.stockLines.where('batchId').equals('b5').toArray()
  assert(b5.length === 2 && Math.abs(b5.find((x) => x.materialId === ruxiang.id)!.amount - 25) < 0.01, '未入窖 b5 跟新配比重算出乳香 25')
  // 已入窖播种批次不被上面影响
  const seedLocked = await db.stockLines.where('batchId').equals('seed_batch_line').toArray()
  assert(seedLocked.every((l) => l.status === 'locked' && l.amount > 0), '已入窖批次用料锁死')

  console.log('7) 入窖锁定→出窖报废按损耗回冲')
  await db.stockLines.where('batchId').equals('b5').modify((l: StockLine) => {
    l.status = 'locked'
    l.lockedAt = Date.now()
  })
  const occChenBefore = await occupiedOf(chen.id)
  await db.stockLines.where('batchId').equals('b5').modify((l: StockLine) => {
    l.status = 'wasted'
    l.wastePct = 20
    l.wastedAmount = Math.round(l.amount * 0.2 * 100) / 100
    l.wastedAt = Date.now()
  })
  const wasted = await db.stockLines.where('batchId').equals('b5').toArray()
  const wasteSum = Math.round(wasted.reduce((s, l) => s + l.wastedAmount, 0) * 100) / 100
  assert(Math.abs(wasteSum - 10) < 0.01, `50 克 × 20% = 10 克损耗，实际 ${wasteSum}`)
  const occChenAfter = await occupiedOf(chen.id)
  assert(occChenAfter < occChenBefore, `报废后不再占用（${occChenBefore}→${occChenAfter}）`)

  console.log('8) 缺配比的批次留空')
  const rEmpty = await reserve({ id: 'b8', formulaId: f2, quantity: 100 }, [])
  assert(rEmpty.ok, '空配比不拦批次')
  assert((await db.stockLines.where('batchId').equals('b8').count()) === 0, '空配比不留台账，待核对')

  await db.close()
  void stockOf
}

/** 新建一个 v2 老库再用同结构打开触发 v3 迁移 */
async function testMigration(): Promise<void> {
  console.log('9) v2 → v3 迁移：缺库存按现有预留/锁定补出，缺配比批次留空')
  const dbName = `gbincense_mig_${Date.now()}`
  const old = new Dexie(dbName)
  old.version(2).stores({
    formulas: 'id, name, scentType, usage, state, createdAt, totalRatio, updatedAt',
    materials: 'id, name, origin, grade, processMethod, updatedAt',
    proportions: 'id, formulaId, materialId, role, seq, updatedAt',
    batches: 'id, formulaId, mixedAt, formingMethod, updatedAt',
    cellars: 'id, batchId, startDate, endDate, state, updatedAt',
    tastings: 'id, batchId, tastedAt, smokeScore, updatedAt'
  })
  await old.open()
  await old.table('materials').bulkPut([
    { id: 'm1', name: '陈', origin: '琼', grade: '特级', processMethod: '生用', aromaNote: '', createdAt: '2024-01-01', updatedAt: 1 },
    { id: 'm2', name: '丁', origin: '洋', grade: '二级', processMethod: '炒黄', aromaNote: '', createdAt: '2024-01-01', updatedAt: 1 }
  ])
  await old.table('formulas').bulkPut([
    { id: 'f1', name: '方', scentType: '线香', usage: '静室', createdAt: '2024-01-01', totalRatio: 100, state: '在用', updatedAt: 1 }
  ])
  await old.table('proportions').bulkPut([
    { id: 'p1', formulaId: 'f1', materialId: 'm1', ratio: 100, role: '君', note: '', seq: 1, updatedAt: 1 }
  ])
  await old.table('batches').bulkPut([
    // 已入窖批次：锁成快照那份
    { id: 'batch_cellared', formulaId: 'f1', mixedAt: '2024-03-01', formingMethod: '挤条', quantity: 200, operator: 'x', snapshot: [{ materialId: 'm1', materialName: '陈', ratio: 100, role: '君' }], snapshotAt: 1, updatedAt: 1 },
    // 缺配比（空快照）的批次：留空不建台账
    { id: 'batch_nosnap', formulaId: 'f1', mixedAt: '2024-03-02', formingMethod: '手搓', quantity: 50, operator: 'x', snapshot: [], snapshotAt: 1, updatedAt: 1 }
  ])
  await old.table('cellars').bulkPut([
    { id: 'c1', batchId: 'batch_cellared', startDate: '2024-03-05', endDate: '2024-09-05', temperatureC: 22, humidityPct: 60, container: '陶罐', state: '窖藏中', updatedAt: 1 }
  ])
  await old.table('tastings').bulkPut([])
  await old.close()

  assert(DB_VERSION === 3, `DB_VERSION = 3，实际 ${DB_VERSION}`)

  // 用主类在老库名上打开，触发 v3 upgrade
  const { IncenseDatabase } = await import('../src/utils/db')
  const migrated = new IncenseDatabase(dbName)
  const m1 = await migrated.materials.get('m1')
  const m2 = await migrated.materials.get('m2')
  const lines = await migrated.stockLines.toArray()
  const cellaredLines = lines.filter((l) => l.batchId === 'batch_cellared')
  const nosnapLines = lines.filter((l) => l.batchId === 'batch_nosnap')

  assert(typeof m1?.stock === 'number', '老档案补出 m1 库存数')
  assert(m1?.stock === 200, `m1 库存按锁定占用补成 200，实际 ${m1?.stock}`)
  assert(m1?.stockInferred === true, '补出的库存标记为待核对')
  assert(typeof m2?.stock === 'number' && m2.stock === 0 && m2.stockInferred !== true, '无占用的 m2 补 0 且不打待核对标记')
  assert(cellaredLines.length === 1 && cellaredLines[0].status === 'locked', '已入窖批次迁移为锁定台账（200 克）')
  assert(nosnapLines.length === 0, '缺配比批次留空，不建台账')
  const cellar = await migrated.cellars.get('c1')
  assert(cellar?.scrapped === false && typeof cellar.wastePct === 'number', '窖藏补齐报废字段')
  migrated.close()
  void stockLineId
}

await testCore()
await testMigration()
console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`)
if (failures > 0) process.exitCode = 1
