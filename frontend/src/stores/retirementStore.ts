import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { RetirementSnapshot } from '../types/retirement'
import type { RetirementRecord } from '../types/retirement'
import { announceEdit } from '../utils/broadcast'
import { db } from '../utils/db'
import { ensureCheckpointRecovery } from '../utils/recoveryGate'
import {
  commitRetirement,
  recoverCheckpoint,
  undoRetirement,
} from '../utils/retirementService'
import { useSheetStore } from './sheetStore'

export const useRetirementStore = defineStore('retirement', () => {
  /** 仅保存已完成的撤编登记；检查点不长期驻留内存 */
  const records = ref<RetirementRecord[]>([])
  const initialized = ref(false)
  let initialization: Promise<void> | null = null

  async function init(): Promise<void> {
    if (initialized.value) {
      return
    }
    if (!initialization) {
      // 先等启动检查点回收完成，避免把将被恢复的遗留检查点读成当前撤编登记
      initialization = ensureCheckpointRecovery()
        .then(() => db.retirements.where('state').equals('done').toArray())
        .then((rows) => {
          records.value = rows
          initialized.value = true
        })
    }
    await initialization
  }

  function getRetirement(sheetId: string): RetirementRecord | undefined {
    return records.value.find((record) => record.sheetId === sheetId)
  }

  async function commit(
    sheetId: string,
    reason: string,
    fixed: {
      snapshot: RetirementSnapshot
      fingerprint: string
      affectedNeighbors: RetirementRecord['affectedNeighbors']
    },
  ): Promise<RetirementRecord> {
    const record = await commitRetirement(sheetId, reason, fixed)
    records.value = [...records.value, record]
    const sheetStore = useSheetStore()
    await sheetStore.reload()
    // 通知其他页签：本图幅及受影响邻接图的邻接关系已变
    announceEdit(
      'sheet',
      [sheetId],
      record.affectedNeighbors.map((neighbor) => neighbor.sheetId),
    )
    return record
  }

  async function undo(sheetId: string): Promise<RetirementSnapshot> {
    const record = getRetirement(sheetId)
    const snapshot = await undoRetirement(sheetId)
    records.value = records.value.filter((item) => item.sheetId !== sheetId)
    const sheetStore = useSheetStore()
    await sheetStore.reload()
    if (record) {
      announceEdit(
        'sheet',
        [sheetId],
        record.affectedNeighbors.map((neighbor) => neighbor.sheetId),
      )
    }
    return snapshot
  }

  async function recover(checkpointId: string) {
    const result = await recoverCheckpoint(checkpointId)
    if (result) {
      await useSheetStore().reload()
    }
    return result
  }

  return {
    records,
    initialized,
    init,
    getRetirement,
    commit,
    undo,
    recover,
  }
})
