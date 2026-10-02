import type { NameHistory } from './history'
import type { PlacePair } from './placePair'
import type { ScanItem } from './scan'
import type { Sheet } from './sheet'

/** 撤编流程的阶段标记，用于区分已固定检查点与已完成撤编。 */
export type WithdrawalStage = 'pinned' | 'committed' | 'restored'

/**
 * 受影响邻接图记录。
 * 撤编时凡 neighborCodes 指向本图幅的邻图都会固定其原邻接表，
 * 以便回滚（撤销撤编）时逐条恢复，避免只改了看得见的一边。
 */
export interface AffectedNeighbor {
  sheetId: string
  code: string
  /** 撤编前邻图 neighborCodes 的完整副本。 */
  neighborCodesBefore: string[]
  /** 提交时是否确实把本图幅图号移出了邻接表。 */
  detached: boolean
}

/** 打开撤编确认页时固定下来的图幅资料快照。 */
export interface WithdrawalSnapshot {
  sheet: Sheet
  scans: ScanItem[]
  placePairs: PlacePair[]
  histories: NameHistory[]
  /** 固定时解析出的受影响邻接图（双向）。 */
  affectedNeighbors: AffectedNeighbor[]
  pinnedAt: string
}

/**
 * 撤编检查点，同时也是撤编结果的持久记录。
 * stage=pinned：确认页已固定资料、等待提交；
 * stage=committed：撤编已一次写入完成，可据此撤销；
 * stage=restored：曾撤编后又从快照撤销，记录留存归档。
 */
export interface WithdrawalRecord {
  id: string
  sheetId: string
  sheetCode: string
  stage: WithdrawalStage
  reason: string
  snapshot: WithdrawalSnapshot
  /** 固定时各项资料的指纹，用于发现另一页签的并发改动。 */
  fingerprint: WithdrawalFingerprint
  /** 最近一次写入（固定/提交/恢复）时间。 */
  updatedAt: string
  committedAt?: string
  /** 提交或恢复失败时的说明，用于检查点恢复提示。 */
  lastError?: string
}

/** 固定资料的逐项指纹；任一不一致即说明固定后资料被改动过。 */
export interface WithdrawalFingerprint {
  scansHash: string
  placePairsHash: string
  historiesHash: string
  /** 本图幅 neighborCodes 与指向本图幅的邻图邻接表指纹。 */
  neighborsHash: string
  /** 图幅核心编目字段指纹，防止固定期间图幅卡本身被改。 */
  sheetHash: string
}

/** 指纹复核的单项结果。 */
export interface FingerprintMismatch {
  label: string
  detail: string
}
