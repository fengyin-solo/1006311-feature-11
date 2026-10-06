// 消防状态链路领域逻辑的断言脚本：转译 src/data/firecontrol-flow.ts 后逐项验证。
// 运行：npm run test:flow
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import ts from 'typescript'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '../src/data/firecontrol-flow.ts'), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
})
const file = join(mkdtempSync(join(tmpdir(), 'fire-flow-')), 'firecontrol-flow.mjs')
writeFileSync(file, outputText)
const flow = await import(pathToFileURL(file).href)

const TODAY = '2026-10-06'
let failed = 0

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok  ${name}`)
  } else {
    failed += 1
    console.error(`FAIL  ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

function baseRow(overrides = {}) {
  return {
    id: 1,
    status: '待检测',
    pending: true,
    abnormal: false,
    设施编号: 'FIRE-0001',
    所属舱室: '综合舱',
    消防类型: '火灾自动报警系统',
    探测器数量: 36,
    联动测试日: '2025-11-20',
    责任人员: '王建国',
    下次检测日: '',
    检测结论: '',
    消防状态: '待检测',
    ...overrides,
  }
}

// 1. 单向链路顺序推进
check('待检测→提交检测→检测中', flow.planFireTransition('待检测', '提交检测').target === '检测中')
check('检测中→判定正常→状态正常', flow.planFireTransition('检测中', '判定正常').target === '状态正常')
check('检测中→提出维修→需维修', flow.planFireTransition('检测中', '提出维修').target === '需维修')
check('状态正常→归档→归档', flow.planFireTransition('状态正常', '归档').target === '归档')
check('需维修→归档→归档', flow.planFireTransition('需维修', '归档').target === '归档')

// 2. 跳档当场驳回并写明缺哪一步
const skipJudge = flow.planFireTransition('待检测', '判定正常')
check('待检测直接判定正常被驳回', !skipJudge.ok)
check('驳回原因写明缺「提交检测」', !skipJudge.ok && skipJudge.message.includes('提交检测'), skipJudge.message)
const skipArchive = flow.planFireTransition('待检测', '归档')
check('待检测直接归档被驳回', !skipArchive.ok)
check(
  '归档跳档驳回写明缺提交检测与检测结论',
  !skipArchive.ok && skipArchive.message.includes('提交检测') && skipArchive.message.includes('检测结论'),
  skipArchive.message,
)
const archiveFromRunning = flow.planFireTransition('检测中', '归档')
check('检测中直接归档被驳回且缺检测结论', !archiveFromRunning.ok && archiveFromRunning.message.includes('检测结论'), archiveFromRunning.message)

// 3. 归档是终点，回不到检测中
const fromArchived = flow.planFireTransition('归档', '提交检测')
check('归档后提交检测被驳回', !fromArchived.ok)
check('驳回原因写明归档是终点', !fromArchived.ok && fromArchived.message.includes('归档'), fromArchived.message)
check('归档后任何动作都被驳回', !flow.planFireTransition('归档', '归档').ok)

// 4. 重复提交只推进一次 / 回退驳回
const dup = flow.planFireTransition('检测中', '提交检测')
check('检测中重复提交检测被挡回', !dup.ok && dup.message.includes('重复'), dup.message)
check('状态正常再走提交检测按回退驳回', !flow.planFireTransition('状态正常', '提交检测').ok)
check('需维修不能回判定正常', !flow.planFireTransition('需维修', '判定正常').ok)

// 5. 检测周期倒推口径：联动测试日 + 12 个月
check('2025-11-20 + 12 个月 = 2026-11-20', flow.addMonths('2025-11-20', 12) === '2026-11-20')
check('月末钳位 2024-02-29 + 12 个月 = 2025-02-28', flow.addMonths('2024-02-29', 12) === '2025-02-28')
check('假日期 2025-02-30 不算有效日期', !flow.isDateText('2025-02-30'))
check('整改期限 2026-10-06 + 30 天 = 2026-11-05', flow.addDays('2026-10-06', 30) === '2026-11-05')

