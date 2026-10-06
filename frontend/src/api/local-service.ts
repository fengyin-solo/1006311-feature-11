import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import { addMonths, cycleMonthsFor } from '@/data/migration'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 消防设施四要素：提交检测时缺一个都不收。
const FIRE_REQUIRED_FIELDS = ['设施编号', '消防类型', '探测器数量', '下次检测日'] as const
const FIRE_TERMINAL = '已归档'
// 同一设施一个检测周期内只有一张进行中的检测单，重复提交按重复挡回。
const FIRE_OPEN_STATUSES = ['待检测', '检测中', '状态正常', '需维修']

// 同一行被两笔同时提交时的在途锁：先到的拿锁落库，后到的当场按重复挡回。
const inflight = new Set<string>()
function lockKey(module: string, id: number): string {
  return `${module}:${id}`
}

function today(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
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

// 在单向链路里找「当前 → 目标」的最短前进路径，返回中间缺的环节；找不到说明是回退。
function missingSteps(meta: ModuleMeta, current: string, target: string): string[] | null {
  const transitions = meta.transitions ?? {}
  const queue: Array<{ status: string; path: string[] }> = [{ status: current, path: [] }]
  const seen = new Set<string>([current])
  while (queue.length > 0) {
    const { status, path } = queue.shift()!
    for (const next of transitions[status] ?? []) {
      if (next === target) {
        return path
      }
      if (!seen.has(next)) {
        seen.add(next)
        queue.push({ status: next, path: [...path, next] })
      }
    }
  }
  return null
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function nextSerialNo(rows: EntryRow[], field: string, prefix: string): string {
  const max = rows.reduce((acc, row) => {
    const code = String(row[field] ?? '').match(new RegExp(`${prefix}-(\\d+)`))
    return code ? Math.max(acc, Number(code[1])) : acc
  }, 0)
  return `${prefix}-${String(max + 1).padStart(4, '0')}`
}

function stamp(row: EntryRow): EntryRow {
  return { ...row, _updatedAt: new Date().toISOString() }
}

// 检测结论回写隐患整改台账：在隐患清单里挂出一条「待整改」，并把编号挂回消防行。
function createHazardFromInspection(fire: EntryRow, conclusion: string): { fire: EntryRow; hazard: EntryRow } {
  const hazards = listRows('hazard')
  const due = addMonths(today(), 1)
  const hazard: EntryRow = {
    id: nextId(hazards),
    status: '待整改',
    pending: true,
    abnormal: false,
    隐患编号: nextSerialNo(hazards, '隐患编号', 'HAZA'),
    隐患部位: String(fire['所属舱室'] ?? fire['设施编号']),
    隐患等级: '一般隐患',
    整改措施: conclusion,
    责任人员: String(fire['责任人员'] ?? '待派'),
    发现日期: today(),
    整改期限: due,
    整改状态: '消防检测回写',
    来源设施: String(fire['设施编号']),
    来源检测结论: conclusion,
  }
  saveRows('hazard', [...hazards, hazard])
  return { fire: stamp({ ...fire, 关联隐患编号: hazard['隐患编号'] }), hazard }
}

// 隐患验收回写消防侧：维修闭环回填，检测单同步归档，两边待办一起消掉。
function writeBackRepairAccepted(hazard: EntryRow): EntryRow | null {
  const facilityNo = String(hazard['来源设施'] ?? '')
  if (!facilityNo) {
    return null
  }
  const fireRows = listRows('firecontrol')
  const index = fireRows.findIndex((row) => String(row['设施编号']) === facilityNo)
  if (index < 0) {
    return null
  }
  const fire = fireRows[index]
  if (String(fire.status) !== '需维修' || String(fire['关联隐患编号'] ?? '') !== String(hazard['隐患编号'])) {
    return null
  }
  const months = cycleMonthsFor(String(fire['消防类型'] ?? ''))
  const finishDate = today()
  const updated = stamp({
    ...fire,
    status: FIRE_TERMINAL,
    pending: false,
    维修完工日: finishDate,
    检测结论: `${String(fire['检测结论'] ?? '检测不合格，需维修')}；维修已完工，复验合格（${hazard['隐患编号']}）`,
    下次检测日: addMonths(finishDate, months),
    回填依据: `隐患${hazard['隐患编号']}验收回写，维修闭环并归档`,
  })
  const next = [...fireRows]
  next[index] = updated
  saveRows('firecontrol', next)
  return updated
}

function guardFireAction(
  row: EntryRow,
  action: string,
): { ok: boolean; message: string } {
  if (action === '提交检测') {
    const missing = FIRE_REQUIRED_FIELDS.filter((field) => {
      const value = row[field]
      return value === undefined || String(value).trim() === ''
    })
    if (missing.length > 0) {
      return { ok: false, message: `提交检测被驳回：随单必录字段缺失「${missing.join('、')}」，补齐后再提交` }
    }
    if (!Number(row['探测器数量']) || Number(row['探测器数量']) <= 0) {
      return { ok: false, message: '提交检测被驳回：探测器数量必须是大于 0 的数字' }
    }
  }
  if (action === '提出维修') {
    const existing = String(row['关联隐患编号'] ?? '')
    if (existing) {
      return { ok: false, message: `该设施已挂账隐患${existing}，重复提出维修只受理一次` }
    }
    // 结论由页面用 prompt 采集，允许取消；取消时整笔不提交。
    return { ok: true, message: '' }
  }
  if (action === '归档' && String(row.status) === '需维修') {
    const hazardNo = String(row['关联隐患编号'] ?? '')
    if (!hazardNo) {
      return { ok: false, message: '归档被驳回：检测结论为需维修，缺「隐患整改挂账」这一步' }
    }
    const linked = listRows('hazard').find((item) => String(item['隐患编号']) === hazardNo)
    if (!linked) {
      return { ok: false, message: `归档被驳回：挂账隐患${hazardNo}在整改台账中查无此单` }
    }
    if (String(linked.status) !== '已验收') {
      return {
        ok: false,
        message: `归档被驳回：缺「隐患整改验收」这一步（${hazardNo}当前为「${linked.status}」，验收通过后自动回填归档）`,
      }
    }
  }
  return { ok: true, message: '' }
}

function runActionSync(key: string, id: number, action: string, extra?: { conclusion?: string }): ActionResult {
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
  const row = rows[index]
  const current = String(row.status)

  // 消防「提出维修」重复落账优先报挂账号，比通用的重复提交提示更可操作。
  if (key === 'firecontrol' && action === '提出维修' && current === target) {
    const hazardNo = String(row['关联隐患编号'] ?? '')
    if (hazardNo) {
      return { ok: false, message: `该设施已挂账隐患${hazardNo}，重复提出维修只受理一次` }
    }
  }

  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，同一笔重复提交只推进一次` }
  }

  // 单向链路守卫：只允许相邻一档前进，跳档当场驳回并写明缺哪一步；归档后一律退不回。
  if (meta.transitions) {
    const allowed = meta.transitions[current] ?? []
    if (!allowed.includes(target)) {
      if (current === meta.statuses[meta.statuses.length - 1]) {
        return { ok: false, message: `「${current}」是终态单据，已归档件退不回检测环节，不能执行「${action}」` }
      }
      const path = missingSteps(meta, current, target)
      if (path === null) {
        return {
          ok: false,
          message: `状态只能顺着既定次序往前走，不能从「${current}」退到「${target}」；下一轮检测请新建检测单`,
        }
      }
      if (path.length === 0) {
        return { ok: false, message: `当前在「${current}」，不能直接跳到「${target}」，缺中间档` }
      }
      return {
        ok: false,
        message: `跳档被驳回：当前在「${current}」，缺「${path.join('」→「')}」这一步，完成后才能到「${target}」`,
      }
    }
  }

  if (key === 'firecontrol') {
    const guard = guardFireAction(row, action)
    if (!guard.ok) {
      return guard
    }
  }

  let updated: EntryRow = stamp({
    ...row,
    status: target,
    pending: target !== meta.statuses[meta.statuses.length - 1],
    abnormal: row.abnormal || NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  })

  // 消防分档附带动作
  if (key === 'firecontrol') {
    if (action === '判定正常') {
      const testDate = isValidDateValue(row['联动测试日']) ? String(row['联动测试日']) : today()
      updated = {
        ...updated,
        联动测试日: testDate,
        检测结论: row['检测结论'] || `检测合格（${today()}）`,
        下次检测日: addMonths(testDate, cycleMonthsFor(String(row['消防类型'] ?? ''))),
      }
    }
    if (action === '提出维修') {
      const conclusion = (extra?.conclusion ?? '').trim() || `检测不合格，需维修（${today()}）`
      updated = { ...updated, 联动测试日: isValidDateValue(row['联动测试日']) ? row['联动测试日'] : today(), 检测结论: conclusion }
      const linked = createHazardFromInspection(updated, conclusion)
      updated = linked.fire
    }
    if (action === '归档') {
      const months = cycleMonthsFor(String(row['消防类型'] ?? ''))
      const anchor = String(row['维修完工日'] ?? (isValidDateValue(row['联动测试日']) ? row['联动测试日'] : today()))
      updated = {
        ...updated,
        检测结论: updated['检测结论'] || `本周期检测完成归档（${today()}）`,
        下次检测日: addMonths(anchor, months),
        回填依据: `归档件（${today()}），历史取值以本件为准`,
      }
    }
  }

  const nextRows = [...rows]
  nextRows[index] = updated

  // 隐患验收：回写消防侧维修闭环。两模块同一事务落库，条数始终对得上。
  if (key === 'hazard' && action === '提交验收') {
    const accepted = stamp({ ...updated, pending: false })
    nextRows[index] = accepted
    saveRows('hazard', nextRows)
    const fireUpdated = writeBackRepairAccepted(accepted)
    return {
      ok: true,
      message: fireUpdated
        ? `隐患已验收并回写：${fireUpdated['设施编号']}维修完工，检测单同步归档（${fireUpdated['关联隐患编号']}）`
        : `隐患已验收，当前状态「${target}」`,
    }
  }

  saveRows(key, nextRows)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

function isValidDateValue(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

// 页面统一走这个入口：同一行并发两笔只认先拿锁落库的，另一笔按重复挡回。
export async function submitAction(
  key: string,
  id: number,
  action: string,
  extra?: { conclusion?: string },
): Promise<ActionResult> {
  const token = lockKey(key, id)
  if (inflight.has(token)) {
    return { ok: false, message: '同一行有在途提交：本笔按重复挡回，只认先落库的那一笔' }
  }
  inflight.add(token)
  try {
    // 让出一个微任务，保证并发的第二笔一定撞上在途锁，而不是侥幸排在落库之后。
    await Promise.resolve()
    return runActionSync(key, id, action, extra)
  } finally {
    inflight.delete(token)
  }
}

// 保留给未改造页面的同步入口（内部仍是同一套守卫）。
export function runAction(key: string, id: number, action: string): ActionResult {
  const token = lockKey(key, id)
  if (inflight.has(token)) {
    return { ok: false, message: '同一行有在途提交：本笔按重复挡回，只认先落库的那一笔' }
  }
  inflight.add(token)
  try {
    return runActionSync(key, id, action)
  } finally {
    inflight.delete(token)
  }
}

export type FireInspectionInput = {
  设施编号: string
  所属舱室: string
  消防类型: string
  探测器数量: number
  责任人员: string
  下次检测日: string
}

// 新建检测单：设施编号、消防类型、探测器数量随单落库；同一设施有未归档单就挡重复。
export function createFireInspection(input: FireInspectionInput): ActionResult & { id?: number } {
  const facilityNo = input.设施编号.trim()
  const type = input.消防类型.trim()
  const missing = FIRE_REQUIRED_FIELDS.filter((field) => {
    if (field === '探测器数量') {
      return !input.探测器数量 || input.探测器数量 <= 0
    }
    if (field === '下次检测日') {
      return !isValidDateValue(input.下次检测日)
    }
    return String(input[field] ?? '').trim() === ''
  })
  if (missing.length > 0) {
    return { ok: false, message: `登记被驳回：缺「${missing.join('、')}」` }
  }
  const fireRows = listRows('firecontrol')
  const duplicate = fireRows.find(
    (row) => String(row['设施编号']) === facilityNo && FIRE_OPEN_STATUSES.includes(String(row.status)),
  )
  if (duplicate) {
    return {
      ok: false,
      message: `设施${facilityNo}已有未归档检测单（编号${duplicate.id}，当前「${duplicate.status}」），同一周期重复提交只受理一笔`,
    }
  }
  const months = cycleMonthsFor(type)
  const row: EntryRow = stamp({
    id: nextId(fireRows),
    status: '待检测',
    pending: true,
    abnormal: false,
    设施编号: facilityNo,
    所属舱室: input.所属舱室.trim(),
    消防类型: type,
    探测器数量: input.探测器数量,
    联动测试日: '',
    责任人员: input.责任人员.trim() || '待派',
    下次检测日: input.下次检测日,
    检测周期: months === 6 ? '6个月' : '12个月',
    检测结论: '',
    维修完工日: '',
    关联隐患编号: '',
    扫描件编号: '',
    回填依据: '新登记检测单',
  })
  saveRows('firecontrol', [...fireRows, row])
  return { ok: true, message: `检测单已登记（内部序号${row.id}），设施${facilityNo}进入「待检测」`, id: Number(row.id) }
}

// 导入对账：导入明细必须与台账现状逐条一致，否则整批拒收并列出前几处差异。
export function reconcileImport(key: string, text: string): ActionResult & { checked?: number } {
  const meta = moduleMeta(key)
  const identity = meta.fields[0]
  const cleanText = text.replace(/^﻿/, '')
  const lines = cleanText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length < 2) {
    return { ok: false, message: '导入文件没有明细行（需要表头加至少一行数据）' }
  }
  const header = lines[0].split(',').map((cell) => cell.trim())
  const statusIndex = header.indexOf('当前状态')
  const idIndex = header.indexOf('编号')
  const identityIndex = header.indexOf(identity)
  if (identityIndex < 0 || statusIndex < 0) {
    return { ok: false, message: `导入表头必须包含「${identity}」和「当前状态」两列，实际为：${header.join('、')}` }
  }
  const compareFields = meta.fields.filter((field) => header.includes(field))
  const imported = new Map<string, Record<string, string>>()
  const problems: string[] = []
  for (const line of lines.slice(1)) {
    const cells = line.split(',')
    const code = (cells[identityIndex] ?? '').trim()
    if (!code) {
      problems.push(`存在「${identity}」为空的行`)
      continue
    }
    if (imported.has(code)) {
      problems.push(`${identity} ${code} 在导入文件里出现两次，按重复挡回`)
      continue
    }
    const record: Record<string, string> = { 当前状态: (cells[statusIndex] ?? '').trim() }
    for (const field of compareFields) {
      record[field] = (cells[header.indexOf(field)] ?? '').trim()
    }
    if (idIndex >= 0) {
      record['编号'] = (cells[idIndex] ?? '').trim()
    }
    imported.set(code, record)
  }
  const ledger = listRows(key)
  if (imported.size !== ledger.length) {
    problems.push(`条数不一致：导入${imported.size}条，台账现状${ledger.length}条`)
  }
  for (const row of ledger) {
    const code = String(row[identity] ?? '')
    const incoming = imported.get(code)
    if (!incoming) {
      problems.push(`${identity} ${code} 台账有、导入明细缺`)
      continue
    }
    if (incoming['当前状态'] !== String(row.status)) {
      problems.push(`${identity} ${code} 状态不一致：导入「${incoming['当前状态']}」，台账「${row.status}」`)
    }
    for (const field of compareFields) {
      const left = incoming[field]
      const right = String(row[field] ?? '')
      if (left !== right) {
        problems.push(`${identity} ${code} 字段「${field}」不一致：导入「${left}」，台账「${right}」`)
      }
    }
  }
  for (const code of imported.keys()) {
    if (!ledger.some((row) => String(row[identity] ?? '') === code)) {
      problems.push(`${identity} ${code} 导入明细有、台账无（不允许凭空导入）`)
    }
  }
  if (problems.length > 0) {
    const shown = problems.slice(0, 5).join('；')
    const more = problems.length > 5 ? `；另有${problems.length - 5}处差异未列` : ''
    return { ok: false, message: `导入被驳回，明细与台账现状不一致：${shown}${more}` }
  }
  return { ok: true, message: `导入对账通过：${imported.size}条明细与台账现状完全一致`, checked: imported.size }
}

export type FireConsistency = {
  openRepairs: number
  openLinkedHazards: number
  consistent: boolean
  archived: number
}

// 消防待办与隐患整改（安防）台账对账：每条未闭环的「需维修」必须对应一条未验收挂账。
export function fireConsistency(): FireConsistency {
  const fireRows = listRows('firecontrol')
  const hazards = listRows('hazard')
  const openRepairNos = fireRows
    .filter((row) => String(row.status) === '需维修')
    .map((row) => String(row['设施编号']))
  const openLinked = hazards.filter(
    (hazard) =>
      openRepairNos.includes(String(hazard['来源设施'] ?? '')) &&
      String(hazard.status) !== '已验收',
  )
  return {
    openRepairs: openRepairNos.length,
    openLinkedHazards: openLinked.length,
    consistent: openRepairNos.length === openLinked.length,
    archived: fireRows.filter((row) => String(row.status) === FIRE_TERMINAL).length,
  }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
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

export { allRows }
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
