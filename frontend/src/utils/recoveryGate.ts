import { recoverAllCheckpoints } from './retirementService'

let recovery: Promise<void> | null = null

/**
 * 应用启动时的检查点回收只需执行一次。
 * main.ts 先触发，各业务 store 的 init 等待同一 Promise，
 * 避免恢复尚未完成就把半套撤编数据读进内存缓存。
 */
export function ensureCheckpointRecovery(): Promise<void> {
  if (!recovery) {
    recovery = recoverAllCheckpoints().then(() => undefined)
  }
  return recovery
}
