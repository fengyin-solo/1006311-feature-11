import type { EntryRow } from './types'

// 存量数据搬入（只在首次读到旧版数据时跑一次，跑完落版本号；之后一律不再重算用户数据）。
//
// 口径依据（与 docs/firecontrol-lifecycle.md 一致）：
// 1. 周期：依据 GB 25201《建筑消防设施的维护管理》，建筑消防设施至少每年检测一次；
//    管网气体灭火系统按 GB 50263 每年一次、联动两年一次的实际保养惯例，台账默认
//    统一按 12 个月，火灾自动报警系统按重点单位半年一次取 6 个月。
// 2. 存量回填：下次检测日 = 最近一次联动测试日 + 检测周期（以实际测试日为锚点，
//    而不是取建账日，避免把漏检记录抹平）。
// 3. 早年没有下次检测日、也没有联动测试日：
//    a. 仅有纸面单的，按扫描件编号里的扫描日期（SCAN-YYYYMMDD-序号）作锚点 + 周期；
//    b. 连扫描日期都没有的，锚点取迁移上线日并视为已到期（下次检测日 = 迁移日），
//       宁可比真实情况早报，也不掩盖可能的漏检。
// 4. 历史取值有争议时以归档件为准：status=已归档 的行任何字段都不重算，其余字段
//    （周期、下次检测日）一律按上面口径统一重算，保证同一设施只有一个口径。
// 5. 检测结论回写过隐患台账的（status=需维修），补齐一条 待整改 隐患，编号续现有
//    流水号，保证「消防待办」与隐患整改台账条数一致。
// 6. 往期能耗单据按抄表周期搬入：统计周期统一成「YYYY-MM 月度」。

export const SCHEMA_VERSION = 1

// 迁移上线日：无任何日期锚点的存量设施一律按这天到期。取固定日期保证重跑结果可复现。
export const MIGRATION_DATE = '2026-10-06'

const HALF_YEAR_TYPES = ['火灾自动报警系统']

export function cycleMonthsFor(type: string): number {
  return HALF_YEAR_TYPES.includes(type) ? 6 : 12
}

export function cycleLabel(months: number): string {
  return months === 6 ? '6个月' : '12个月'
}

function isValidDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

export function addMonths(date: string, months: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const target = new Date(Date.UTC(year, month - 1 + months, day))
  // 加月跨年时 JS 自动进位；补零输出 YYYY-MM-DD。
  const y = target.getUTCFullYear()
  const m = String(target.getUTCMonth() + 1).padStart(2, '0')
  const d = String(target.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function scanAnchor(scanNo: unknown): string {
  const match = typeof scanNo === 'string' ? scanNo.match(/SCAN-(\d{4})(\d{2})(\d{2})/) : null
  return match ? `${match[1]}-${match[2]}-${match[3]}` : ''
}

function openHazardExists(hazards: EntryRow[], facilityNo: string): boolean {
  return hazards.some(
    (h) =>
      String(h['来源设施'] ?? '') === facilityNo &&
      !['已验收'].includes(String(h.status)),
  )
}

function nextHazardId(hazards: EntryRow[]): number {
  return hazards.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function nextHazardNo(hazards: EntryRow[]): string {
  const max = hazards.reduce((max, row) => {
    const code = String(row['隐患编号'] ?? '').match(/HAZA-(\d+)/)
    return code ? Math.max(max, Number(code[1])) : max
  }, 0)
  return `HAZA-${String(max + 1).padStart(4, '0')}`
}

// 消防存量回填 + 隐患台账对齐，返回补齐后的隐患行（消防行在原数组上更新）。
export function migrateFirecontrol(
  fireRows: EntryRow[],
  hazardRows: EntryRow[],
): EntryRow[] {
  const hazards = [...hazardRows]
  for (const row of fireRows) {
    if (String(row.status) === '已归档') {
      // 归档件即终态凭证：原值保留，不参与任何重算。
      row['回填依据'] = row['回填依据'] || '归档件为准，存量迁移不重算'
      continue
    }

    const type = String(row['消防类型'] ?? '')
    const months = cycleMonthsFor(type)
    row['检测周期'] = cycleLabel(months)

    const linkedTest = isValidDate(row['联动测试日']) ? row['联动测试日'] : ''
    const paperAnchor = scanAnchor(row['扫描件编号'])
    let nextDate: string
    let basis: string
    if (linkedTest) {
      nextDate = addMonths(linkedTest, months)
      basis = `按联动测试日${linkedTest}加${cycleLabel(months)}检测周期回填`
    } else if (paperAnchor) {
      nextDate = addMonths(paperAnchor, months)
      basis = `无联动测试日，按扫描件编号建账日${paperAnchor}加周期倒推`
      if (!row['扫描件编号']) {
        row['扫描件编号'] = `SCAN-${paperAnchor.replace(/-/g, '')}-${String(row.id).padStart(4, '0')}`
      }
    } else {
      // 无任何可核日期：锚点取迁移日并视为已到期，下一轮检测完成后即恢复正常滚动。
      nextDate = MIGRATION_DATE
      row['扫描件编号'] =
        row['扫描件编号'] ||
        `SCAN-${MIGRATION_DATE.replace(/-/g, '')}-${String(row.id).padStart(4, '0')}`
      basis = `无联动测试日且无扫描日期，按迁移上线日${MIGRATION_DATE}到期，倒推依据为年度检测口径`
    }
    row['下次检测日'] = nextDate
    row['回填依据'] = basis
    row.pending = String(row.status) !== '已归档'

    // 已判「需维修」但隐患台账里没有对应待办的，按存量回填补挂，条数与消防侧对齐。
    const facilityNo = String(row['设施编号'] ?? '')
    if (String(row.status) === '需维修' && facilityNo && !openHazardExists(hazards, facilityNo)) {
      const hazardId = nextHazardId(hazards)
      hazards.push({
        id: hazardId,
        status: '待整改',
        pending: true,
        abnormal: false,
        隐患编号: nextHazardNo(hazards),
        隐患部位: String(row['所属舱室'] ?? facilityNo),
        隐患等级: '一般隐患',
        整改措施: String(row['检测结论'] || '消防设施检测不合格，按结论维修后复验'),
        责任人员: String(row['责任人员'] ?? '待派'),
        发现日期: nextDate,
        整改期限: addMonths(MIGRATION_DATE, 1),
        整改状态: '存量回填',
        来源设施: facilityNo,
        来源检测结论: String(row['检测结论'] ?? ''),
      })
      row['关联隐患编号'] = hazards[hazards.length - 1]['隐患编号']
    }
  }
  return hazards
}

// 往期能耗单据按抄表周期搬入：统计周期规范为月度（YYYY-MM），抄表日期为空的取迁移日。
export function migrateEnergy(energyRows: EntryRow[]): void {
  for (const row of energyRows) {
    const readDate = isValidDate(row['抄表日期']) ? row['抄表日期'] : MIGRATION_DATE
    row['统计周期'] = readDate.slice(0, 7)
  }
}
