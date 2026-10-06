<template>
  <section class="page" data-module="hazard">
    <header class="page-head">
      <div>
        <h2>隐患整改管理</h2>
        <p class="page-desc">维护隐患记录，围绕隐患编号、隐患部位、隐患等级、整改措施做登记、筛选与状态流转；消防检测判「需维修」的结论自动回写本台账挂出待整改，验收通过后同步回填消防侧维修闭环。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记隐患记录</button>
        <button class="btn" type="button" @click="exportRows">导出隐患整改管理清单</button>
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

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            {{ row[column] ?? '—' }}
            <em v-if="column === '整改状态' && row['来源设施']" class="source-tag">消防检测回写</em>
          </td>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无隐患整改管理数据，可先登记隐患记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条隐患整改管理记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  submitAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('hazard')
const columns = meta.fields
const actions = meta.actions
const statuses = meta.statuses

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const stats = computed(() => [
  { label: '待整改隐患', value: rows.value.filter((row) => String(row.status) === '待整改').length },
  { label: '整改中隐患', value: rows.value.filter((row) => String(row.status) === '整改中').length },
  { label: '已逾期隐患', value: rows.value.filter((row) => String(row.status) === '已逾期').length },
])

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '隐患记录登记入口尚未接入审批流'
}

async function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = await applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '隐患整改管理列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.source-tag {
  font-style: normal;
  font-size: 12px;
  color: #b42318;
  background: #fef3f2;
  border-radius: 999px;
  padding: 1px 8px;
  margin-left: 6px;
}
</style>
