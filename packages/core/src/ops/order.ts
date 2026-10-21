import { AnnotateError } from "../errors.js"
import type { ID } from "../types.js"
import { clip } from "../validate/issues.js"
import type { Charge } from "./draft.js"
import type { Position } from "./types.js"

// Work units (Limits.maxBatchWork): a scan costs one unit per entry compared
// (ids are compared by content), a splice one unit per 32 entries shifted.
const SHIFTS_PER_UNIT_LOG2 = 5

const missingAnchor = (id: ID): AnnotateError =>
  new AnnotateError("NOT_FOUND", `Region "${clip(id)}" does not exist`)

const selfAnchor = (): AnnotateError =>
  new AnnotateError("INVALID_DOCUMENT", "A region cannot be placed after itself")

const notOrdered = (id: ID): AnnotateError =>
  new AnnotateError("INVALID_DOCUMENT", `Region "${clip(id)}" is not in its source's order`)

// Index of `id` in `order`, or -1; charged by how far the scan went. The top entry is checked first.
export function find(charge: Charge, order: readonly ID[], id: ID): number {
  const last = order.length - 1
  if (last >= 0 && order[last] === id) {
    charge(1)
    return last
  }
  const index = order.indexOf(id)
  charge(index < 0 ? order.length + 1 : index + 1)
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
