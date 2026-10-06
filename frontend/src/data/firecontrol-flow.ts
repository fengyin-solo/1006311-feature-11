import type { EntryRow } from './types'

/**
 * 消防系统运维的单向状态链路。
 * 次序固定：待检测 → 检测中 → 状态正常/需维修 → 归档。
 * 只能按顺序往前，归档是终点，到了归档就再也退不回来。
 */
export const FIRE_FLOW = ['待检测', '检测中', '状态正常', '需维修', '归档'] as const

/** 各状态在链路里的位次：状态正常与需维修并列第三档，归档独占最后一档。 */
export const FIRE_ORDER: Record<string, number> = {
  待检测: 0,
  检测中: 1,
  状态正常: 2,
  需维修: 2,
  归档: 3,
}

/** 动作 → 要求的来源状态 / 推进到的目标状态。 */
export const FIRE_ACTIONS: Record<string, { from: string[]; to: string }> = {
  提交检测: { from: ['待检测'], to: '检测中' },
  判定正常: { from: ['检测中'], to: '状态正常' },
  提出维修: { from: ['检测中'], to: '需维修' },
  归档: { from: ['状态正常', '需维修'], to: '归档' },
}

/**
 * 检测周期倒推口径（自定义，全台账统一执行）：
 * 依据 GB 25201《建筑消防设施的维护管理》——建筑消防设施每年至少进行一次全面检测，
 * 检测周期取 12 个月。下次检测日一律按「联动测试日 + 12 个月」重算，
 * 不直接采用历史单据上的旧值；取值有争议时以归档件的联动测试日为基准。
 */
export const CHECK_CYCLE_MONTHS = 12

/** 整改期限口径：检测结论为需维修的隐患，整改期限取发现之日起 30 天。 */
export const RECTIFY_DEADLINE_DAYS = 30

export type TransitionPlan = { ok: true; target: string } | { ok: false; message: string }

/** 状态机：校验「当前状态 + 动作」是否合法，合法返回目标状态，非法返回驳回原因（写明缺哪一步）。 */
export function planFireTransition(currentRaw: string, action: string): TransitionPlan {
  const rule = FIRE_ACTIONS[action]
  if (!rule) {
    return { ok: false, message: `消防设施没有登记「${action}」这个动作` }
  }
  const current = currentRaw in FIRE_ORDER ? currentRaw : '待检测'
  if (current === '归档') {
    return {
      ok: false,
      message: '驳回：设施已归档，归档是链路终点，回不到「检测中」，也不再接受任何动作',
    }
  }
  if (current === rule.to) {
    return {
      ok: false,
      message: `重复提交挡回：设施已经处于「${rule.to}」，同一环节只推进一次，先落的那一笔有效`,
    }
  }
  if (!rule.from.includes(current)) {
    const need = Math.min(...rule.from.map((status) => FIRE_ORDER[status]))
    if (FIRE_ORDER[current] < need) {
      return {
        ok: false,
        message: `跳档驳回：当前「${current}」，要执行「${action}」还缺${missingSteps(current, need)}`,
      }
    }
    return {
      ok: false,
      message: `回退驳回：状态只能按 ${FIRE_FLOW.join('→')} 顺序往前，不能从「${current}」回到「${rule.to}」`,
    }
  }
  return { ok: true, target: rule.to }
}

/** 列出从当前状态到目标档位之间缺掉的环节。 */
function missingSteps(current: string, need: number): string {
  const steps: string[] = []
  const order = FIRE_ORDER[current]
  if (order < 1 && need >= 1) {
    steps.push('「提交检测」（待检测→检测中）')
  }
  if (order < 2 && need >= 2) {
    steps.push('检测结论（「判定正常」或「提出维修」）')
  }
  return steps.join('、')
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

/** 严格校验 YYYY-MM-DD，2 月 30 日这类假日期不算数。 */
export function isDateText(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false
  }
  const match = DATE_PATTERN.exec(value)
  if (!match) {
    return false
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}

/** 日期加月，超出当月天数的钳到月末（如 2024-02-29 + 12 个月 → 2025-02-28）。 */
export function addMonths(dateText: string, months: number): string {
  const [year, month, day] = dateText.split('-').map(Number)
  const total = year * 12 + (month - 1) + months
  const nextYear = Math.floor(total / 12)
  const nextMonth = (total % 12) + 1
  const lastDay = new Date(Date.UTC(nextYear, nextMonth, 0)).getUTCDate()
  const nextDay = Math.min(day, lastDay)
  return `${nextYear}-${String(nextMonth).padStart(2, '0')}-${String(nextDay).padStart(2, '0')}`
}

/** 日期加天，用于整改期限。 */
export function addDays(dateText: string, days: number): string {
  const [year, month, day] = dateText.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day + days))
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(date.getUTCDate()).padStart(2, '0')
  return `${date.getUTCFullYear()}-${mm}-${dd}`
}

export type ReconcileResult = {
  rows: EntryRow[]
  notes: string[]
}

/** 归档件上作为争议基准的字段。 */
const ARCHIVED_AUTHORITATIVE_FIELDS = ['联动测试日', '消防类型', '探测器数量', '责任人员', '所属舱室', '检测结论']

