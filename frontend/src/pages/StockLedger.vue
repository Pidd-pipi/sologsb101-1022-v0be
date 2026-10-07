<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Files } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useMaterialStore } from '@/stores/materialStore'
import { useFormulaStore } from '@/stores/formulaStore'
import { useStockStore } from '@/stores/stockStore'
import { useIdbTable } from '@/hooks/useIdbTable'
import { STOCK_LINE_STATUS_LABEL, STOCK_UNIT, type StockLine, type StockLineStatus } from '@/types/stock'
import { round } from '@/utils/ratio'
import type { Batch } from '@/types/batch'

const router = useRouter()
const materialStore = useMaterialStore()
const formulaStore = useFormulaStore()
const stockStore = useStockStore()
const batchTable = useIdbTable<Batch>((database) => database.batches, { sortByUpdatedAt: false })

const statusFilter = ref<StockLineStatus | 'all'>('all')

const batchMap = computed<Record<string, Batch>>(() => {
  const map: Record<string, Batch> = {}
  batchTable.rows.value.forEach((batch) => {
    map[batch.id] = batch
  })
  return map
})

interface LedgerRow {
  line: StockLine
  formulaName: string
  batchLabel: string
  cellared: boolean
}

const ledgerRows = computed<LedgerRow[]>(() =>
  stockStore.lines
    .filter((line) => statusFilter.value === 'all' || line.status === statusFilter.value)
    .map((line) => {
      const batch = batchMap.value[line.batchId]
      return {
        line,
        formulaName: formulaStore.formulaName(line.formulaId),
        batchLabel: batch ? `${batch.mixedAt} · ${batch.formingMethod} · ${batch.quantity}` : '批次已删除',
        cellared: line.status === 'locked' || line.status === 'wasted'
      }
    })
    .sort((a, b) => b.line.updatedAt - a.line.updatedAt)
)

const balances = computed(() => materialStore.rows)

const totalCapacity = computed(() =>
  round(balances.value.reduce((sum, row) => sum + row.stock, 0), 1)
)
const totalReserved = computed(() => round(balances.value.reduce((sum, row) => sum + row.reserved, 0), 1))
const totalLocked = computed(() => round(balances.value.reduce((sum, row) => sum + row.locked, 0), 1))
const totalWasted = computed(() => round(balances.value.reduce((sum, row) => sum + row.wasted, 0), 1))
const shortMaterials = computed(() => balances.value.filter((row) => row.available < 0))
const inferredMaterials = computed(() => balances.value.filter((row) => row.inferred))

const statusTabs = computed(() => [
  { key: 'all' as const, label: `全部 ${stockStore.lines.length}` },
  { key: 'reserved' as const, label: `预留中 ${stockStore.lines.filter((l) => l.status === 'reserved').length}` },
  { key: 'locked' as const, label: `入窖锁定 ${stockStore.lines.filter((l) => l.status === 'locked').length}` },
  { key: 'wasted' as const, label: `出窖报损 ${stockStore.lines.filter((l) => l.status === 'wasted').length}` }
])

function statusTone(status: StockLineStatus): 'info' | 'success' | 'warning' {
  if (status === 'locked') return 'success'
  if (status === 'wasted') return 'warning'
  return 'info'
}

function goBatch(): void {
  void router.push('/batches')
}
</script>

