/** 和香批次：一次实际的配料与成型作业 */
export type FormingMethod = '挤条' | '手搓' | '压模' | '炼蜜成丸'

/** 批次生成时固化的配比快照条目，用于追溯改方前后的差异 */
export interface BatchSnapshotItem {
  materialId: string
  materialName: string
  ratio: number
  role: string
}

/**
 * 一味香料的用料账条目。
 * - 未入窖批次：跟香方当前配比走，改方后由系统重算（locked=false）；
 * - 已入窖批次：用料锁成入窖当时那一份（locked=true），此后改方不再影响。
 */
export interface MaterialUsageItem {
  materialId: string
  materialName: string
  /** 占比 %，重算 / 锁定时的依据 */
  ratio: number
  role: string
  /** 按数量折算的实际用料（ratio% × quantity） */
  requiredAmount: number
  /** 单位，随香料库走；香料被删后保留最后一次的单位 */
  unit: string
  /** 是否已锁定为入窖当时的用料 */
  locked: boolean
  /** 缺配比待核对：香方当前配比里查不到这味（重算无法覆盖） */
  pending: boolean
  /** 出窖时按损耗率回冲（退回库存容量）的量 */
  writeBackAmount?: number
  /** 出窖报废核销的损耗量 */
  spoilAmount?: number
  /** 出窖登记的报废比例 % */
  writeBackRatePct?: number
}

/** 批次用料账：逐味登记应领用量 */
export interface BatchMaterialLedger {
  /** 折算基准：单件制品合计用料（= 配比 100% 时的每单件香粉量） */
  basisPerUnit: number
  items: MaterialUsageItem[]
}

export interface Batch {
  id: string
  /** 所属香方 */
  formulaId: string
  /** 和香日期（ISO 日期串 yyyy-MM-dd） */
  mixedAt: string
  /** 成型方式：挤条/手搓/压模/炼蜜成丸 */
  formingMethod: FormingMethod
  /** 数量（支 / 丸 / 饼） */
  quantity: number
  /** 制香人 */
  operator: string
  /** 和香当刻固化的配比快照 */
  snapshot: BatchSnapshotItem[]
  /** 快照固化时间戳 */
  snapshotAt: number
  /** 用料账：按配比与数量折算的逐味领料量（v3 新增，老数据升级时补出） */
  materialUsage: BatchMaterialLedger
  updatedAt: number
}

export const FORMING_METHODS: FormingMethod[] = ['挤条', '手搓', '压模', '炼蜜成丸']

/** 折算基准：单件制品按 1g 香粉计，用料 = 占比% × 数量（克/毫升/片同数） */
export const DEFAULT_BASIS_PER_UNIT = 1

/** 预留校验里一味香料的缺口 */
export interface MaterialShortage {
  materialId: string
  materialName: string
  unit: string
  /** 本批需领 */
  requiredAmount: number
  /** 库存总量 */
  stock: number
  /** 扣除其它预留后还能让出的量 */
  available: number
  /** 已被未入窖批次预留的量 */
  reservedByOthers: number
  /** 缺口 = 需领 - 可让 */
  shortAmount: number
}

/** 预留 / 重算的校验结果：容量不足时整批拒绝 */
export interface MaterialCommitResult {
  ok: boolean
  shortages: MaterialShortage[]
  message: string
}

/** 批次列表行：批次 + 香方 + 窖藏状态 */
export interface BatchRow {
  batch: Batch
  formulaName: string
  /** 快照条目数 */
  snapshotCount: number
  /** 当前配比合计，用于对照快照差异 */
  currentRatioTotal: number
  /** 快照配比合计 */
  snapshotRatioTotal: number
  /** 是否已进入窖藏 */
  cellared: boolean
  cellarState: string
}

/** 批次筛选条件 */
export interface BatchFilterState {
  keyword: string
  formulas: string[]
  formingMethods: FormingMethod[]
}

export function createEmptyBatchFilter(): BatchFilterState {
  return { keyword: '', formulas: [], formingMethods: [] }
}