// 6. 台账重算：回填、超期、归档件为准
const reconciled = flow.reconcileFireRows(
  [
    baseRow(), // 缺下次检测日 → 回填 2026-11-20
    baseRow({ id: 2, 设施编号: 'FIRE-0002', status: '检测中', 联动测试日: '2025-08-15', 下次检测日: '2026-08-15' }), // 超期
    baseRow({ id: 3, 设施编号: 'FIRE-0003', status: '归档', 联动测试日: '2024-12-18', 探测器数量: 20 }),
    baseRow({ id: 4, 设施编号: 'FIRE-0003', status: '待检测', 联动测试日: '2025-01-01', 探测器数量: 99 }), // 与归档件冲突
    baseRow({ id: 5, 设施编号: 'FIRE-0005', 联动测试日: '', 下次检测日: '' }), // 无法倒推
  ],
  TODAY,
)
const byId = Object.fromEntries(reconciled.rows.map((row) => [row.id, row]))
check('缺下次检测日按联动测试日回填', byId[1]['下次检测日'] === '2026-11-20', byId[1]['下次检测日'])
check('超期未闭环标记异常', byId[2].abnormal === true)
check('归档行不再是待办', byId[3].pending === false && byId[3].abnormal === false)
check('冲突取值以归档件为准（探测器数量）', byId[4]['探测器数量'] === 20, String(byId[4]['探测器数量']))
check('冲突行下次检测日按归档件联动测试日重算', byId[4]['下次检测日'] === '2025-12-18', byId[4]['下次检测日'])
check('两个日期都缺的行标记待补录异常', byId[5].abnormal === true)
check('消防状态镜像列与状态一致', byId[2]['消防状态'] === '检测中')

// 7. 隐患整改回写
const fireRow = baseRow({ 设施编号: 'FIRE-0004', status: '需维修', 检测结论: '需维修' })
const first = flow.buildHazardForRepair(fireRow, [], TODAY)
check('需维修挂上一条待整改', first.created && first.hazards.length === 1)
check('隐患编号按设施编号生成', first.hazards[0]['隐患编号'] === 'HAZA-FIRE-0004')
check('整改期限为发现之日起 30 天', first.hazards[0]['整改期限'] === '2026-11-05', first.hazards[0]['整改期限'])
const second = flow.buildHazardForRepair(fireRow, first.hazards, TODAY)
check('同一设施不重复挂单', !second.created && second.hazards.length === 1)
const closed = flow.closeHazardsForArchive(first.hazards, 'FIRE-0004')
check('归档回填后隐患同步验收', closed.closed === 1 && closed.hazards[0].status === '已验收')
const flags = flow.reconcileHazardFlags([
  { id: 1, status: '待整改', pending: false },
  { id: 2, status: '已验收', pending: true },
])
check('待办条数按台账状态重算', flags[0].pending === true && flags[1].pending === false)

// 8. 往期单据搬入：建账、去重、归档件为准、台账为准
const ledger = [
  baseRow({ id: 1, 设施编号: 'FIRE-0001', status: '待检测', 联动测试日: '2025-11-20' }),
  baseRow({ id: 5, 设施编号: 'FIRE-0005', status: '归档', 联动测试日: '2024-12-18', 探测器数量: 20 }),
]
const records = [
  { 设施编号: 'FIRE-0006', 所属舱室: '综合舱', 消防类型: '火灾自动报警系统', 探测器数量: 30, 联动测试日: '2024-09-12', 检测结论: '状态正常', 来源类型: '纸面扫描件', 来源单据: 'SCAN-2024-0096' },
  { 设施编号: 'FIRE-0006', 探测器数量: 30, 联动测试日: '2024-09-12', 检测结论: '状态正常', 来源类型: '纸面扫描件', 来源单据: 'SCAN-2024-0096' },
  { 设施编号: 'FIRE-0005', 探测器数量: 99, 联动测试日: '2024-12-20', 检测结论: '状态正常', 来源类型: '抄表周期', 来源单据: '2024Q4' },
  { 设施编号: 'FIRE-0001', 联动测试日: '2025-11-21', 检测结论: '状态正常', 来源类型: '抄表周期', 来源单据: '2025Q4' },
]
const imported = flow.planFireImport(ledger, records, new Set())
const outcomes = imported.results.map((line) => line.outcome)
check('纸面单据按扫描件编号建账归档', outcomes[0] === '建账归档')
check('同一单据第二笔按重复挡回', outcomes[1] === '重复挡回')
check('与归档件冲突以归档件为准', outcomes[2] === '冲突以归档件为准')
check('与未归档台账冲突以台账为准', outcomes[3] === '冲突以台账为准')
const newRow = imported.rows.find((row) => row['设施编号'] === 'FIRE-0006')
check('建账行直接落归档', newRow && newRow.status === '归档' && newRow.pending === false)
check('归档件取值不被导入覆盖', imported.rows.find((row) => row['设施编号'] === 'FIRE-0005')['探测器数量'] === 20)
check('未归档行冲突字段保留台账值', imported.rows.find((row) => row['设施编号'] === 'FIRE-0001')['联动测试日'] === '2025-11-20')
const again = flow.planFireImport(imported.rows, [records[0]], new Set(imported.acceptedKeys))
check('流水里已有的单据再次提交仍挡回', again.results[0].outcome === '重复挡回')

console.log(failed === 0 ? '\n全部断言通过' : `\n${failed} 条断言失败`)
process.exit(failed === 0 ? 0 : 1)
