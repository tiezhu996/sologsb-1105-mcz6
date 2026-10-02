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
export const SHEET_STATUSES: SheetStatus[] = ['待编', '已编', '待核', '已撤编']

/** 撤编只能走详情页的固定快照流程，不允许在新建/编辑时直接选择 */
export const ACTIVE_SHEET_STATUSES: SheetStatus[] = ['待编', '已编', '待核']

export const RETIRED_STATUS = '已撤编' as const
