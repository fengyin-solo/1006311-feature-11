<template>
  <section class="page" data-module="firecontrol">
    <header class="page-head">
      <div>
        <h2>消防系统运维管理</h2>
        <p class="page-desc">
          状态按 待检测→检测中→状态正常/需维修→归档 单向推进，跳档当场驳回；检测结论回写隐患整改清单，归档后不可回退。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="runBackfill">回填下次检测日</button>
        <button class="btn" type="button" @click="runImport">搬入往期单据</button>
        <button class="btn" type="button" @click="exportRows">导出消防系统运维清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <p v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</p>
    <ul v-if="importLines.length" class="import-report">
      <li v-for="(line, index) in importLines" :key="index">
        【{{ line.outcome }}】{{ line.设施编号 }} / {{ line.来源单据 }}：{{ line.message }}
      </li>
    </ul>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>关联待整改</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-abnormal': row.abnormal }">
          <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
          <td>{{ openHazardCount(row) }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无消防系统运维数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条消防系统运维记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  backfillFirecontrol,
  downloadEntries,
  importFireHistory,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { FireHistoryRecord, ImportLineResult } from '@/data/firecontrol-flow'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('firecontrol')
const columns = ["设施编号", "所属舱室", "消防类型", "探测器数量", "联动测试日", "责任人员", "下次检测日", "检测结论", "消防状态"]
const actions = ["提交检测", "判定正常", "提出维修", "归档"]
const statuses = ["待检测", "检测中", "状态正常", "需维修", "归档"]

// 往期单据示例批次：一笔纸面扫描件建账（重复提交一笔验证挡回）、一笔与归档件冲突、一笔抄表周期补录。
const SAMPLE_HISTORY: FireHistoryRecord[] = [
  { 设施编号: 'FIRE-0006', 所属舱室: '综合舱', 消防类型: '火灾自动报警系统', 探测器数量: 30, 联动测试日: '2024-09-12', 责任人员: '王建国', 检测结论: '状态正常', 来源类型: '纸面扫描件', 来源单据: 'SCAN-2024-0096' },
  { 设施编号: 'FIRE-0006', 所属舱室: '综合舱', 消防类型: '火灾自动报警系统', 探测器数量: 30, 联动测试日: '2024-09-12', 责任人员: '王建国', 检测结论: '状态正常', 来源类型: '纸面扫描件', 来源单据: 'SCAN-2024-0096' },
  { 设施编号: 'FIRE-0005', 探测器数量: 99, 联动测试日: '2024-12-20', 检测结论: '状态正常', 来源类型: '抄表周期', 来源单据: '2024Q4' },
  { 设施编号: 'FIRE-0001', 联动测试日: '2025-11-20', 检测结论: '状态正常', 来源类型: '抄表周期', 来源单据: '2025Q4' },
]

const rows = ref<EntryRow[]>([])
const hazardRows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const importLines = ref<ImportLineResult[]>([])
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const stats = computed(() => [
  { label: '待检测设施', value: rows.value.filter((row) => row.status === '待检测').length },
  { label: '需维修设施', value: rows.value.filter((row) => row.status === '需维修').length },
  { label: '已归档设施', value: rows.value.filter((row) => row.status === '归档').length },
  {
    label: '消防来源待整改',
    value: hazardRows.value.filter(
      (row) => String(row['来源设施'] ?? '') !== '' && String(row.status) !== '已验收',
    ).length,
  },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function openHazardCount(row: EntryRow): number {
  return hazardRows.value.filter(
    (hazard) =>
      String(hazard['来源设施'] ?? '') === String(row['设施编号'] ?? '') &&
      String(hazard.status) !== '已验收',
  ).length
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function runBackfill() {
  errorMessage.value = ''
  const result = backfillFirecontrol()
  noticeMessage.value = result.message
  reload()
}

function runImport() {
  errorMessage.value = ''
  const result = importFireHistory(SAMPLE_HISTORY)
  noticeMessage.value = result.message
  importLines.value = result.lines
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    hazardRows.value = listEntries('hazard').items
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '消防系统运维列表读取失败'
  }
}

onMounted(() => {
  // 进入页面先按检测周期口径静默重算台账：缺的下次检测日回填，超期未闭环的标异常。
  backfillFirecontrol()
  reload()
})
</script>