/**
 * 台账统一重算（每次落库后执行，保证导入的明细与台账现状一致）：
 * 1. 同一设施编号下存在归档件时，归档件的联动测试日等取值为准，其余行按它统一重算；
 * 2. 下次检测日一律按「联动测试日 + 12 个月」回填/重算，早年缺下次检测日的由此倒推；
 * 3. 待检测、检测中且下次检测日已过的标记超期异常；归档行不再是待办。
 */
export function reconcileFireRows(rows: EntryRow[], today: string): ReconcileResult {
  const notes: string[] = []
  const archivedByCode = new Map<string, EntryRow>()
  for (const row of rows) {
    const code = String(row['设施编号'] ?? '')
    if (code && String(row.status) === '归档' && !archivedByCode.has(code)) {
      archivedByCode.set(code, row)
    }
  }
  const next = rows.map((row) => {
    const updated: EntryRow = { ...row }
    const code = String(updated['设施编号'] ?? '')
    const archived = archivedByCode.get(code)
    if (archived && Number(archived.id) !== Number(updated.id)) {
      for (const field of ARCHIVED_AUTHORITATIVE_FIELDS) {
        const authoritative = archived[field]
        if (authoritative !== undefined && authoritative !== '' && updated[field] !== authoritative) {
          notes.push(`设施${code}：「${field}」以归档件为准（${updated[field] ?? '空'} → ${authoritative}）`)
          updated[field] = authoritative
        }
      }
    }
    const status = String(updated.status)
    const linkDay = String(updated['联动测试日'] ?? '')
    let abnormal = false
    if (isDateText(linkDay)) {
      const recomputed = addMonths(linkDay, CHECK_CYCLE_MONTHS)
      if (String(updated['下次检测日'] ?? '') !== recomputed) {
        if (updated['下次检测日']) {
          notes.push(`设施${code}：下次检测日按检测周期重算（${updated['下次检测日']} → ${recomputed}）`)
        }
        updated['下次检测日'] = recomputed
      }
    } else if (!isDateText(updated['下次检测日'])) {
      abnormal = true
      notes.push(`设施${code}：联动测试日与下次检测日都缺失，无法按检测周期倒推，待补录`)
    }
    const nextCheck = String(updated['下次检测日'] ?? '')
    if ((status === '待检测' || status === '检测中') && isDateText(nextCheck) && nextCheck < today) {
      abnormal = true
      notes.push(`设施${code}：下次检测日 ${nextCheck} 已过仍未闭环，标记超期`)
    }
    updated['消防状态'] = status
    updated.pending = status !== '归档'
    updated.abnormal = abnormal
    return updated
  })
  return { rows: next, notes }
}

/**
 * 检测结论回写隐患整改清单：判定需维修时挂上一条待整改。
 * 同一设施已有未验收的隐患时不再重复挂单。
 */
export function buildHazardForRepair(
  fireRow: EntryRow,
  hazards: EntryRow[],
  today: string,
): { hazards: EntryRow[]; created: boolean } {
  const code = String(fireRow['设施编号'] ?? '')
  const existing = hazards.find(
    (hazard) => String(hazard['来源设施'] ?? '') === code && String(hazard.status) !== '已验收',
  )
  if (existing) {
    return { hazards, created: false }
  }
  const id = hazards.reduce((max, hazard) => Math.max(max, Number(hazard.id) || 0), 0) + 1
  const hazard: EntryRow = {
    id,
    status: '待整改',
    pending: true,
    abnormal: false,
    隐患编号: `HAZA-${code}`,
    隐患部位: `${String(fireRow['所属舱室'] ?? '')}·${code}`,
    隐患等级: '一般',
    整改措施: `消防设施${code}检测结论为需维修，限期维修并回填`,
    责任人员: String(fireRow['责任人员'] ?? ''),
    发现日期: today,
    整改期限: addDays(today, RECTIFY_DEADLINE_DAYS),
    整改状态: '待整改',
    来源设施: code,
  }
  return { hazards: [...hazards, hazard], created: true }
}

/** 维修做完归档时回填：该设施名下未验收的隐患同步验收，清单不再挂着待整改。 */
export function closeHazardsForArchive(
  hazards: EntryRow[],
  code: string,
): { hazards: EntryRow[]; closed: number } {
  let closed = 0
  const next = hazards.map((hazard) => {
    if (String(hazard['来源设施'] ?? '') === code && String(hazard.status) !== '已验收') {
      closed += 1
      return { ...hazard, status: '已验收', 整改状态: '已验收', pending: false }
    }
    return hazard
  })
  return { hazards: next, closed }
}

/** 待办条数与台账对齐：pending 一律按状态重算，待整改/整改中才算待办。 */
export function reconcileHazardFlags(hazards: EntryRow[]): EntryRow[] {
  return hazards.map((hazard) => {
    const status = String(hazard.status)
    return { ...hazard, pending: status === '待整改' || status === '整改中' }
  })
}

