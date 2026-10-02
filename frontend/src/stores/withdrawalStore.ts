import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { NameHistory } from '../types/history'
import type { PlacePair } from '../types/placePair'
import type { ScanItem } from '../types/scan'
import type { Sheet } from '../types/sheet'
import type {
  AffectedNeighbor,
  FingerprintMismatch,
  WithdrawalFingerprint,
  WithdrawalRecord,
  WithdrawalSnapshot,
} from '../types/withdrawal'
import { createId, db, plain } from '../utils/db'
import { stableRecordHash, stableValueHash } from '../utils/fingerprint'
import { publishChange, subscribeCatalogChanges } from '../utils/crossTab'

/** 一次撤编涉及的全部资料集合，始终在同一个 Dexie 事务中读取或写入。 */
interface WithdrawalMaterial {
  sheet: Sheet
  scans: ScanItem[]
  placePairs: PlacePair[]
  histories: NameHistory[]
  affectedNeighbors: AffectedNeighbor[]
}

/** 指纹校验失败，提示馆员重新核对。 */
export class FingerprintError extends Error {
  mismatches: FingerprintMismatch[]

  constructor(mismatches: FingerprintMismatch[]) {
    super('撤编资料自固定后已发生变化，请重新核对。')
    this.name = 'FingerprintError'
    this.mismatches = mismatches
  }
}

async function readMaterial(sheetId: string): Promise<WithdrawalMaterial> {
  const sheet = await db.sheets.get(sheetId)
  if (!sheet) {
    throw new Error('未找到该图幅，无法办理撤编。')
  }
  const [scans, placePairs, allHistories, allSheets] = await Promise.all([
    db.scans.where('sheetId').equals(sheetId).toArray(),
    db.placePairs.where('sheetId').equals(sheetId).toArray(),
    db.histories.toArray(),
    db.sheets.toArray(),
  ])
  const pairIds = new Set(placePairs.map((pair) => pair.id))
  const histories = allHistories.filter((history) => pairIds.has(history.placePairId))
  const affectedNeighbors = resolveAffectedNeighbors(sheet, allSheets)
  return { sheet, scans, placePairs, histories, affectedNeighbors }
}

/**
 * 受影响邻接图：除本图幅自己登记的四至外，凡邻接表里写了本图幅图号
 * 的邻图也要一并固定，撤编时双向摘挂，避免只清掉看得见的一边。
 */
function resolveAffectedNeighbors(sheet: Sheet, allSheets: Sheet[]): AffectedNeighbor[] {
  const incoming = allSheets.filter(
    (candidate) => candidate.id !== sheet.id && candidate.neighborCodes.includes(sheet.code),
  )
  const byId = new Map<string, Sheet>()
  for (const neighbor of incoming) {
    byId.set(neighbor.id, neighbor)
  }
  // 本图幅自己邻接表中馆藏存在的图幅同样受影响（撤编后这些邻图指向一幅已撤编图）。
  for (const code of sheet.neighborCodes) {
    const matched = allSheets.find((candidate) => candidate.code === code)
    if (matched && matched.id !== sheet.id) {
      byId.set(matched.id, matched)
    }
  }
  return [...byId.values()]
    .sort((left, right) => left.code.localeCompare(right.code, 'zh-CN'))
    .map((neighbor) => ({
      sheetId: neighbor.id,
      code: neighbor.code,
      neighborCodesBefore: [...neighbor.neighborCodes],
      detached: neighbor.neighborCodes.includes(sheet.code),
    }))
}

function computeFingerprint(material: WithdrawalMaterial): WithdrawalFingerprint {
  return {
    scansHash: stableRecordHash(material.scans),
    placePairsHash: stableRecordHash(material.placePairs),
    historiesHash: stableRecordHash(material.histories),
    neighborsHash: stableValueHash({
      own: material.sheet.neighborCodes,
      incoming: material.affectedNeighbors.map((neighbor) => ({
        id: neighbor.sheetId,
        codes: neighbor.neighborCodesBefore,
      })),
    }),
    sheetHash: stableValueHash({
      code: material.sheet.code,
      title: material.sheet.title,
      year: material.sheet.year,
      scale: material.sheet.scale,
      projection: material.sheet.projection,
      sheetSizeCm: material.sheet.sheetSizeCm,
      series: material.sheet.series,
      status: material.sheet.status,
    }),
  }
}

