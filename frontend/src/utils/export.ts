import type { NameHistory } from '../types/history'
import type { PlacePair } from '../types/placePair'
import type { ScanItem } from '../types/scan'
import type { Sheet } from '../types/sheet'
import type { WithdrawalRecord } from '../types/withdrawal'

export function downloadJson(fileName: string, payload: unknown): void {
  const content = JSON.stringify(payload, null, 2) ?? ''
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' })
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = fileName
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
}

export interface CatalogExportInput {
  sheets: Sheet[]
  scans: ScanItem[]
  placePairs: PlacePair[]
  histories: NameHistory[]
  /** 已撤编图幅的撤编记录，仅在显式包含撤编图幅时输出。 */
  withdrawals?: WithdrawalRecord[]
}

/**
 * 编目台整库导出：默认不导出已撤编图幅及其资料；
 * 勾选包含撤编图幅时，撤编状态与快照一并入档，便于离线审计。
 */
export function buildCatalogExport(input: CatalogExportInput, includeWithdrawn = false): Record<string, unknown> {
  const withdrawnIds = new Set(
    input.sheets.filter((sheet) => sheet.status === '已撤编').map((sheet) => sheet.id),
  )
  const visibleSheets = input.sheets.filter(
    (sheet) => includeWithdrawn || sheet.status !== '已撤编',
  )
  const visibleSheetIds = new Set(visibleSheets.map((sheet) => sheet.id))

  return {
    exportedAt: new Date().toISOString(),
    includeWithdrawn,
    summary: {
      sheets: visibleSheets.length,
      withdrawn: withdrawnIds.size,
      scans: input.scans.filter((scan) => visibleSheetIds.has(scan.sheetId)).length,
      placePairs: input.placePairs.filter((pair) => visibleSheetIds.has(pair.sheetId)).length,
    },
    sheets: visibleSheets,
    scans: input.scans.filter((scan) => visibleSheetIds.has(scan.sheetId)),
    placePairs: input.placePairs.filter((pair) => visibleSheetIds.has(pair.sheetId)),
    histories: input.histories.filter((history) => {
      const pair = input.placePairs.find((item) => item.id === history.placePairId)
      return pair ? visibleSheetIds.has(pair.sheetId) : false
    }),
    ...(includeWithdrawn ? { withdrawals: input.withdrawals ?? [] } : {}),
  }
}
