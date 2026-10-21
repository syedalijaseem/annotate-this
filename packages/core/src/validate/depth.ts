/**
 * Nesting depth of any value, counting only objects and arrays. Iterative so a
 * hostile value cannot overflow the call stack, and it stops as soon as the
 * depth passes `limit` (which also makes cyclic input terminate).
 */
export function nestingDepth(value: unknown, limit: number): number {
  let deepest = 0
  const stack: [unknown, number][] = [[value, 1]]
  while (stack.length > 0) {
    const [current, depth] = stack.pop() as [unknown, number]
    if (typeof current !== "object" || current === null) continue
    if (depth > deepest) deepest = depth
    if (deepest > limit) return deepest
    for (const child of Array.isArray(current) ? current : Object.values(current))
      stack.push([child, depth + 1])
  }
  return deepest
}
