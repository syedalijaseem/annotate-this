import { AnnotateError } from "../errors.js"
import type { ID } from "../types.js"
import { clip } from "../validate/issues.js"
import type { Charge } from "./charge.js"
import type { Position } from "./types.js"

// Work units (see Limits.maxBatchWork): a native indexOf scan costs one unit
// per 8 entries compared (about 2.5 ns per entry, 5 ns for long ids that are
// not interned), a splice one unit per 128 entries shifted (a memory move).
const SCANS_PER_UNIT_LOG2 = 3
const SHIFTS_PER_UNIT_LOG2 = 7

// Orders hold region, source, class or tag ids; messages name the entry, not its kind.
const missingAnchor = (id: ID): AnnotateError =>
  new AnnotateError("NOT_FOUND", `Anchor "${clip(id)}" is not in this order`)

const selfAnchor = (): AnnotateError =>
  new AnnotateError("INVALID_DOCUMENT", "An entry cannot be placed after itself")

const notOrdered = (id: ID): AnnotateError =>
  new AnnotateError("INVALID_DOCUMENT", `"${clip(id)}" is missing from its order`)

// Index of `id` in `order`, or -1; charged by how far the scan went. The top entry is checked first.
function find(charge: Charge, order: readonly ID[], id: ID): number {
  const last = order.length - 1
  if (last >= 0 && order[last] === id) {
    charge(1)
    return last
  }
  const index = order.indexOf(id)
  charge(1 + ((index < 0 ? order.length : index) >>> SCANS_PER_UNIT_LOG2))
  return index
}

// Index of an entry that must be present.
export function findOrdered(charge: Charge, order: readonly ID[], id: ID): number {
  const index = find(charge, order, id)
  if (index < 0) throw notOrdered(id)
  return index
}

export function insertAt(charge: Charge, order: ID[], index: number, id: ID): void {
  charge(1 + ((order.length - index) >>> SHIFTS_PER_UNIT_LOG2))
  if (index === order.length) order.push(id)
  else order.splice(index, 0, id)
}

export function removeAt(charge: Charge, order: ID[], index: number): void {
  charge(1 + ((order.length - index) >>> SHIFTS_PER_UNIT_LOG2))
  order.splice(index, 1)
}

// Position that puts the entry at `index` back where it is (bottom-to-top order).
export const positionAt = (order: readonly ID[], index: number): Position =>
  index > 0 ? { after: order[index - 1] as ID } : "bottom"

function anchorIndex(charge: Charge, order: readonly ID[], after: ID): number {
  const index = find(charge, order, after)
  if (index < 0) throw missingAnchor(after)
  return index
}

// Where `id` (not in `order`) goes for `position`, as an insertion index.
export function insertionIndex(
  charge: Charge,
  order: readonly ID[],
  id: ID,
  position: Position,
): number {
  if (position === "top") return order.length
  if (position === "bottom") return 0
  if (position.after === id) throw selfAnchor()
  return anchorIndex(charge, order, position.after) + 1
}

// Final index of the entry now at `from` once it is moved to `position`.
export function moveIndex(
  charge: Charge,
  order: readonly ID[],
  from: number,
  position: Position,
): number {
  if (position === "top") return order.length - 1
  if (position === "bottom") return 0
  if (position.after === order[from]) throw selfAnchor()
  const anchor = anchorIndex(charge, order, position.after)
  return (anchor > from ? anchor - 1 : anchor) + 1
}

// Moves the entry at `from` to `to` in place (`to` as computed by moveIndex).
export function moveEntry(charge: Charge, order: ID[], from: number, to: number): void {
  const id = order[from] as ID
  removeAt(charge, order, from)
  insertAt(charge, order, to, id)
}

// Removes `removed` from `order` in place and returns for each removed id (in
// the given order) the position that restores it when the removals are undone
// in reverse order: the nearest entry below it that was not removed before it.
// Several ids take one pass plus a near-linear union-find over slots.
export function removeEntries(charge: Charge, order: ID[], removed: readonly ID[]): Position[] {
  if (removed.length === 1) {
    const index = findOrdered(charge, order, removed[0] as ID)
    const restore = positionAt(order, index)
    removeAt(charge, order, index)
    return [restore]
  }
  charge(order.length + removed.length)
  const doomed = new Map<ID, number>(removed.map((id) => [id, -1]))
  for (const [index, id] of order.entries()) if (doomed.has(id)) doomed.set(id, index)
  // Slot k + 1 stands for order[k]; slot 0 is "bottom". A removed slot links to the one below it.
  const link = new Int32Array(order.length + 1).map((_, slot) => slot)
  const root = (start: number): number => {
    let slot = start
    while (link[slot] !== slot) {
      link[slot] = link[link[slot] as number] as number
      slot = link[slot] as number
    }
    return slot
  }
  const positions = removed.map((id): Position => {
    const index = doomed.get(id) ?? -1
    if (index < 0) throw notOrdered(id)
    const below = root(index)
    link[index + 1] = index
    return below === 0 ? "bottom" : { after: order[below - 1] as ID }
  })
  let write = 0
  for (const id of order) if (!doomed.has(id)) order[write++] = id
  order.length = write
  return positions
}

// Stands for "below every entry" in placeAll.
const BOTTOM = Symbol("bottom")
type Anchor = ID | typeof BOTTOM

// The order that inserting each entry (ids not in `order`) at its position,
// one after another, would produce: the same result as one insertionIndex +
// insertAt per entry, but linear. An entry placed after an anchor ends up
// directly above it, so the entries above one anchor read latest first, each
// followed by whatever was placed above it; one pre-order walk writes them out.
export function placeAll(
  charge: Charge,
  order: readonly ID[],
  entries: readonly { id: ID; position: Position }[],
): ID[] {
  charge(2 * order.length + 2 * entries.length)
  // Local working structures, filled in place: this is what keeps it linear.
  const known = new Set(order)
  const above = new Map<Anchor, ID[]>()
  let top: Anchor = order.length > 0 ? (order[order.length - 1] as ID) : BOTTOM
  for (const { id, position } of entries) {
    let anchor: Anchor = position === "top" ? top : BOTTOM
    if (typeof position === "object") {
      if (position.after === id) throw selfAnchor()
      if (!known.has(position.after)) throw missingAnchor(position.after)
      anchor = position.after
    }
    if (anchor === top) top = id
    const list = above.get(anchor)
    if (list) list.push(id)
    else above.set(anchor, [id])
    known.add(id)
  }
  const result: ID[] = []
  const emitAbove = (anchor: Anchor): void => {
    const stack = [...(above.get(anchor) ?? [])]
    for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
      result.push(id)
      for (const next of above.get(id) ?? []) stack.push(next)
    }
  }
  emitAbove(BOTTOM)
  for (const id of order) {
    result.push(id)
    emitAbove(id)
  }
  return result
}
