import type { NameHistory } from './history'
import type { PlacePair } from './placePair'
import type { ScanItem } from './scan'
import type { Sheet } from './sheet'

export type RetirementState = 'checkpoint' | 'done'

/** 打开撤编确认页时固定的资料清单 */
export interface RetirementSnapshot {
  sheet: Sheet
  scans: ScanItem[]
  placePairs: PlacePair[]
  histories: NameHistory[]
  fixedAt: string
}

/** 撤编会改动的邻接图，记下旧值以便从快照撤销 */
export interface AffectedNeighborMemento {
  sheetId: string
  code: string
  neighborCodesBefore: string[]
}

/** 撤编登记：checkpoint 为写入前检查点，done 为正式撤编完成 */
export interface RetirementRecord {
  id: string
  sheetId: string
  sheetCode: string
  reason: string
  createdAt: string
  finalizedAt?: string
  state: RetirementState
  fingerprint: string
  snapshot: RetirementSnapshot
  affectedNeighbors: AffectedNeighborMemento[]
}

/** 确认页内存中的固定结果，尚未写入检查点 */
export interface RetirementDraft {
  sheetId: string
  sheetCode: string
  snapshot: RetirementSnapshot
  fingerprint: string
  affectedNeighbors: AffectedNeighborMemento[]
}
