import 'fake-indexeddb/auto'
import { db } from '../src/utils/db'
import {
  checkCapacity,
  createBatchWithUsage,
  lockBatchUsage,
  recalcLedger,
  settleSpoil,
  unlockBatchUsage,
  updateBatchQuantity,
  createEmptyLedger,
  buildUsageFromSnapshot
} from '../src/utils/materialLedger'
import type { Material } from '../src/types/material'
import type { Proportion } from '../src/types/proportion'
import type { Batch, BatchSnapshotItem } from '../src/types/batch'
import type { Cellar } from '../src/types/cellar'

let passed = 0
let failed = 0
function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${msg}`)
  } else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}

function makeMaterial(id: string, stock: number): Material {
  return {
    id,
    name: id,
    origin: '产地',
    grade: '一级',
    processMethod: '生用',
    aromaNote: '',
    stock,
    unit: 'g',
    createdAt: '2026-01-01',
    updatedAt: 1
  }
}

function makeProps(): Proportion[] {
  return [
    { id: 'p1', formulaId: 'f1', materialId: 'm1', ratio: 60, role: '君', note: '', seq: 1, updatedAt: 1 },
    { id: 'p2', formulaId: 'f1', materialId: 'm2', ratio: 40, role: '臣', note: '', seq: 2, updatedAt: 1 }
  ]
}

function snapshot(rows: Array<[string, number]>): BatchSnapshotItem[] {
  return rows.map(([materialId, ratio]) => ({ materialId, materialName: materialId, ratio, role: '君' }))
}

function makeBatch(id: string, quantity: number, snap: BatchSnapshotItem[], usage = true): Batch {
  const items = buildUsageFromSnapshot(snap, quantity, 1).map((item) => ({
    ...item,
    unit: 'g'
  }))
  return {
    id,
    formulaId: 'f1',
    mixedAt: '2026-01-02',
    formingMethod: '挤条',
    quantity,
    operator: '甲',
    snapshot: snap,
    snapshotAt: 1,
    materialUsage: usage ? { basisPerUnit: 1, items } : createEmptyLedger(),
    updatedAt: 1
  }
}

async function resetDb(version?: number): Promise<void> {
  db.close()
  // 删掉库强制走 upgrade
  await new Promise<void>((resolve) => indexedDB.deleteDatabase('gbincense').onsuccess = () => resolve())
  if (version) {
    // 直接写一个 v2 形态的老库来验证迁移
    await seedV2()
  } else {
    await db.open()
  }
}

/** 手工造 v2 老库（无 stock/unit/materialUsage/spoil 字段） */
async function seedV2(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('gbincense', 2)
    req.onupgradeneeded = () => {
      const idb = req.result
      idb.createObjectStore('formulas', { keyPath: 'id' })
      idb.createObjectStore('materials', { keyPath: 'id' })
      idb.createObjectStore('proportions', { keyPath: 'id' })
      idb.createObjectStore('batches', { keyPath: 'id' })
      idb.createObjectStore('cellars', { keyPath: 'id' })
      idb.createObjectStore('tastings', { keyPath: 'id' })
    }
    req.onsuccess = async () => {
      const idb = req.result
      await new Promise<void>((done) => {
        const tx = idb.transaction(['materials', 'proportions', 'batches', 'cellars'], 'readwrite')
        tx.objectStore('materials').put({
          id: 'm1',
          name: '沉香',
          origin: '海南',
          grade: '特级',
          processMethod: '生用',
          aromaNote: '',
          createdAt: '2024-01-01',
          updatedAt: 1
        })
        tx.objectStore('materials').put({
          id: 'm2',
          name: '檀香',
          origin: '印度',
          grade: '一级',
          processMethod: '酒蒸',
          aromaNote: '',
          createdAt: '2024-01-01',
          updatedAt: 1
        })
        tx.objectStore('proportions').put({
          id: 'p1',
          formulaId: 'f1',
          materialId: 'm1',
          ratio: 60,
          role: '君',
          note: '',
          seq: 1,
          updatedAt: 1
        })
        tx.objectStore('proportions').put({
          id: 'p2',
          formulaId: 'f1',
          materialId: 'm2',
          ratio: 40,
          role: '臣',
          note: '',
          seq: 2,
          updatedAt: 1
        })
        // 未入窖老批次：100 支 → m1 预留 60、m2 预留 40
        tx.objectStore('batches').put({
          id: 'b1',
          formulaId: 'f1',
          mixedAt: '2024-02-01',
          formingMethod: '挤条',
          quantity: 100,
          operator: '甲',
          snapshot: [
            { materialId: 'm1', materialName: '沉香', ratio: 60, role: '君' },
            { materialId: 'm2', materialName: '檀香', ratio: 40, role: '臣' }
          ],
          snapshotAt: 1,
          updatedAt: 1
        })
        // 已入窖老批次：50 支，应锁定
        tx.objectStore('batches').put({
          id: 'b2',
          formulaId: 'f1',
          mixedAt: '2024-03-01',
          formingMethod: '挤条',
          quantity: 50,
          operator: '乙',
          snapshot: [{ materialId: 'm1', materialName: '沉香', ratio: 60, role: '君' }],
          snapshotAt: 1,
          updatedAt: 1
        })
        tx.objectStore('cellars').put({
          id: 'c1',
          batchId: 'b2',
          startDate: '2024-03-05',
          endDate: '2025-03-05',
          temperatureC: 22,
          humidityPct: 60,
          container: '陶罐',
          state: '窖藏中',
          updatedAt: 1
        })
        tx.oncomplete = () => done()
      })
      idb.close()
      resolve()
    }
    req.onerror = () => reject(req.error)
  })
}

async function freshScenario(): Promise<void> {
  await resetDb()
  await db.materials.bulkPut([makeMaterial('m1', 100), makeMaterial('m2', 60)])
}

async function test1CapacityAndCreate(): Promise<void> {
  console.log('1) 容量校验 + 开批预留 + 不足整批拒绝')
  await freshScenario()
  const materialMap = new Map((await db.materials.toArray()).map((m) => [m.id, m]))
  const ledger = recalcLedger({ ledger: createEmptyLedger(), proportions: makeProps(), materialMap, quantity: 100 })
  // m1 需 60（库存 100），m2 需 40（库存 60）→ 可预留
  let check = await checkCapacity(ledger, null)
  assert(check.ok, '100 支：m1 需 60 / m2 需 40，库存足够')

  const { result } = await createBatchWithUsage({
    batch: makeBatch('b1', 100, snapshot([
      ['m1', 60],
      ['m2', 40]
    ]))
  })
  assert(result.ok, '开批预留成功')

  // 再来一批 100 支：m1 余 40 需 60 差 20；m2 余 20 需 40 差 20 → 整批拒绝
  const ledger2 = recalcLedger({ ledger: createEmptyLedger(), proportions: makeProps(), materialMap, quantity: 100 })
  check = await checkCapacity(ledger2, null)
  assert(!check.ok, '再来 100 支容量不足，整批拒绝')
  assert(check.shortages.length === 2, `缺 2 味（实际 ${check.shortages.length}）`)
  const s1 = check.shortages.find((s) => s.materialId === 'm1')
  assert(s1?.available === 40 && s1?.reservedByOthers === 60 && s1?.shortAmount === 20, 'm1 需 60、余 40、它批已留 60、差 20')
  const countAfter = await db.batches.count()
  assert(countAfter === 1, '被拒批次未写库')
}

async function test2ConcurrentSameBatch(): Promise<void> {
  console.log('2) 两个标签页同时提交同一批领用，只一边生效')
  await freshScenario()
  const materialMap = new Map((await db.materials.toArray()).map((m) => [m.id, m]))
  // 库存只够一批 100 支（m1=100,m2=60）
  const mk = (id: string) =>
    makeBatch(
      id,
      100,
      snapshot([
        ['m1', 60],
        ['m2', 40]
      ])
    )
  const [a, b] = await Promise.all([
    createBatchWithUsage({ batch: mk('bA') }),
    createBatchWithUsage({ batch: mk('bB') })
  ])
  const oks = [a.result.ok, b.result.ok].filter(Boolean).length
  assert(oks === 1, `恰好一边预留成功（成功数 ${oks}）`)
  const count = await db.batches.count()
  assert(count === 1, `库里只有一个批次（实际 ${count}）`)
  const loser = a.result.ok ? b.result : a.result
  assert(loser.shortages.length === 2, '后到者报出缺哪几味')
}

async function test3QuantityShrinkAndGrow(): Promise<void> {
  console.log('3) 改数量：调小退回多占，调大重新校验')
  await freshScenario()
  const b = makeBatch(
    'b1',
    100,
    snapshot([
      ['m1', 60],
      ['m2', 40]
    ])
  )
  await db.batches.put(b)
  const materialMap = new Map((await db.materials.toArray()).map((m) => [m.id, m]))

  // 同一批改到 50 支：m1 需 30、m2 需 20
  let r = await updateBatchQuantity({
    batchId: 'b1',
    quantity: 50,
    patch: {},
    proportions: makeProps(),
    materialMap
  })
  assert(r.ok, '数量调小成功，多占退回')
  const saved = (await db.batches.get('b1')) as Batch
  assert(saved.materialUsage.items.find((i) => i.materialId === 'm1')?.requiredAmount === 30, 'm1 占用变为 30g')

  // 另一批 80 支：m1 需 48（余 70），m2 需 32（余 40）→ 可以
  const ledger80 = recalcLedger({ ledger: createEmptyLedger(), proportions: makeProps(), materialMap, quantity: 80 })
  const c80 = await checkCapacity(ledger80, null)
  assert(c80.ok, '退回后另一批 80 支可以预留（m2 余 40 需 32）')

  // b1 想从 50 改回 200：m1 需 120（库存 100），整批拒绝、保留 50
  r = await updateBatchQuantity({ batchId: 'b1', quantity: 200, patch: {}, proportions: makeProps(), materialMap })
  assert(!r.ok, '数量调大撑不住，整批拒绝')
  const still = (await db.batches.get('b1')) as Batch
  assert(still.quantity === 50, '数量仍是 50（原预留保留）')
}

async function test4LockAndSpoil(): Promise<void> {
  console.log('4) 入窖锁定释放容量，出窖报废按损耗回冲')
  await freshScenario()
  await db.batches.put(
    makeBatch(
      'b1',
      100,
      snapshot([
        ['m1', 60],
        ['m2', 40]
      ])
    )
  )
  const cellar: Cellar = {
    id: 'c1',
    batchId: 'b1',
    startDate: '2026-02-01',
    endDate: '2026-10-01',
    temperatureC: 22,
    humidityPct: 60,
    container: '陶罐',
    state: '窖藏中',
    spoilCount: 0,
    spoilRatePct: 0,
    updatedAt: 1
  }
  await db.cellars.put(cellar)
  await lockBatchUsage('b1')
  const b1 = (await db.batches.get('b1')) as Batch
  assert(b1.materialUsage.items.every((i) => i.locked), '入窖后逐味锁定')

  // 锁定后不再占容量：新批 100 支也能过
  const materialMap = new Map((await db.materials.toArray()).map((m) => [m.id, m]))
  const ledger100 = recalcLedger({ ledger: createEmptyLedger(), proportions: makeProps(), materialMap, quantity: 100 })
  assert((await checkCapacity(ledger100, null)).ok, '锁定批次不占容量，新批 100 支可预留')

  // 出窖报废 10%：回冲 = 用量 × 10% → m1 +6、m2 +4
  await settleSpoil('b1', 10, 0)
  const m1 = (await db.materials.get('m1')) as Material
  const m2 = (await db.materials.get('m2')) as Material
  assert(m1.stock === 106, `m1 库存 100+6=106（实际 ${m1.stock}）`)
  assert(m2.stock === 64, `m2 库存 60+4=64（实际 ${m2.stock}）`)

  // 改报废为 20%：增量 +10% → m1 112、m2 68
  await settleSpoil('b1', 20, 10)
  const m1b = (await db.materials.get('m1')) as Material
  assert(m1b.stock === 112, `报废改 20%，m1=112（实际 ${m1b.stock}）`)

  // 回退为在窖（rate 20→0）：领回
  await settleSpoil('b1', 0, 20)
  const m1c = (await db.materials.get('m1')) as Material
  assert(m1c.stock === 100, `回退在窖，m1 恢复 100（实际 ${m1c.stock}）`)

  // 解锁后恢复预留身份，新批 100 支再次被拒
  await db.cellars.clear()
  await unlockBatchUsage('b1')
  const b1again = (await db.batches.get('b1')) as Batch
  assert(b1again.materialUsage.items.every((i) => !i.locked), '删窖藏后解锁')
  assert(!(await checkCapacity(ledger100, null)).ok, '解锁后重新占用容量')
}

async function test5Upgrade(): Promise<void> {
  console.log('5) v2 老档案升级：补用料账、按预留补库存、入窖锁定')
  await resetDb(2)
  await db.open() // 触发 v2 → v3 upgrade（db 实例已声明 v3）
  const m1 = (await db.materials.get('m1')) as Material & { unit?: string }
  const m2 = (await db.materials.get('m2')) as Material
  assert(m1.unit === 'g', '香料补单位 g')
  // 未入窖 b1 预留 m1=60；b2 已入窖不占 → m1 库存补 60；m2 只被 b1 占 40
  assert(m1.stock === 60, `m1 库存按现有预留补 60（实际 ${m1.stock}）`)
  assert(m2.stock === 40, `m2 库存按现有预留补 40（实际 ${m2.stock}）`)
  const b1 = (await db.batches.get('b1')) as Batch
  assert(b1.materialUsage.items.length === 2, 'b1 补出 2 味用料账')
  assert(!b1.materialUsage.items.some((i) => i.locked), 'b1 未入窖，不锁定')
  const b2 = (await db.batches.get('b2')) as Batch
  assert(b2.materialUsage.items.every((i) => i.locked), 'b2 已入窖，用料锁定')
  assert(b2.materialUsage.items[0].requiredAmount === 30, 'b2 m1 用量 60%×50=30')
  const c1 = (await db.cellars.get('c1')) as Cellar
  assert(c1.spoilCount === 0 && c1.spoilRatePct === 0, '窖藏补报废字段为 0')
  db.close()
}

async function test6Pending(): Promise<void> {
  console.log('6) 缺配比的味留空待核对、不占库存')
  await resetDb()
  await db.materials.bulkPut([makeMaterial('m1', 100), makeMaterial('m2', 60)])
  const batch = makeBatch(
    'b1',
    100,
    snapshot([
      ['m1', 60],
      ['mGone', 40]
    ])
  )
  const materialMap = new Map((await db.materials.toArray()).map((m) => [m.id, m]))
  // 当前配比只剩 m1（mGone 已从方中移除）
  const ledger = recalcLedger({
    ledger: batch.materialUsage,
    proportions: makeProps().filter((p) => p.materialId === 'm1'),
    materialMap,
    quantity: 100
  })
  const gone = ledger.items.find((i) => i.materialId === 'mGone')
  assert(gone?.pending === true && gone.requiredAmount === 0, '移除的味标记 pending、用量 0')
  const check = await checkCapacity(ledger, null)
  assert(check.ok && check.shortages.length === 0, 'pending 味不参与容量校验')
}

async function main(): Promise<void> {
  await test1CapacityAndCreate()
  await test2ConcurrentSameBatch()
  await test3QuantityShrinkAndGrow()
  await test4LockAndSpoil()
  await test5Upgrade()
  await test6Pending()
  db.close()
  console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
  if (failed > 0) process.exit(1)
}

void main()
