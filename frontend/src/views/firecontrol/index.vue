<template>
  <section class="page" data-module="firecontrol">
    <header class="page-head">
      <div>
        <h2>消防系统运维管理</h2>
        <p class="page-desc">
          检测状态单向链路：待检测→检测中→状态正常/需维修→归档。只能逐档前进，跳档当场驳回；
          已归档退不回检测中；需维修的检测结论自动回写隐患整改台账并挂出待整改。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="showForm = !showForm">登记检测单</button>
        <button class="btn" type="button" @click="exportRows">导出消防设施清单</button>
        <button class="btn" type="button" @click="triggerImport">导入对账</button>
        <input ref="fileInput" type="file" accept=".csv,text/csv,text/plain" hidden @change="handleImport" />
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p
      class="consistency-banner"
      :class="consistency.consistent ? 'ok' : 'bad'"
      data-testid="consistency"
    >
      消防待办（需维修未闭环）{{ consistency.openRepairs }} 条，
      隐患整改台账对应待办 {{ consistency.openLinkedHazards }} 条：
      <strong>{{ consistency.consistent ? '条数一致' : '不一致，请核对' }}</strong>
      ；已归档 {{ consistency.archived }} 件（归档件不可回退）。
    </p>

    <form v-if="showForm" class="create-form" @submit.prevent="submitCreate">
      <label class="filter-item"><span>设施编号 *</span><input v-model="form.设施编号" placeholder="如 FIRE-0009" /></label>
      <label class="filter-item"><span>所属舱室</span><input v-model="form.所属舱室" /></label>
      <label class="filter-item">
        <span>消防类型 *</span>
        <select v-model="form.消防类型">
          <option value="">请选择</option>
          <option v-for="item in typeOptions" :key="item" :value="item">{{ item }}</option>
        </select>
      </label>
      <label class="filter-item"><span>探测器数量 *</span><input v-model.number="form.探测器数量" type="number" min="1" /></label>
      <label class="filter-item"><span>责任人员</span><input v-model="form.责任人员" /></label>
      <label class="filter-item"><span>下次检测日 *</span><input v-model="form.下次检测日" type="date" /></label>
      <div class="filter-item form-buttons">
        <button class="btn primary" type="submit">提交登记</button>
        <button class="btn ghost" type="button" @click="showForm = false">取消</button>
      </div>
    </form>

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
        <tr v-for="row in rows" :key="String(row.id)" :class="{ overdue: isOverdue(row) }">
          <td v-for="column in columns" :key="column">
            {{ row[column] ?? '—' }}
            <em v-if="column === '下次检测日' && isOverdue(row)" class="overdue-tag">已到期</em>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <template v-if="allowedActions(row).length">
              <button
                v-for="action in allowedActions(row)"
                :key="action"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
            </template>
            <span v-else class="muted-text">终态，无动作</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无消防设施数据，可先登记检测单</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条消防设施记录</span>
      <span v-if="message" class="result-text" :class="{ 'error-text': !lastOk }">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  createFireInspection,
  downloadEntries,
  fireConsistency,
  listEntries,
  moduleMeta,
  reconcileImport,
  submitAction,
  type FireInspectionInput,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('firecontrol')
const columns = meta.fields
const filterFields = ['设施编号', '所属舱室', '消防类型']
const typeOptions = [
  '感烟火灾探测器',
  '感温火灾探测器',
  '火灾自动报警系统',
  '自动喷水灭火系统',
  '消火栓系统',
  '气体灭火系统',
  '细水雾灭火系统',
  '防火卷帘',
]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const message = ref('')
const lastOk = ref(true)
const filters = ref<Record<string, string>>({})
const showForm = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

function blankForm(): FireInspectionInput {
  return {
    设施编号: '',
    所属舱室: '',
    消防类型: '',
    探测器数量: 0,
    责任人员: '',
    下次检测日: '',
  }
}
const form = reactive<FireInspectionInput>(blankForm())

const statusSummary = computed(() =>
  meta.statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => [
  { label: '待检测设施', value: countByStatus('待检测') },
  { label: '检测中设施', value: countByStatus('检测中') },
  { label: '状态正常设施', value: countByStatus('状态正常') },
  { label: '需维修设施', value: countByStatus('需维修') },
  { label: '已归档设施', value: countByStatus('已归档') },
])

const consistency = ref(fireConsistency())

function countByStatus(status: string): number {
  return rows.value.filter((row) => String(row.status) === status).length
}

// 链路只有相邻一档可点，归档后不给任何动作。
function allowedActions(row: EntryRow): string[] {
  const targets = meta.transitions?.[String(row.status)] ?? []
  return meta.actions.filter((action) => targets.includes(meta.actionTargets[action]))
}

function isOverdue(row: EntryRow): boolean {
  const value = String(row['下次检测日'] ?? '')
  return Boolean(value) && value < new Date().toISOString().slice(0, 10) && String(row.status) !== '已归档'
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function submitCreate() {
  message.value = ''
  const result = createFireInspection({ ...form })
  lastOk.value = result.ok
  message.value = result.message
  if (!result.ok) {
    return
  }
  Object.assign(form, blankForm())
  showForm.value = false
  reload()
}

async function runAction(action: string, row: EntryRow) {
  message.value = ''
  let conclusion: string | undefined
  if (action === '提出维修') {
    const input = window.prompt('检测结论（将回写隐患整改台账并挂出待整改）', '检测不合格，需维修')
    if (input === null) {
      return
    }
    conclusion = input
  }
  const result = await submitAction(meta.key, Number(row.id), action, { conclusion })
  lastOk.value = result.ok
  message.value = result.message
  reload()
}

function triggerImport() {
  fileInput.value?.click()
}

async function handleImport(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) {
    return
  }
  const text = await file.text()
  const result = reconcileImport(meta.key, text)
  lastOk.value = result.ok
  message.value = result.message
  reload()
}

function reload() {
  message.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    consistency.value = fireConsistency()
  } catch (error) {
    lastOk.value = false
    message.value = error instanceof Error ? error.message : '消防系统运维列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.consistency-banner {
  margin: 0 0 12px;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 13px;
}
.consistency-banner.ok {
  background: #ecfdf3;
  border: 1px solid #a6f4c5;
  color: #067647;
}
.consistency-banner.bad {
  background: #fef3f2;
  border: 1px solid #fecdca;
  color: #b42318;
}
.create-form {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: flex-end;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 12px;
}
.form-buttons {
  display: flex;
  gap: 8px;
}
.muted-text {
  color: var(--muted);
  font-size: 12px;
}
.overdue {
  background: #fffbeb;
}
.overdue-tag {
  color: #b54708;
  font-style: normal;
  font-size: 12px;
  margin-left: 6px;
}
.result-text:not(.error-text) {
  color: #067647;
}
</style>
