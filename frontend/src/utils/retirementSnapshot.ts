import type { NameHistory } from '../types/history'
import type { PlacePair } from '../types/placePair'
import type { RetirementSnapshot } from '../types/retirement'
import type { ScanItem } from '../types/scan'
import type { Sheet } from '../types/sheet'
import { db, plain } from './db'

/**
 * 32 位 FNV-1a 哈希。快照指纹只用于判断“另一页签是否改过这份资料”，
 * 无需密码学强度，但必须对任意字段变化敏感。
 */
export function fingerprintOf(parts: unknown[]): string {
  const serialized = parts
    .map((part) => JSON.stringify(part ?? null))
    .sort()
    .join('|')
  let hash = 0x811c9dc5
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export interface CapturedSnapshot {
  snapshot: RetirementSnapshot
  fingerprint: string
  placePairs: PlacePair[]
  histories: NameHistory[]
}

/**
 * 从数据库重新固定一份资料。
 * 扫描件、地名对照、沿革清单一律现场读取，不采信内存里的旧状态，
 * 这样另一个页签的改动只要已落库就能被发现。
 */
export async function captureSnapshot(sheetId: string): Promise<CapturedSnapshot> {
  const sheet = await db.sheets.get(sheetId)
  if (!sheet) {
    throw new Error('图幅不存在，无法固定资料。')
  }

  const scans = await db.scans.where('sheetId').equals(sheetId).toArray()
  const placePairs = await db.placePairs.where('sheetId').equals(sheetId).toArray()
  const pairIds = new Set(placePairs.map((pair) => pair.id))
  const histories = (await db.histories.toArray()).filter((history) => pairIds.has(history.placePairId))

  const snapshot: RetirementSnapshot = {
    sheet: plain(sheet),
    scans: plain(scans),
    placePairs: plain(placePairs),
    histories: plain(histories),
    fixedAt: new Date().toISOString(),
  }

  return {
    snapshot,
    placePairs,
    histories,
    fingerprint: fingerprintOf([sheet, scans, placePairs, histories]),
  }
}

/**
 * 找出会被本次撤编牵连的邻接图：
 * neighborCodes 中登记了被撤编图号的图幅，写入时要把该图号摘掉，
 * 撤编前在此记录旧值，撤销撤编时据此恢复。
 */
export async function collectAffectedNeighbors(sheet: Sheet): Promise<Sheet[]> {
  const allSheets = await db.sheets.toArray()
  return allSheets
    .filter((candidate) => candidate.id !== sheet.id && candidate.neighborCodes.includes(sheet.code))
    .sort((left, right) => left.code.localeCompare(right.code, 'zh-CN'))
}

/** 判断一次跨页签广播是否落在当前固定快照覆盖的图幅或邻接关系上 */
export function messageTouchesSheet(
  message: { sheetIds: string[]; neighborSheetIds?: string[] },
  sheetId: string,
  affectedSheetIds: string[],
): boolean {
  const allIds = new Set([sheetId, ...affectedSheetIds])
  return [...message.sheetIds, ...(message.neighborSheetIds ?? [])].some((id) => allIds.has(id))
}
