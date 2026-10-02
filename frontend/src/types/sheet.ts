export type SheetScale = '1:5000' | '1:50000'
export type SheetStatus = '待编' | '已编' | '待核' | '已撤编'

export interface Sheet {
  id: string
  code: string
  title: string
  year: number
  scale: SheetScale
  projection: string
  sheetSizeCm: string
  series: string
  neighborCodes: string[]
  status: SheetStatus
}

export const SHEET_SCALES: SheetScale[] = ['1:5000', '1:50000']

/** 编目流程中可手工选择的状态，已撤编只能通过撤编流程写入。 */
export const SHEET_STATUSES: Exclude<SheetStatus, '已撤编'>[] = ['待编', '已编', '待核']

/** 编目台状态筛选用，已撤编默认不参与筛选。 */
export const SHEET_STATUS_ALL: SheetStatus[] = ['待编', '已编', '待核', '已撤编']

export function isWithdrawnStatus(status: SheetStatus): boolean {
  return status === '已撤编'
}
