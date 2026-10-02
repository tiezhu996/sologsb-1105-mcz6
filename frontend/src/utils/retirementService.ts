import { RETIRED_STATUS, type Sheet, type SheetStatus } from '../types/sheet'
import type {
  AffectedNeighborMemento,
  RetirementRecord,
  RetirementSnapshot,
} from '../types/retirement'
import { createId, db, plain } from './db'
import { fingerprintOf } from './retirementSnapshot'

/** 固定快照后另一页签又动过资料，需重新核对 */
export class RetirementStaleError extends Error {
  constructor(public readonly checkpointId: string | null) {
    super('固定资料已被其他页签修改，请重新核对后再撤编。')
    this.name = 'RetirementStaleError'
  }
}

/** 撤编主事务失败，检查点仍在，可据此恢复 */
export class RetirementCommitError extends Error {
  constructor(message: string, public readonly checkpointId: string) {
    super(message)
    this.name = 'RetirementCommitError'
  }
}

export interface RecoverResult {
  checkpointId: string
  restoredSheet: boolean
  restoredNeighborIds: string[]
}

/** 把撤编时摘掉的图号按原位插回去，不覆盖邻接图在撤编后新增的其他邻接关系 */
function withCodeRestored(currentCodes: string[], targetCode: string, beforeCodes: string[]): string[] {
  if (currentCodes.includes(targetCode)) {
    return currentCodes
  }
  const index = beforeCodes.indexOf(targetCode)
  const next = [...currentCodes]
  next.splice(Math.max(0, Math.min(index, next.length)), 0, targetCode)
  return next
}

async function findDoneRecord(sheetId: string): Promise<RetirementRecord | undefined> {
  const records = await db.retirements.where('sheetId').equals(sheetId).toArray()
  return records.find((record) => record.state === 'done')
}

/**
 * 确认撤编：
 * 1. 先单独落一条 checkpoint（含确认页固定的资料快照和邻接图旧值），即使后续写入中断也不丢；
 * 2. 随后在同一个 IndexedDB 事务里写撤编状态、撤编快照登记、受影响邻接图，
 *    IndexedDB 保证该事务要么全部生效、要么整体回滚，不会留下半套撤编结果；
 * 3. 事务内再次重读资料并与确认页固定时的指纹比对，另一个页签若在确认前落了改动会在这里被拦下。
 */
export async function commitRetirement(
  sheetId: string,
  reason: string,
  fixed: { snapshot: RetirementSnapshot; fingerprint: string; affectedNeighbors: AffectedNeighborMemento[] },
): Promise<RetirementRecord> {
  // 进入主流程前先现读一次，尽早给出“已撤编/不存在”等明确提示
  const precheckSheet = await db.sheets.get(sheetId)
  if (!precheckSheet) {
    throw new Error('图幅不存在，无法撤编。')
  }
  if (precheckSheet.status === RETIRED_STATUS || (await findDoneRecord(sheetId))) {
    throw new Error('该图幅已处于撤编状态，无需重复撤编。')
  }

  const now = new Date().toISOString()
  const checkpoint: RetirementRecord = {
    id: createId('checkpoint'),
    sheetId,
    sheetCode: fixed.snapshot.sheet.code,
    reason: reason.trim(),
    createdAt: now,
    state: 'checkpoint',
    fingerprint: fixed.fingerprint,
    snapshot: plain(fixed.snapshot),
    affectedNeighbors: plain(fixed.affectedNeighbors),
  }

  // 阶段一：检查点先独立落库
  await db.retirements.add(plain(checkpoint))

  // 阶段二：一次写入撤编状态、资料快照和受影响邻接图
  try {
    return await db.transaction(
      'rw',
      db.sheets,
      db.scans,
      db.placePairs,
      db.histories,
      db.retirements,
      async () => {
        const sheet = await db.sheets.get(sheetId)
        if (!sheet) {
          throw new Error('图幅在撤编写入时已不存在。')
        }
        if (sheet.status === RETIRED_STATUS) {
          throw new Error('该图幅已被其他页签撤编。')
        }

        const scans = await db.scans.where('sheetId').equals(sheetId).toArray()
        const placePairs = await db.placePairs.where('sheetId').equals(sheetId).toArray()
        const pairIds = new Set(placePairs.map((pair) => pair.id))
        const histories = (await db.histories.toArray()).filter((history) => pairIds.has(history.placePairId))
        const currentFingerprint = fingerprintOf([sheet, scans, placePairs, histories])
        if (currentFingerprint !== checkpoint.fingerprint) {
          throw new RetirementStaleError(checkpoint.id)
        }

        for (const memento of checkpoint.affectedNeighbors) {
          await db.sheets.update(memento.sheetId, (neighbor: Sheet) => {
            neighbor.neighborCodes = neighbor.neighborCodes.filter((code) => code !== checkpoint.sheetCode)
          })
        }
        await db.sheets.update(sheetId, { status: RETIRED_STATUS as SheetStatus })

        const record: RetirementRecord = {
          ...checkpoint,
          state: 'done',
          finalizedAt: new Date().toISOString(),
        }
        await db.retirements.put(plain(record))
        return record
      },
    )
  } catch (error) {
    // 主事务整体回滚，但阶段一的检查点仍在：立刻按检查点恢复到撤编前状态
    await recoverCheckpoint(checkpoint.id).catch(() => undefined)
    if (error instanceof RetirementStaleError) {
      throw error
    }
    throw new RetirementCommitError(
      '撤编写入未完成，已按检查点恢复到撤编前状态，可稍后重试。',
      checkpoint.id,
    )
  }
}

