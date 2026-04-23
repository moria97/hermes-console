/**
 * Sort model IDs in a UI-friendly order:
 *
 *   1. qwen-prefixed models (`qwen`, `qwen3-plus`, `qwen3.6-plus`, …) go
 *      together as the FIRST group. This is our primary provider so we
 *      want them at the top regardless of alphabetical order.
 *   2. Every other id is grouped by its first hyphen-separated segment
 *      (e.g. `deepseek-v3` and `deepseek-r1` share group `deepseek`;
 *      `wan-3` and `wan-vl-max` share group `wan`).
 *   3. Groups are ordered: qwen first, then remaining groups alphabetically
 *      by group key (case-insensitive).
 *   4. Within each group, members sort descending by name so newer / higher
 *      version numbers come first (qwen3.6-plus > qwen3-plus > qwen-plus).
 */
export function sortModels(ids: readonly string[]): string[] {
  const groupKey = (id: string): string => {
    const first = id.split('-')[0].toLowerCase()
    return first.startsWith('qwen') ? 'qwen' : first
  }

  const groups = new Map<string, string[]>()
  for (const id of ids) {
    const k = groupKey(id)
    const arr = groups.get(k)
    if (arr) arr.push(id)
    else groups.set(k, [id])
  }

  for (const arr of groups.values()) {
    arr.sort((a, b) => b.localeCompare(a))
  }

  const orderedKeys = [...groups.keys()].sort((a, b) => {
    if (a === 'qwen') return -1
    if (b === 'qwen') return 1
    return a.localeCompare(b)
  })

  return orderedKeys.flatMap((k) => groups.get(k)!)
}
