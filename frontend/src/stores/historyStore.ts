import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { NameHistory } from '../types/history'
import { createId, db, plain } from '../utils/db'
import { sortByPeriod } from '../utils/scale'
import { publishChange, subscribeCatalogChanges } from '../utils/crossTab'

export type NewNameHistory = Omit<NameHistory, 'id'>

export const useHistoryStore = defineStore('history', () => {
  const histories = ref<NameHistory[]>([])
  const currentPairId = ref('')
  const initialized = ref(false)
  let initialization: Promise<void> | null = null

  const currentHistories = computed(() =>
    sortByPeriod(
      histories.value.filter((history) => history.placePairId === currentPairId.value),
    ),
  )

  async function init(): Promise<void> {
    if (initialized.value) {
      return
    }
    if (!initialization) {
      initialization = db.histories.toArray().then((rows) => {
        histories.value = rows
        initialized.value = true
      })
    }
    await initialization
  }

  async function loadFor(placePairId: string): Promise<void> {
    await init()
    currentPairId.value = placePairId
  }

  async function addHistory(input: NewNameHistory): Promise<NameHistory> {
    await init()
    const history: NameHistory = { ...input, id: createId('history') }
    await db.histories.add(plain(history))
    histories.value = [...histories.value, history]
    currentPairId.value = history.placePairId
    const pair = await db.placePairs.get(history.placePairId)
    if (pair) {
      publishChange('material-changed', pair.sheetId)
    }
    return history
  }

  function getForPair(placePairId: string): NameHistory[] {
    return sortByPeriod(histories.value.filter((history) => history.placePairId === placePairId))
  }

  /** 跨页签撤编或沿革变动后与 IndexedDB 重新对齐。 */
  async function resync(): Promise<void> {
    await init()
    histories.value = await db.histories.toArray()
  }

  let resyncTimer: ReturnType<typeof setTimeout> | null = null
  subscribeCatalogChanges(() => {
    if (resyncTimer) {
      clearTimeout(resyncTimer)
    }
    resyncTimer = setTimeout(() => {
      void resync()
    }, 120)
  })

  return {
    histories,
    currentPairId,
    currentHistories,
    initialized,
    init,
    loadFor,
    addHistory,
    resync,
    getForPair,
  }
})
