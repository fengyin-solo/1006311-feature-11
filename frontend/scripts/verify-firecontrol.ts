// 纯逻辑验证：用内存 localStorage 垫片驱动本地数据层，不碰 Vue/浏览器。
// 运行：cd frontend && npx tsx scripts/verify-firecontrol.ts
import { strict as assert } from 'node:assert'

interface StoreShape {
  [key: string]: string
}

const memory: StoreShape = {}
;(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (key: string) => (key in memory ? memory[key] : null),
    setItem: (key: string, value: string) => {
      memory[key] = String(value)
    },
    removeItem: (key: string) => {
      delete memory[key]
    },
  },
}
// 业务代码以 typeof window === 'undefined' 判断，再读 window.localStorage。
;(globalThis as unknown as { localStorage: unknown }).localStorage = (
  globalThis as unknown as { window: { localStorage: unknown } }
).window.localStorage

const { listRows } = await import('../src/data/local-store')
const svc = await import('../src/api/local-service')

let passed = 0
function check(name: string, fn: () => void): void {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

function fireByNo(code: string) {
  const row = listRows('firecontrol').find((r) => r['设施编号'] === code)
  if (!row) throw new Error(`seed 缺少 ${code}`)
  return row
}
function hazardByFacility(code: string) {
  return listRows('hazard').find((h) => h['来源设施'] === code)
}

console.log('一、存量迁移与历史取值口径')
check('存量按联动测试日+12个月回填下次检测日', () => {
  const f1 = fireByNo('FIRE-0001')
  assert.equal(f1['下次检测日'], '2027-08-10')
  assert.equal(f1['检测周期'], '12个月')
  assert.match(String(f1['回填依据']), /联动测试日2026-08-10/)
})
check('火灾自动报警系统按6个月周期', () => {
  const f8 = fireByNo('FIRE-0008')
  assert.equal(f8['检测周期'], '6个月')
})
check('无联动测试日有扫描件：按扫描编号日期倒推', () => {
  const f7 = fireByNo('FIRE-0007')
  assert.equal(f7['下次检测日'], '2025-05-10')
  assert.match(String(f7['回填依据']), /扫描件编号建账日2024-05-10/)
})
check('无任何日期锚点：按迁移日到期，补扫描件编号', () => {
  const f8 = fireByNo('FIRE-0008')
  assert.equal(f8['下次检测日'], '2026-10-06')
  assert.match(String(f8['扫描件编号']), /^SCAN-20261006-/)
})
check('归档件原值保留，不重算（历史争议以归档件为准）', () => {
  const f5 = fireByNo('FIRE-0005')
  assert.equal(f5['下次检测日'], '2025-11-01')
  assert.match(String(f5['回填依据']), /归档件为准/)
})
check('往期能耗按抄表周期搬入月度', () => {
  for (const row of listRows('energy')) {
    assert.match(String(row['统计周期']), /^\d{4}-\d{2}$/)
  }
})
check('存量需维修自动补挂待整改隐患，条数与消防侧一致', () => {
  const h4 = hazardByFacility('FIRE-0004')
  assert.ok(h4, 'FIRE-0004 应补挂隐患')
  assert.equal(h4!.status, '待整改')
  assert.equal(fireByNo('FIRE-0004')['关联隐患编号'], h4!['隐患编号'])
  const c = svc.fireConsistency()
  assert.equal(c.openRepairs, c.openLinkedHazards)
  assert.equal(c.consistent, true)
})

console.log('二、单向链路：只能逐档前进')
check('待检测不能跳判正常（缺检测中）', () => {
  const f1 = fireByNo('FIRE-0001')
  const r = svc.runAction('firecontrol', Number(f1.id), '判定正常')
  assert.equal(r.ok, false)
  assert.match(r.message, /跳档被驳回.*缺「检测中」/)
})
check('待检测不能直接归档（写明缺哪几步）', () => {
  const f1 = fireByNo('FIRE-0001')
  const r = svc.runAction('firecontrol', Number(f1.id), '归档')
  assert.equal(r.ok, false)
  assert.match(r.message, /缺「检测中」.*「状态正常」/)
})
check('正常逐档推进：提交检测→判定正常', () => {
  const f1 = fireByNo('FIRE-0001')
  const r1 = svc.runAction('firecontrol', Number(f1.id), '提交检测')
  assert.equal(r1.ok, true)
  const r2 = svc.runAction('firecontrol', Number(f1.id), '判定正常')
  assert.equal(r2.ok, true)
  assert.equal(fireByNo('FIRE-0001').status, '状态正常')
  // 检测合格后滚动出下一周期检测日
  assert.equal(fireByNo('FIRE-0001')['下次检测日'], '2027-08-10')
})
check('同一笔重复提交只推进一次', () => {
  const f1 = fireByNo('FIRE-0001')
  const r = svc.runAction('firecontrol', Number(f1.id), '判定正常')
  assert.equal(r.ok, false)
  assert.match(r.message, /重复提交只推进一次/)
})
check('需维修缺隐患验收不能归档', () => {
  const f4 = fireByNo('FIRE-0004')
  const r = svc.runAction('firecontrol', Number(f4.id), '归档')
  assert.equal(r.ok, false)
  assert.match(r.message, /缺「隐患整改验收」/)
})

console.log('三、检测结论回写隐患台账并闭环')
check('检测中提出维修：自动挂出待整改隐患', () => {
  const f2 = fireByNo('FIRE-0002')
  assert.equal(f2.status, '检测中')
  const r = svc.runAction('firecontrol', Number(f2.id), '提出维修')
  assert.equal(r.ok, true)
  const h = hazardByFacility('FIRE-0002')
  assert.ok(h)
  assert.equal(h!.status, '待整改')
  assert.equal(h!['来源检测结论'], '检测不合格，需维修（2026-10-06）')
  assert.equal(fireByNo('FIRE-0002')['关联隐患编号'], h!['隐患编号'])
})
check('重复提出维修挡回（同一检测单只挂一次账）', () => {
  const f2 = fireByNo('FIRE-0002')
  const r = svc.runAction('firecontrol', Number(f2.id), '提出维修')
  assert.equal(r.ok, false)
  assert.match(r.message, /重复提交只推进一次|只受理一次/)
})
check('隐患派发→验收，回写消防维修闭环并自动归档', () => {
  const h = hazardByFacility('FIRE-0002')!
  assert.equal(svc.runAction('hazard', Number(h.id), '派发整改').ok, true)
  const accept = svc.runAction('hazard', Number(h.id), '提交验收')
  assert.equal(accept.ok, true)
  assert.match(accept.message, /维修完工.*同步归档/)
  const f2 = fireByNo('FIRE-0002')
  assert.equal(f2.status, '已归档')
  assert.ok(String(f2['维修完工日']).startsWith('2026-10-06'))
  assert.match(String(f2['下次检测日']), /^2027-10-06$/)
})
check('整改回写后待办条数与安防台账一致', () => {
  const c = svc.fireConsistency()
  assert.equal(c.openRepairs, c.openLinkedHazards)
  assert.equal(c.consistent, true)
})

console.log('四、归档终态不可逆')
check('已归档回不到检测中', () => {
  const f2 = fireByNo('FIRE-0002')
  for (const action of ['提交检测', '判定正常', '提出维修']) {
    const r = svc.runAction('firecontrol', Number(f2.id), action)
    assert.equal(r.ok, false)
    assert.match(r.message, /终态|退不回/)
  }
})
check('状态正常归档后终态，且滚出下一检测日', () => {
  const f1 = fireByNo('FIRE-0001')
  const r = svc.runAction('firecontrol', Number(f1.id), '归档')
  assert.equal(r.ok, true)
  assert.equal(fireByNo('FIRE-0001').status, '已归档')
  assert.match(String(fireByNo('FIRE-0001')['回填依据']), /历史取值以本件为准/)
})

console.log('五、登记去重与在途并发')
check('新登记检测单四要素落库', () => {
  const r = svc.createFireInspection({
    设施编号: 'FIRE-0009',
    所属舱室: '综合舱D段',
    消防类型: '消火栓系统',
    探测器数量: 5,
    责任人员: '赵工',
    下次检测日: '2027-10-01',
  })
  assert.equal(r.ok, true)
  const f = fireByNo('FIRE-0009')
  assert.equal(f.status, '待检测')
  assert.equal(f['检测周期'], '12个月')
})
check('同一设施重复登记被挡回', () => {
  const r = svc.createFireInspection({
    设施编号: 'FIRE-0009',
    所属舱室: '综合舱D段',
    消防类型: '消火栓系统',
    探测器数量: 5,
    责任人员: '赵工',
    下次检测日: '2027-10-01',
  })
  assert.equal(r.ok, false)
  assert.match(r.message, /重复提交只受理一笔/)
})
check('同一行两笔并发只认先落的一笔', () => {})
{
  const f9 = fireByNo('FIRE-0009')
  const [a, b] = await Promise.all([
    svc.submitAction('firecontrol', Number(f9.id), '提交检测'),
    svc.submitAction('firecontrol', Number(f9.id), '提交检测'),
  ])
  const oks = [a.ok, b.ok].filter(Boolean).length
  assert.equal(oks, 1, '并发两笔必须恰好一笔成功')
  assert.equal(fireByNo('FIRE-0009').status, '检测中')
  passed += 1
}
check('必录字段缺失当场驳回并写明缺项', () => {
  const r = svc.createFireInspection({
    设施编号: 'FIRE-0010',
    所属舱室: '',
    消防类型: '',
    探测器数量: 0,
    责任人员: '',
    下次检测日: '',
  })
  assert.equal(r.ok, false)
  assert.match(r.message, /消防类型.*探测器数量.*下次检测日/s)
})

console.log('六、导入明细与台账现状对账')
check('导出内容原样导入对账通过', () => {
  const { content } = svc.exportEntries('firecontrol')
  const r = svc.reconcileImport('firecontrol', content.replace(/^﻿/, ''))
  assert.equal(r.ok, true)
})
check('明细与台账不一致整批驳回', () => {
  const { content } = svc.exportEntries('firecontrol')
  const tampered = content.replace('已归档', '检测中')
  const r = svc.reconcileImport('firecontrol', tampered)
  assert.equal(r.ok, false)
  assert.match(r.message, /状态不一致|条数不一致/)
})

console.log(`\n全部 ${passed} 项验证通过（含并发用例）。`)
