/**
 * 跨页签资料变动通知。
 *
 * 馆员常在两个页签同时整理同一图幅：撤编确认页固定资料后，
 * 另一个页签若改动了扫描件、地名对照、沿革或邻接关系，
 * 需要立刻通知确认页作废旧检查点、要求重新核对。
 * 优先使用 BroadcastChannel，旧浏览器回退到 localStorage storage 事件。
 */

export type CatalogChangeKind =
  | 'material-changed'
  | 'withdrawal-pinned'
  | 'withdrawal-committed'
  | 'withdrawal-restored'
  | 'withdrawal-cancelled'

export interface CatalogChangeMessage {
  kind: CatalogChangeKind
  /** 变动直接归属的图幅；撤编类事件也用于提示邻接关系可能受影响。 */
  sheetId?: string
  /** 发送页签标识，避免把自己发出的消息当作外部变动。 */
  tabId: string
  at: number
}

const CHANNEL_NAME = 'gboldmap-catalog-channel'
const STORAGE_KEY = 'gboldmap-catalog-signal'

export const tabId = generateTabId()

function generateTabId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID()
  }
  return `tab-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

type Listener = (message: CatalogChangeMessage) => void
const listeners = new Set<Listener>()

let channel: BroadcastChannel | null = null
let initialized = false

function initialize(): void {
  if (initialized) {
    return
  }
  initialized = true

  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL_NAME)
    channel.onmessage = (event: MessageEvent<CatalogChangeMessage>) => {
      if (event.data && event.data.tabId !== tabId) {
        dispatch(event.data)
      }
    }
  } else if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('storage', (event) => {
      if (event.key !== STORAGE_KEY || !event.newValue) {
        return
      }
      try {
        const message = JSON.parse(event.newValue) as CatalogChangeMessage
        if (message.tabId !== tabId) {
          dispatch(message)
        }
      } catch {
        // 其他页面写入的无关内容，忽略。
      }
    })
  }
}

function dispatch(message: CatalogChangeMessage): void {
  listeners.forEach((listener) => listener(message))
}

/** 广播一次资料变动；同页签不会收到自己的消息。 */
export function publishChange(kind: CatalogChangeKind, sheetId?: string): void {
  const message: CatalogChangeMessage = { kind, sheetId, tabId, at: Date.now() }
  initialize()
  if (channel) {
    channel.postMessage(message)
  } else if (typeof localStorage !== 'undefined') {
    // storage 事件只在其他页签触发，正好满足跨页签通知需求。
    localStorage.setItem(STORAGE_KEY, JSON.stringify(message))
  }
}

/** 订阅跨页签变动，返回取消订阅函数。 */
export function subscribeCatalogChanges(listener: Listener): () => void {
  initialize()
  listeners.add(listener)
  return () => listeners.delete(listener)
}