<template>
  <div>
    <div class="page-title">
      <div>
        <h2>用料账（香料库 × 配比 × 和香批次）</h2>
        <p>
          开一批香按配比 × 数量折料，先按本地库存预留；入窖锁定用料，出窖报废按损耗回冲。
          共 {{ stockStore.lines.length }} 条台账 · 库存 {{ totalCapacity }}{{ STOCK_UNIT }}
        </p>
      </div>
      <div class="page-title__actions">
        <el-button :icon="Files" @click="goBatch">去登记批次</el-button>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="库存总量" :value="totalCapacity" :suffix="STOCK_UNIT" icon="Coin" tone="primary" />
      <StatBadge label="预留占用" :value="totalReserved" :suffix="STOCK_UNIT" icon="Histogram" tone="info" />
      <StatBadge label="入窖锁定" :value="totalLocked" :suffix="STOCK_UNIT" icon="Files" tone="success" />
      <StatBadge label="累计报损" :value="totalWasted" :suffix="STOCK_UNIT" icon="WarningFilled" tone="warning" />
      <StatBadge
        label="超占香料"
        :value="shortMaterials.length"
        suffix="味"
        icon="WarningFilled"
        tone="danger"
        :hint="shortMaterials.map((m) => `${m.material.name} 缺 ${Math.abs(m.available)}`).join('；')"
      />
      <StatBadge label="待核对库存" :value="inferredMaterials.length" suffix="味" icon="Histogram" tone="warning" />
    </div>

    <el-alert
      v-if="shortMaterials.length > 0"
      class="ledger-alert"
      type="error"
      show-icon
      :closable="false"
      :title="`${shortMaterials.length} 味香料已超占：${shortMaterials
        .map((m) => `${m.material.name} 差 ${Math.abs(m.available)}${STOCK_UNIT}`)
        .join('；')}`"
    />
    <el-alert
      v-if="inferredMaterials.length > 0"
      class="ledger-alert"
      type="warning"
      show-icon
      :closable="false"
      :title="`${inferredMaterials.length} 味老档案缺库存数，已按现有预留补出，请在香料库核对：${inferredMaterials
        .map((m) => m.material.name)
        .join('、')}`"
    />

    <div class="section-card">
      <div class="section-card__head">
        <h3>香料库存余量</h3>
        <span class="muted">可用 = 库存 − 预留 − 锁定；负数表示被占超，需补库存或减量</span>
      </div>
      <el-table :data="balances" size="small" row-key="material.id">
        <el-table-column label="香料" prop="material.name" min-width="120" />
        <el-table-column label="库存" width="100">
          <template #default="{ row }: { row: (typeof balances.value)[number] }">
            <span class="mono">{{ row.stock }}{{ STOCK_UNIT }}</span>
            <el-tag v-if="row.inferred" size="small" type="warning" effect="plain" round>待核对</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="预留" width="90">
          <template #default="{ row }: { row: (typeof balances.value)[number] }">
            <span class="mono">{{ row.reserved }}</span>
          </template>
        </el-table-column>
        <el-table-column label="锁定" width="90">
          <template #default="{ row }: { row: (typeof balances.value)[number] }">
            <span class="mono">{{ row.locked }}</span>
          </template>
        </el-table-column>
        <el-table-column label="报损" width="90">
          <template #default="{ row }: { row: (typeof balances.value)[number] }">
            <span class="mono">{{ row.wasted }}</span>
          </template>
        </el-table-column>
        <el-table-column label="可用" min-width="110">
          <template #default="{ row }: { row: (typeof balances.value)[number] }">
            <span class="mono" :class="row.available < 0 ? 'stock-negative' : 'stock-ok'">
              {{ row.available }}{{ STOCK_UNIT }}
            </span>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div class="section-card ledger-table">
      <div class="section-card__head">
        <h3>逐批用料流水</h3>
        <el-radio-group v-model="statusFilter" size="small">
          <el-radio-button v-for="tab in statusTabs" :key="tab.key" :value="tab.key">{{ tab.label }}</el-radio-button>
        </el-radio-group>
      </div>
      <div v-if="ledgerRows.length === 0" class="ledger-empty">
        <EmptyPanel
          title="暂无用料台账"
          description="登记和香批次时会按配比和数量折料并从本地库存预留；缺配比的批次先留空待核对。"
          action-text="去登记批次"
          :show-seed="false"
          @action="goBatch"
        />
      </div>
      <el-table v-else :data="ledgerRows" row-key="line.id" stripe>
        <el-table-column label="香方 / 批次" min-width="210">
          <template #default="{ row }: { row: LedgerRow }">
            <div class="cell-main">{{ row.formulaName }}</div>
            <div class="cell-sub muted">{{ row.batchLabel }}</div>
          </template>
        </el-table-column>
        <el-table-column label="香料" prop="line.materialName" min-width="110" />
        <el-table-column label="占比" width="80">
          <template #default="{ row }: { row: LedgerRow }">
            <span class="mono">{{ row.line.ratio }}%</span>
          </template>
        </el-table-column>
        <el-table-column label="用量" width="100">
          <template #default="{ row }: { row: LedgerRow }">
            <span class="mono">{{ row.line.amount }}{{ STOCK_UNIT }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="120">
          <template #default="{ row }: { row: LedgerRow }">
            <el-tag :type="statusTone(row.line.status)" effect="plain" round size="small">
              {{ STOCK_LINE_STATUS_LABEL[row.line.status] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="报损 / 退回" min-width="160">
          <template #default="{ row }: { row: LedgerRow }">
            <template v-if="row.line.status === 'wasted'">
              <span class="cell-sub ratio-error">损耗 {{ row.line.wastedAmount }}{{ STOCK_UNIT }}（{{ row.line.wastePct }}%）</span>
              <div class="cell-sub muted">完好退回 {{ round(row.line.amount - row.line.wastedAmount, 2) }}{{ STOCK_UNIT }}</div>
            </template>
            <span v-else class="cell-sub muted">—</span>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<style scoped>
.ledger-alert {
  margin-bottom: 12px;
}

.ledger-table {
  margin-top: 16px;
}

.ledger-empty {
  padding: 8px 0;
}

.cell-main {
  font-weight: 600;
}

.cell-sub {
  font-size: 12px;
  line-height: 1.6;
}

.stock-ok {
  color: var(--el-color-success);
  font-weight: 600;
}

.stock-negative {
  color: var(--el-color-danger);
  font-weight: 600;
}
</style>
