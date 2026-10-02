/**
 * 撤编资料指纹工具。
 *
 * IndexedDB 没有行版本号，两个页签可能同时修改同一图幅的资料。
 * 打开撤编确认页时对扫描件、地名对照、沿革与邻接表计算指纹，
 * 提交前重算比对；指纹不一致即说明固定后被（另一页签）改动过，
 * 必须重新核对后才能撤编。
 */

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** 对任意记录集合做按 id 排序后的稳定序列化。 */
export function stableRecordHash(records: ReadonlyArray<{ id: string }>): string {
  const ordered = [...records].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  return fnv1a(stableStringify(ordered))
}

/** 对不含 id 的结构（邻接表等）做稳定哈希。 */
export function stableValueHash(value: unknown): string {
  return fnv1a(stableStringify(value))
}

/** FNV-1a 32 位，输出 8 位十六进制；纯同步、无需依赖 crypto.subtle。 */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