/**
 * 从检查点恢复：把可能已被半程写入的图幅状态与邻接关系还原，再删除检查点。
 * 已完成的 done 登记不是检查点，不会被误删。
 */
export async function recoverCheckpoint(checkpointId: string): Promise<RecoverResult | null> {
  const checkpoint = await db.retirements.get(checkpointId)
  if (!checkpoint || checkpoint.state === 'done') {
    return null
  }

  const result: RecoverResult = {
    checkpointId,
    restoredSheet: false,
    restoredNeighborIds: [],
  }

  await db.transaction('rw', db.sheets, db.retirements, async () => {
    const sheet = await db.sheets.get(checkpoint.sheetId)
    if (sheet && sheet.status === RETIRED_STATUS) {
      await db.sheets.update(checkpoint.sheetId, { status: checkpoint.snapshot.sheet.status })
      result.restoredSheet = true
    }

    for (const memento of checkpoint.affectedNeighbors) {
      const neighbor = await db.sheets.get(memento.sheetId)
      if (!neighbor || neighbor.neighborCodes.includes(checkpoint.sheetCode)) {
        continue
      }
      // 仅当现状只是少了撤编图号时才还原，避免覆盖其他页签的正当修改
      const beforeWithoutCode = memento.neighborCodesBefore.filter((code) => code !== checkpoint.sheetCode)
      const onlyCodeMissing =
        neighbor.neighborCodes.length === beforeWithoutCode.length &&
        neighbor.neighborCodes.every((code) => beforeWithoutCode.includes(code))
      if (onlyCodeMissing) {
        await db.sheets.update(memento.sheetId, {
          neighborCodes: withCodeRestored(
            neighbor.neighborCodes,
            checkpoint.sheetCode,
            memento.neighborCodesBefore,
          ),
        })
        result.restoredNeighborIds.push(memento.sheetId)
      }
    }

    await db.retirements.delete(checkpoint.id)
  })

  return result
}

/** 应用启动时回收上次写入中断遗留的检查点 */
export async function recoverAllCheckpoints(): Promise<RecoverResult[]> {
  const pending = await db.retirements.where('state').equals('checkpoint').toArray()
  const results: RecoverResult[] = []
  for (const checkpoint of pending) {
    const result = await recoverCheckpoint(checkpoint.id).catch(() => null)
    if (result) {
      results.push(result)
    }
  }
  return results
}

/**
 * 从快照撤销撤编：恢复图幅原状态、把图号插回各邻接图，并删除撤编登记。
 * 原扫描件、地名对照和沿革始终保留在各自表中，无需重放。
 */
export async function undoRetirement(sheetId: string): Promise<RetirementSnapshot> {
  return db.transaction('rw', db.sheets, db.retirements, async () => {
    const record = await findDoneRecord(sheetId)
    if (!record) {
      throw new Error('没有可撤销的撤编快照。')
    }

    await db.sheets.update(sheetId, { status: record.snapshot.sheet.status })
    for (const memento of record.affectedNeighbors) {
      await db.sheets.update(memento.sheetId, (neighbor: Sheet) => {
        neighbor.neighborCodes = withCodeRestored(
          neighbor.neighborCodes,
          record.sheetCode,
          memento.neighborCodesBefore,
        )
      })
    }
    await db.retirements.delete(record.id)
    return record.snapshot
  })
}
