import {
  buildHazardForRepair,
  closeHazardsForArchive,
  planFireImport,
  planFireTransition,
  reconcileFireRows,
  reconcileHazardFlags,
} from '@/data/firecontrol-flow'
import type { FireHistoryRecord, ImportLineResult } from '@/data/firecontrol-flow'
import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 消防模块的提交流水与往期单据搬入流水：同一环节只推进一次，重复提交按先落的那一笔挡回。
const FIRE_SUBMISSIONS_KEY = 'urban-utility-tunnel:firecontrol-submissions'
const FIRE_IMPORT_LOG_KEY = 'urban-utility-tunnel:firecontrol-import-log'

// 流水先落内存，再同步 localStorage，与 entries 的持久化策略保持一致。
const logCache = new Map<string, string[]>()

function loadLog(key: string): string[] {
  const cached = logCache.get(key)
  if (cached) {
    return [...cached]
  }
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  try {
    const raw = window.localStorage.getItem(key)
    const parsed = raw ? (JSON.parse(raw) as string[]) : []
    logCache.set(key, parsed)
    return [...parsed]
  } catch {
    return []
  }
}

function saveLog(key: string, entries: string[]): void {
  logCache.set(key, [...entries])
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(key, JSON.stringify(entries))
  }
}

function todayText(): string {
  const now = new Date()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${mm}-${dd}`
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  if (key === 'firecontrol') {
    return runFireAction(id, action)
  }
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

/**
 * 消防设施的单向链路流转：待检测→检测中→状态正常/需维修→归档。
 * 跳档当场驳回并写明缺哪一步；归档是终点；同一环节重复提交只推进一次。
 */
export function runFireAction(id: number, action: string): ActionResult {
  const rows = listRows('firecontrol')
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的消防设施` }
  }
  const row = rows[index]
  const code = String(row['设施编号'] ?? id)
  const plan = planFireTransition(String(row.status), action)
  if (!plan.ok) {
    return { ok: false, message: `设施${code}：${plan.message}` }
  }
  if (action === '提交检测') {
    const running = rows.find(
      (item) => String(item['设施编号']) === code && String(item.status) === '检测中',
    )
    if (running && Number(running.id) !== id) {
      return {
        ok: false,
        message: `设施${code}：同一设施已有一笔检测中的记录，重复提交只推进先落的那一笔`,
      }
    }
  }
  const submissionKey = `${code}|${action}|${String(row.status)}`
  const submissions = loadLog(FIRE_SUBMISSIONS_KEY)
  if (submissions.includes(submissionKey)) {
    return {
      ok: false,
      message: `设施${code}：重复提交挡回，同一环节先落的那一笔已受理，本笔不落账`,
    }
  }
  const today = todayText()
  const updated: EntryRow = {
    ...row,
    status: plan.target,
    消防状态: plan.target,
    ...(plan.target === '状态正常' || plan.target === '需维修' ? { 检测结论: plan.target } : {}),
  }
  const next = [...rows]
  next[index] = updated
  saveRows('firecontrol', reconcileFireRows(next, today).rows)

  // 检测结论回写隐患整改清单：需维修挂待整改，归档（维修做完）同步验收回填。
  let hazardNote = ''
  let hazards = listRows('hazard')
  if (plan.target === '需维修') {
    const built = buildHazardForRepair(updated, hazards, today)
    hazards = built.hazards
    hazardNote = built.created
      ? `；隐患整改清单已挂上待整改 HAZA-${code}`
      : '；隐患整改清单已有该设施的待整改，不重复挂单'
  }
  if (plan.target === '归档') {
    const closed = closeHazardsForArchive(hazards, code)
    hazards = closed.hazards
    if (closed.closed > 0) {
      hazardNote = `；维修回填完成，隐患整改清单同步验收 ${closed.closed} 条`
    }
  }
  saveRows('hazard', reconcileHazardFlags(hazards))
  saveLog(FIRE_SUBMISSIONS_KEY, [...submissions, submissionKey])
  return { ok: true, message: `设施${code}已${action}，当前状态「${plan.target}」${hazardNote}` }
}

/** 存量设施回填：下次检测日按「联动测试日 + 检测周期」统一重算，争议取值以归档件为准。 */
export function backfillFirecontrol(): ActionResult {
  const { rows, notes } = reconcileFireRows(listRows('firecontrol'), todayText())
  saveRows('firecontrol', rows)
  saveRows('hazard', reconcileHazardFlags(listRows('hazard')))
  return {
    ok: true,
    message: notes.length ? `存量回填完成：${notes.join('；')}` : '存量回填完成：台账已与检测周期口径一致，无需调整',
  }
}

export type FireImportSummary = ActionResult & { lines: ImportLineResult[] }

/** 往期单据搬入：抄表周期单据按周期入账，纸面单据按扫描件编号建账，重复单据只认先落的一笔。 */
export function importFireHistory(records: FireHistoryRecord[]): FireImportSummary {
  const seen = new Set(loadLog(FIRE_IMPORT_LOG_KEY))
  const planned = planFireImport(listRows('firecontrol'), records, seen)
  const reconciled = reconcileFireRows(planned.rows, todayText())
  saveRows('firecontrol', reconciled.rows)
  saveRows('hazard', reconcileHazardFlags(listRows('hazard')))
  saveLog(FIRE_IMPORT_LOG_KEY, [...seen, ...planned.acceptedKeys])
  const rejected = planned.results.filter(
    (line) => line.outcome === '重复挡回' || line.outcome === '无效单据',
  ).length
  const accepted = planned.results.length - rejected
  const recalc = reconciled.notes.length ? `；台账重算 ${reconciled.notes.length} 处` : ''
  return {
    ok: true,
    message: `往期单据搬入完成：受理 ${accepted} 笔、重复挡回 ${rejected} 笔${recalc}`,
    lines: planned.results,
  }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  if (key === 'firecontrol') {
    // 重置消防台账时连同提交流水、往期单据流水一起清掉，否则历史去重键会挡住新的推进。
    saveLog(FIRE_SUBMISSIONS_KEY, [])
    saveLog(FIRE_IMPORT_LOG_KEY, [])
  }
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