/** 往期单据：抄表周期单据按周期搬入，早期只有纸面的按扫描件编号建账。 */
export type FireHistoryRecord = {
  设施编号: string
  所属舱室?: string
  消防类型?: string
  探测器数量?: number
  联动测试日?: string
  责任人员?: string
  检测结论?: string
  来源类型: '抄表周期' | '纸面扫描件'
  来源单据: string
}

export type ImportLineResult = {
  来源单据: string
  设施编号: string
  outcome: '建账归档' | '合并入台账' | '重复挡回' | '冲突以归档件为准' | '冲突以台账为准' | '无效单据'
  message: string
}

const MERGEABLE_FIELDS: Array<[string, keyof FireHistoryRecord]> = [
  ['所属舱室', '所属舱室'],
  ['消防类型', '消防类型'],
  ['探测器数量', '探测器数量'],
  ['联动测试日', '联动测试日'],
  ['责任人员', '责任人员'],
]

/**
 * 往期单据搬入：
 * - 去重键为「设施编号 + 来源单据」，同一行被两笔同时提交进来时只认先落的那一笔；
 * - 台账没有该设施的，往期单据按已闭环处理，直接建账落归档；
 * - 台账已有归档件的，取值冲突以归档件为准，导入值不采用；
 * - 台账行未归档的，只补空字段，冲突以台账现状为准；
 * - 下次检测日不采用导入值，统一由 reconcile 按检测周期重算。
 */
export function planFireImport(
  rows: EntryRow[],
  records: FireHistoryRecord[],
  seenKeys: Set<string>,
): { rows: EntryRow[]; results: ImportLineResult[]; acceptedKeys: string[] } {
  const results: ImportLineResult[] = []
  const acceptedKeys: string[] = []
  const claimed = new Set(seenKeys)
  let next = [...rows]
  let maxId = next.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0)

  for (const record of records) {
    const code = String(record.设施编号 ?? '').trim()
    const doc = String(record.来源单据 ?? '').trim()
    if (!code || !doc) {
      results.push({
        来源单据: doc || '（空）',
        设施编号: code || '（空）',
        outcome: '无效单据',
        message: '设施编号或来源单据缺失，无法落账',
      })
      continue
    }
    const docKey = `${code}|${doc}`
    if (claimed.has(docKey)) {
      results.push({
        来源单据: doc,
        设施编号: code,
        outcome: '重复挡回',
        message: `单据 ${doc} 已有先落的那一笔，本笔按重复挡回`,
      })
      continue
    }
    claimed.add(docKey)
    acceptedKeys.push(docKey)

    const index = next.findIndex((row) => String(row['设施编号']) === code)
    if (index < 0) {
      maxId += 1
      const row: EntryRow = {
        id: maxId,
        status: '归档',
        pending: false,
        abnormal: false,
        设施编号: code,
        所属舱室: record.所属舱室 ?? '',
        消防类型: record.消防类型 ?? '',
        探测器数量: record.探测器数量 ?? 0,
        联动测试日: record.联动测试日 ?? '',
        责任人员: record.责任人员 ?? '',
        下次检测日: '',
        检测结论: record.检测结论 === '需维修' ? '需维修' : '状态正常',
        消防状态: '归档',
        来源类型: record.来源类型,
        来源单据: doc,
      }
      next = [...next, row]
      results.push({
        来源单据: doc,
        设施编号: code,
        outcome: '建账归档',
        message: `按${record.来源类型 === '纸面扫描件' ? '扫描件编号' : '抄表周期'}建账，往期单据已闭环，直接落归档`,
      })
      continue
    }

    const current = next[index]
    if (String(current.status) === '归档') {
      const conflicts = MERGEABLE_FIELDS.filter(
        ([field, key]) =>
          record[key] !== undefined &&
          record[key] !== '' &&
          String(current[field] ?? '') !== String(record[key]),
      ).map(([field]) => field)
      results.push({
        来源单据: doc,
        设施编号: code,
        outcome: '冲突以归档件为准',
        message: conflicts.length
          ? `台账已有归档件，${conflicts.join('、')}以归档件为准，导入值不采用`
          : '台账已有归档件且取值一致，无需变动',
      })
      continue
    }

    const merged: EntryRow = { ...current }
    const filled: string[] = []
    const conflicts: string[] = []
    for (const [field, key] of MERGEABLE_FIELDS) {
      const value = record[key]
      if (value === undefined || value === '') {
        continue
      }
      const old = merged[field]
      if (old === undefined || old === '' || old === 0) {
        merged[field] = value as string | number
        filled.push(field)
      } else if (String(old) !== String(value)) {
        conflicts.push(`${field}（台账 ${old} / 单据 ${value}）`)
      }
    }
    next = [...next.slice(0, index), merged, ...next.slice(index + 1)]
    results.push({
      来源单据: doc,
      设施编号: code,
      outcome: conflicts.length ? '冲突以台账为准' : '合并入台账',
      message: [
        filled.length ? `补录 ${filled.join('、')}` : '没有可补录的空字段',
        conflicts.length ? `${conflicts.join('、')}以台账现状为准` : '',
      ]
        .filter(Boolean)
        .join('；'),
    })
  }
  return { rows: next, results, acceptedKeys }
}
