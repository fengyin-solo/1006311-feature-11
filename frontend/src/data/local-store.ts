import { SEED_ROWS } from './seed'
import { migrateEnergy, migrateFirecontrol, SCHEMA_VERSION } from './migration'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'urban-utility-tunnel:entries'
const VERSION_KEY = 'urban-utility-tunnel:schema-version'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 给旧版数据补跑存量迁移（消防历史取值对齐、隐患挂账、能耗月度搬入）。
// 迁移是幂等的：已归档行永远不动，未归档行重算结果一致，隐患只补不重。
function upgrade(data: Record<string, EntryRow[]>): void {
  const fire = data['firecontrol']
  const hazards = data['hazard']
  if (fire && hazards) {
    data['hazard'] = migrateFirecontrol(fire, hazards)
  }
  if (data['energy']) {
    migrateEnergy(data['energy'])
  }
}

function persist(data: Record<string, EntryRow[]>, version: number): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    window.localStorage.setItem(VERSION_KEY, String(version))
  }
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    upgrade(fallback)
    persist(fallback, SCHEMA_VERSION)
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const data: Record<string, EntryRow[]> = { ...clone(SEED_ROWS), ...parsed }
    const storedVersion = Number(window.localStorage.getItem(VERSION_KEY) ?? 0)
    if (storedVersion < SCHEMA_VERSION) {
      // 只升级用户库里存在的模块：缺失模块用播种数据补齐，保证迁移字段齐全。
      upgrade(data)
      persist(data, SCHEMA_VERSION)
    }
    return data
  } catch {
    window.localStorage.removeItem(STORAGE_KEY)
    window.localStorage.removeItem(VERSION_KEY)
    upgrade(fallback)
    persist(fallback, SCHEMA_VERSION)
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function saveAll(rows: Record<string, EntryRow[]>): void {
  cache = rows
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rows))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
