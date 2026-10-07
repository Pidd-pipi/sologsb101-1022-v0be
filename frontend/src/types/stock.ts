/**
 * 用料账：把香料库（容量）、香方配比、和香批次并成同一条账。
 * 一味香料在一个批次下对应一条台账（StockLine），随批次状态在
 * 预留（reserved）→ 入窖锁定（locked）→ 出窖报废（wasted）之间流转。
 */
import { STOCK_UNIT as UNIT } from '@/types/material'

export { STOCK_UNIT } from '@/types/material'

/** 台账状态：预留（未入窖，跟配比/数量重算）/ 锁定（已入窖，用料冻在开批那份）/ 报损（出窖报废） */
export type StockLineStatus = 'reserved' | 'locked' | 'wasted'

export const STOCK_LINE_STATUSES: StockLineStatus[] = ['reserved', 'locked', 'wasted']

/** 台账状态文案，表格与筛选项消费 */
export const STOCK_LINE_STATUS_LABEL: Record<StockLineStatus, string> = {
  reserved: '预留中',
  locked: '入窖锁定',
  wasted: '出窖报损'
}

/**
 * 用料台账一条 = 一味香料 × 一个和香批次。
 * 预留阶段 amount 按「数量 × 占比 / 100」折算；入窖后 amount 与 ratio 冻结，
 * 不再随香方配比变化重算。
 */
export interface StockLine {
  /** 确定性主键：`${batchId}__${materialId}`，重算时整批替换 */
  id: string
  batchId: string
  formulaId: string
  materialId: string
  /** 预留当刻的香料名快照，香料被删后仍能显示 */
  materialName: string
  /** 占比 %（预留阶段跟配比，锁定后冻结） */
  ratio: number
  /** 批次数量（预留阶段跟数量，锁定后冻结） */
  quantity: number
  /** 折料用量：quantity × ratio / 100（克） */
  amount: number
  status: StockLineStatus
  /** 入窖锁定时间戳；未入窖为 0 */
  lockedAt: number
  /** 报废时登记的损耗量（克）；回退报废时清零 */
  wastedAmount: number
  /** 损耗比例（0~100），报废登记时写入 */
  wastePct: number
  /** 报废时间戳；未报废为 0 */
  wastedAt: number
  updatedAt: number
}

/** 金额比较容差（克），低于该差值视为持平 */
export const STOCK_EPSILON = 0.01

/** 库存不足错误：登记/调量/重算整批拒绝时携带缺料明细 */
export interface StockShortageItem {
  materialId: string
  materialName: string
  /** 需要量（克） */
  required: number
  /** 当前可用（克，可能为负，表示此前已被其它预留占超） */
  available: number
  /** 缺口（克） */
  short: number
}

export class StockShortageError extends Error {
  shortages: StockShortageItem[]
  constructor(shortages: StockShortageItem[]) {
    super(shortages.map((item) => `${item.materialName} 差 ${item.short}${UNIT}`).join('；'))
    this.name = 'StockShortageError'
    this.shortages = shortages
  }
}

/** 台账重算模式：strict 整批拒绝并抛出；best 强行重写并把超占暴露为缺口 */
export type ReconcileMode = 'strict' | 'best'

/** 单味折料 */
export function calcAmount(quantity: number, ratio: number): number {
  if (!Number.isFinite(quantity) || !Number.isFinite(ratio)) return 0
  return Math.round(quantity * ratio) / 100
}

/** 确定性台账主键 */
export function stockLineId(batchId: string, materialId: string): string {
  return `${batchId}__${materialId}`
}