function diffFingerprint(pinned: WithdrawalFingerprint, current: WithdrawalFingerprint): FingerprintMismatch[] {
  const checks: Array<{ key: keyof WithdrawalFingerprint; label: string; detail: string }> = [
    { key: 'sheetHash', label: '图幅编目卡', detail: '图幅号、题名、年代、比例尺或状态等字段已被修改' },
    { key: 'scansHash', label: '扫描件', detail: '扫描件被新增、删除或调整了主用件' },
    { key: 'placePairsHash', label: '地名对照', detail: '地名对照条目被新增、删除或修改' },
    { key: 'historiesHash', label: '沿革清单', detail: '沿革记录被新增、删除或修改' },
    { key: 'neighborsHash', label: '邻接关系', detail: '本图幅或邻图的邻接表已变动' },
  ]
  return checks
    .filter((check) => pinned[check.key] !== current[check.key])
    .map((check) => ({ label: check.label, detail: check.detail }))
}

export const useWithdrawalStore = defineStore('withdrawal', () => {
  /** 当前详情页正在办理的撤编记录（pinned 或 committed）。 */
  const currentRecord = ref<WithdrawalRecord | null>(null)
  const busy = ref(false)
  const lastError = ref('')

  /**
   * 打开撤编确认页：在同一个只读事务里固定扫描件、地名对照、
   * 沿革清单与受影响邻接图，写入 pinned 检查点。
   * 若已有未完成的 pinned 检查点，则以当前资料重新固定。
   */
  async function pin(sheetId: string, reason: string): Promise<WithdrawalRecord> {
    busy.value = true
    lastError.value = ''
    try {
      const material = await db.transaction('r', [db.sheets, db.scans, db.placePairs, db.histories], async () =>
        readMaterial(sheetId),
      )
      if (material.sheet.status === '已撤编') {
        throw new Error('该图幅已撤编，无需重复办理。')
      }

      const now = new Date().toISOString()
      // 每个图幅只保留一条撤编记录：撤销后再次撤编时沿用同一 id，
      // 旧快照被新检查点覆盖，详情页始终展示最近一次办理。
      const existing = await db.withdrawals.where('sheetId').equals(sheetId).first()
      const record: WithdrawalRecord = {
        id: existing?.id ?? createId('withdraw'),
        sheetId,
        sheetCode: material.sheet.code,
        stage: 'pinned',
        reason: reason.trim(),
        snapshot: toSnapshot(material, now),
        fingerprint: computeFingerprint(material),
        updatedAt: now,
      }
      await db.withdrawals.put(plain(record))
      currentRecord.value = record
      publishChange('withdrawal-pinned', sheetId)
      return record
    } finally {
      busy.value = false
    }
  }

  /**
   * 复核固定的资料是否仍与库中一致（跨页签改动后重新核对、提交前都会调用）。
   * 返回不一致明细；空数组表示资料未变动。
   */
  async function reverify(): Promise<FingerprintMismatch[]> {
    const record = currentRecord.value
    if (!record) {
      return []
    }
    const material = await db.transaction('r', [db.sheets, db.scans, db.placePairs, db.histories], async () =>
      readMaterial(record.sheetId),
    )
    return diffFingerprint(record.fingerprint, computeFingerprint(material))
  }

  /**
   * 确认撤编：单个读写事务内完成全部写入——
   * 1. 在同一事务里重算指纹，固定后资料有变动则抛错回滚；
   * 2. 图幅状态置为已撤编；
   * 3. 受影响邻接图的邻接表摘除本图幅图号；
   * 4. 撤编记录转为 committed 并保存资料快照。
   * 任一步失败整个事务回滚，不会留下半套撤编结果。
   */
  async function commit(): Promise<void> {
    const record = currentRecord.value
    if (!record || record.stage !== 'pinned') {
      throw new Error('请先打开撤编确认页并固定资料。')
    }
    busy.value = true
    lastError.value = ''
    try {
      await db.transaction(
        'rw',
        [db.sheets, db.scans, db.placePairs, db.histories, db.withdrawals],
        async () => {
          const material = await readMaterial(record.sheetId)
          const mismatches = diffFingerprint(record.fingerprint, computeFingerprint(material))
          if (mismatches.length > 0) {
            throw new FingerprintError(mismatches)
          }
          if (material.sheet.status === '已撤编') {
            throw new Error('该图幅已被其他页签撤编，请刷新后重新核对。')
          }

          await db.sheets.update(record.sheetId, { status: '已撤编' })

          for (const neighbor of material.affectedNeighbors) {
            if (!neighbor.detached) {
              continue
            }
            const latest = await db.sheets.get(neighbor.sheetId)
            if (!latest) {
              continue
            }
            const nextCodes = latest.neighborCodes.filter((code) => code !== record.sheetCode)
            await db.sheets.update(neighbor.sheetId, { neighborCodes: nextCodes })
          }

          const now = new Date().toISOString()
          const committed: WithdrawalRecord = {
            ...record,
            reason: record.reason,
            stage: 'committed',
            updatedAt: now,
            committedAt: now,
            lastError: undefined,
          }
          await db.withdrawals.put(plain(committed))
          currentRecord.value = committed
        },
      )
      publishChange('withdrawal-committed', record.sheetId)
    } catch (error) {
      // 事务已整体回滚；把失败原因留在检查点上，便于稍后从检查点恢复。
      const message = error instanceof Error ? error.message : '撤编写入失败。'
      lastError.value = message
      await markCheckpointError(record.sheetId, message)
      throw error
    } finally {
      busy.value = false
    }
  }

  /**
   * 从快照撤销撤编：恢复图幅原状态、原邻接表及各邻图指向，
   * 原始扫描件、地名、沿革本来未删除，无需重建。
   * 同样在单个事务内完成，失败整体回滚。
   */
  async function restoreFromSnapshot(): Promise<void> {
    const record = currentRecord.value
    if (!record || record.stage !== 'committed') {
      throw new Error('没有可撤销的撤编快照。')
    }
    busy.value = true
    lastError.value = ''
    try {
      await db.transaction('rw', [db.sheets, db.withdrawals], async () => {
        const currentSheet = await db.sheets.get(record.sheetId)
        if (!currentSheet) {
          throw new Error('图幅记录已不存在，无法撤销撤编。')
        }
        if (currentSheet.status !== '已撤编') {
          throw new Error('图幅当前不是已撤编状态，请勿重复撤销。')
        }

        await db.sheets.put(plain(record.snapshot.sheet))
        for (const neighbor of record.snapshot.affectedNeighbors) {
          const latest = await db.sheets.get(neighbor.sheetId)
          if (latest) {
            await db.sheets.update(neighbor.sheetId, {
              neighborCodes: [...neighbor.neighborCodesBefore],
            })
          }
        }

        const now = new Date().toISOString()
        const restored: WithdrawalRecord = {
          ...record,
          stage: 'restored',
          updatedAt: now,
          lastError: undefined,
        }
        await db.withdrawals.put(plain(restored))
        currentRecord.value = restored
      })
      publishChange('withdrawal-restored', record.sheetId)
    } catch (error) {
      const message = error instanceof Error ? error.message : '撤销撤编失败。'
      lastError.value = message
      throw error
    } finally {
      busy.value = false
    }
  }

  /**
   * 从检查点恢复：上次提交在事务内失败（已自动回滚）或中断在半途中时，
   * 依据 pinned 检查点把图幅与邻接表复位到固定时状态，并作废该检查点，
   * 由馆员重新核对后再办。
   */
  async function recoverFromCheckpoint(): Promise<{ recovered: boolean; detail: string }> {
    const record = currentRecord.value
    if (!record) {
      return { recovered: false, detail: '当前没有可恢复的检查点。' }
    }
    busy.value = true
    try {
      const result = await db.transaction(
        'rw',
        [db.sheets, db.withdrawals],
        async (): Promise<{ recovered: boolean; detail: string }> => {
          const sheet = await db.sheets.get(record.sheetId)
          if (!sheet) {
            await db.withdrawals.delete(record.id)
            currentRecord.value = null
            return { recovered: true, detail: '图幅已不存在，已作废残留检查点。' }
          }

          const partialWithdraw = sheet.status === '已撤编'
          if (partialWithdraw) {
            // 半套撤编：图幅状态被写了但检查点仍是 pinned，按快照复位。
            await db.sheets.put(plain(record.snapshot.sheet))
            for (const neighbor of record.snapshot.affectedNeighbors) {
              const latest = await db.sheets.get(neighbor.sheetId)
              if (latest) {
                await db.sheets.update(neighbor.sheetId, {
                  neighborCodes: [...neighbor.neighborCodesBefore],
                })
              }
            }
          }

          await db.withdrawals.delete(record.id)
          currentRecord.value = null
          return {
            recovered: true,
            detail: partialWithdraw
              ? '检测到半套撤编结果，已按检查点快照恢复图幅与邻接关系，请重新核对后再办。'
              : '上次撤编未写入完整结果，已恢复到固定前状态，请重新核对后再办。',
          }
        },
      )
      publishChange('withdrawal-restored', record.sheetId)
      return result
    } finally {
      busy.value = false
    }
  }

  /** 放弃固定、作废检查点（确认页取消）。 */
  async function cancelPin(): Promise<void> {
    const record = currentRecord.value
    if (!record) {
      return
    }
    if (record.stage === 'pinned') {
      await db.withdrawals.delete(record.id)
    }
    const sheetId = record.sheetId
    currentRecord.value = null
    publishChange('withdrawal-cancelled', sheetId)
  }

  /** 载入某图幅最近一次撤编记录（详情页展示快照与撤销入口）。 */
  async function loadForSheet(sheetId: string): Promise<WithdrawalRecord | null> {
    const records = await db.withdrawals.where('sheetId').equals(sheetId).toArray()
    const record =
      records.sort((left, right) =>
        left.updatedAt < right.updatedAt ? 1 : left.updatedAt > right.updatedAt ? -1 : 0,
      )[0] ?? null
    currentRecord.value = record
    return record
  }

  /** 编目台整库导出时取出全部撤编记录（含快照）。 */
  async function listAll(): Promise<WithdrawalRecord[]> {
    return db.withdrawals.toArray()
  }

  function clearCurrent(): void {
    currentRecord.value = null
    lastError.value = ''
  }

  /** 跨页签事件：已固定的检查点在其他页签发生资料变动时需要重新核对。 */
  function watchExternalChanges(onStale: (kind: string, sheetId?: string) => void): () => void {
    return subscribeCatalogChanges((message) => {
      const record = currentRecord.value
      if (!record) {
        return
      }
      // 本图幅的资料变动直接作废检查点；任何撤编/撤销事件都可能
      // 牵动邻接表，统一要求重新核对，提交时还有指纹兜底。
      if (message.kind !== 'material-changed' || message.sheetId === record.sheetId) {
        onStale(message.kind, message.sheetId)
      }
    })
  }

  return {
    currentRecord,
    busy,
    lastError,
    pin,
    reverify,
    commit,
    restoreFromSnapshot,
    recoverFromCheckpoint,
    cancelPin,
    loadForSheet,
    listAll,
    clearCurrent,
    watchExternalChanges,
  }
})

function toSnapshot(material: WithdrawalMaterial, pinnedAt: string): WithdrawalSnapshot {
  return {
    sheet: plain(material.sheet),
    scans: plain(material.scans),
    placePairs: plain(material.placePairs),
    histories: plain(material.histories),
    affectedNeighbors: plain(material.affectedNeighbors),
    pinnedAt,
  }
}

async function markCheckpointError(sheetId: string, message: string): Promise<void> {
  try {
    const record = await db.withdrawals.where('sheetId').equals(sheetId).first()
    if (record && record.stage === 'pinned') {
      await db.withdrawals.update(record.id, {
        lastError: message,
        updatedAt: new Date().toISOString(),
      })
    }
  } catch {
    // 记录失败原因失败时不再抛出，保留原始提交错误。
  }
}
