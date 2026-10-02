/**
 * 馆员常会在两个页签同时整理同一图幅。
 * 通过 BroadcastChannel 广播资料变更，撤编确认页据此判断固定快照是否已过期；
 * 提交前还会从数据库重算指纹做最终核对，广播只承担即时提示。
 */
export type EditKind = 'sheet' | 'scan' | 'placePair' | 'history'

export interface EditMessage {
  kind: EditKind
  /** 变更直接归属的图幅 id（沿革为其地名对照所属图幅） */
  sheetIds: string[]
  /** 邻接关系可能受影响的图幅 id（改动 neighborCodes 时双向图幅） */
  neighborSheetIds?: string[]
  at: string
}

const CHANNEL_NAME = 'gboldmap-edits'
const channel: BroadcastChannel | null =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL_NAME) : null

/**
 * 广播一次资料变更。retire/undo 事务本身不广播：
 * 确认页对这类状态变化以提交前指纹与重新打开页面为准。
 */
export function announceEdit(kind: EditKind, sheetIds: string[], neighborSheetIds: string[] = []): void {
  const targets = [...new Set([...sheetIds, ...neighborSheetIds])].filter(Boolean)
  if (!channel || targets.length === 0) {
    return
  }
  const message: EditMessage = {
    kind,
    sheetIds,
    neighborSheetIds,
    at: new Date().toISOString(),
  }
  channel.postMessage(message)
}

/**
 * 订阅其他页签发出的变更广播。
 * 返回退订函数，供组件在卸载时调用。
 */
export function onEditAnnounced(handler: (message: EditMessage) => void): () => void {
  if (!channel) {
    return () => undefined
  }
  const listener = (event: MessageEvent<EditMessage>) => {
    if (event.data) {
      handler(event.data)
    }
  }
  channel.addEventListener('message', listener)
  return () => channel.removeEventListener('message', listener)
}
