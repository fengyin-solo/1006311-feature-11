// 消防链路集成冒烟：用 typescript 转译 local-service 及其依赖后在 Node 里跑端到端断言。
// 覆盖：状态机驳回、隐患回写、存量回填、往期单据搬入、重置后流水清空。
// 运行：npm run test:service
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import ts from 'typescript'

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = join(here, '../src')
const outDir = mkdtempSync(join(tmpdir(), 'fire-service-'))

// local-service 的依赖闭包（类型文件也会被转译，运行时导入的是纯数据/逻辑）。
const FILES = [
  'data/types.ts',
  'data/firecontrol-flow.ts',
  'data/modules.ts',
  'data/seed.ts',
  'data/local-store.ts',
  'api/local-service.ts',
]

for (const rel of FILES) {
  const source = readFileSync(join(srcDir, rel), 'utf8')
  let { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  })
  // @ 别名与裸相对导入改写成可在 Node 里直接解析的 .mjs 路径。
  outputText = outputText
    .replace(/from '@\/data\/([^']+)'/g, `from '${join(outDir, 'data')}/$1.mjs'`)
    .replace(/from '\.\/([^']+)'/g, "from './$1.mjs'")
  const target = join(outDir, rel.replace(/\.ts$/, '.mjs'))
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, outputText)
}

const service = await import(pathToFileURL(join(outDir, 'api/local-service.mjs')).href)

let failed = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok  ${name}`)
  } else {
    failed += 1
    console.error(`FAIL  ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}
function fireRow(code) {
  return service.listEntries('firecontrol').items.find((row) => row['设施编号'] === code)
}
function hazardRow(code) {
  return service.listEntries('hazard').items.find((row) => row['来源设施'] === code)
}

service.resetModule('firecontrol')
service.resetModule('hazard')

// 单向链路：跳档驳回 → 顺序推进 → 归档终点
const jump = service.runAction('firecontrol', 1, '判定正常')
check('待检测直接判定正常被驳回并写明缺步', !jump.ok && jump.message.includes('提交检测'), jump.message)
check('提交检测推进到检测中', service.runAction('firecontrol', 1, '提交检测').ok)
const dup = service.runAction('firecontrol', 1, '提交检测')
check('同一设施重复提交检测只推进一次', !dup.ok && dup.message.includes('重复'), dup.message)
const repair = service.runAction('firecontrol', 1, '提出维修')
check('提出维修推进到需维修', repair.ok && fireRow('FIRE-0001').status === '需维修')
check('检测结论随状态落库', fireRow('FIRE-0001')['检测结论'] === '需维修')
check('隐患清单挂上待整改', hazardRow('FIRE-0001')?.status === '待整改' && hazardRow('FIRE-0001')?.pending === true)
const again = service.runAction('firecontrol', 1, '提出维修')
check('重复提出维修被挡回', !again.ok, again.message)
check('隐患清单不重复挂单', service.listEntries('hazard').items.filter((row) => row['来源设施'] === 'FIRE-0001').length === 1)
const archived = service.runAction('firecontrol', 1, '归档')
check('维修做完归档', archived.ok && fireRow('FIRE-0001').status === '归档')
check('归档回填后隐患同步验收', hazardRow('FIRE-0001')?.status === '已验收' && hazardRow('FIRE-0001')?.pending === false)
check('归档行不再是待办', fireRow('FIRE-0001').pending === false)
const back = service.runAction('firecontrol', 1, '提交检测')
check('归档后回不到检测中', !back.ok && back.message.includes('归档'), back.message)

// 存量回填：下次检测日按联动测试日 + 12 个月，超期标异常
const backfill = service.backfillFirecontrol()
check('存量回填执行成功', backfill.ok, backfill.message)
check('FIRE-0002 超期在检被标异常', fireRow('FIRE-0002').abnormal === true)
check('FIRE-0004 下次检测日 = 联动测试日 + 12 个月', fireRow('FIRE-0004')['下次检测日'] === '2027-05-06')

// 往期单据搬入：建账归档、重复挡回、归档件为准
const imported = service.importFireHistory([
  { 设施编号: 'FIRE-0006', 所属舱室: '综合舱', 消防类型: '火灾自动报警系统', 探测器数量: 30, 联动测试日: '2024-09-12', 责任人员: '王建国', 检测结论: '状态正常', 来源类型: '纸面扫描件', 来源单据: 'SCAN-2024-0096' },
  { 设施编号: 'FIRE-0006', 探测器数量: 30, 联动测试日: '2024-09-12', 检测结论: '状态正常', 来源类型: '纸面扫描件', 来源单据: 'SCAN-2024-0096' },
  { 设施编号: 'FIRE-0005', 探测器数量: 99, 联动测试日: '2024-12-20', 检测结论: '状态正常', 来源类型: '抄表周期', 来源单据: '2024Q4' },
])
check('纸面单据按扫描件编号建账归档', fireRow('FIRE-0006')?.status === '归档')
check('建账行下次检测日按周期重算', fireRow('FIRE-0006')?.['下次检测日'] === '2025-09-12', fireRow('FIRE-0006')?.['下次检测日'])
check('同一单据第二笔按重复挡回', imported.lines[1].outcome === '重复挡回')
check('与归档件冲突以归档件为准', fireRow('FIRE-0005')['探测器数量'] === 20 && imported.lines[2].outcome === '冲突以归档件为准')
const reimport = service.importFireHistory([
  { 设施编号: 'FIRE-0006', 探测器数量: 30, 联动测试日: '2024-09-12', 检测结论: '状态正常', 来源类型: '纸面扫描件', 来源单据: 'SCAN-2024-0096' },
])
check('流水里已有的单据再次搬入仍挡回', reimport.lines[0].outcome === '重复挡回')

// 待办条数与台账一致：每条隐患的 pending 都由状态决定
const hazards = service.listEntries('hazard').items
check(
  '隐患待办条数与台账状态一致',
  hazards.every((row) => row.pending === (row.status === '待整改' || row.status === '整改中')),
)

// 重置后流水清空，可以重新推进
service.resetModule('firecontrol')
check('重置后回到种子台账', fireRow('FIRE-0001')?.status === '待检测')
check('重置后同一环节可重新提交', service.runAction('firecontrol', 1, '提交检测').ok)

console.log(failed === 0 ? '\n集成冒烟全部通过' : `\n${failed} 条断言失败`)
process.exit(failed === 0 ? 0 : 1)
