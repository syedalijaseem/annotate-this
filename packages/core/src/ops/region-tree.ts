import { AnnotateError } from "../errors.js"
import type { ID, Region } from "../types.js"
import { own } from "../validate/issues.js"
import { validateRegion } from "./check.js"
import { type InverseOp, type OpContext, checkBaseRev } from "./context.js"
import { needRegion, needSource, reorder, storeRegion, touched } from "./entities.js"
import {
  findOrdered,
  insertAt,
  insertionIndex,
  positionAt,
  removeAt,
  removeEntries,
} from "./order.js"
import type { ChildPolicy, DeleteRegionOp, MoveRegionToSourceOp } from "./types.js"
import { without } from "./util.js"

// Work units per parent-chain step: a lookup in the regions record, about
// 70 ns in a 20,000-region document and 270 ns in a 50,000-region one (cache misses).
const CHAIN_STEP_COST = 8

// Walks the parent chain from `parentId` (one `parentOf` lookup per step);
// reaching `id` means the new link would close a loop. An acyclic chain has
// at most `count` links, so the walk is bounded by the number of entities
// (regions and tracks by default; classes pass their own lookup and count)
// and charged per step.
export function assertNoCycle(
  ctx: OpContext,
  id: ID,
  parentId: ID,
  parentOf = (of: ID): ID | undefined => {
    const { regions, tracks } = ctx.draft.view
    return (own(regions, of) ?? own(tracks, of))?.parentId
  },
  count = ctx.draft.annotationCount,
): void {
  let current: ID | undefined = parentId
  for (let steps = 0; current !== undefined; steps++) {
    // Longer than the entity count: the chain already loops above `id`.
    if (current === id || steps > count) {
      throw new AnnotateError("CYCLE", "Parent links must not form a loop")
    }
    ctx.charge(CHAIN_STEP_COST)
    current = parentOf(current)
  }
}

// The roots and everything below them, parents before children, each once. Iterative: chains can be very deep.
function subtrees(ctx: OpContext, roots: readonly ID[]): ID[] {
  const { draft } = ctx
  const ordered: ID[] = []
  // Local working set, filled in place.
  const seen = new Set<ID>()
  const stack = [...roots].reverse()
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    if (seen.has(current)) continue
    seen.add(current)
    ordered.push(current)
    for (const child of draft.childrenOf(current)) stack.push(child)
  }
  ctx.charge(ordered.length)
  return ordered
}

// Clears the parent of each child; returns the patches that restore them.
function detachAll(ctx: OpContext, children: readonly [ID, ID][]): InverseOp[] {
  return children.map(([childId, parentId]): InverseOp => {
    const child = needRegion(ctx, childId)
    storeRegion(ctx, touched(without(child, "parentId") as Region, ctx.at))
    return { type: "patchRegion", regionId: childId, patch: { parentId } }
  })
}

// Children of the doomed regions that survive, with their parent.
function survivingChildren(ctx: OpContext, doomed: readonly ID[]): [ID, ID][] {
  const doomedSet = new Set(doomed)
  return doomed.flatMap((parentId) =>
    ctx.draft
      .childrenOf(parentId)
      .filter((childId) => !doomedSet.has(childId))
      .map((childId): [ID, ID] => [childId, parentId]),
  )
}

// The doomed regions grouped by source, in doomed order.
function bySource(ctx: OpContext, doomed: readonly ID[]): Map<ID, Region[]> {
  const groups = new Map<ID, Region[]>()
  for (const id of doomed) {
    const region = needRegion(ctx, id)
    const group = groups.get(region.sourceId)
    if (group) group.push(region)
    else groups.set(region.sourceId, [region])
  }
  return groups
}

// Every region of a source goes: restoring them bottom to top needs no positions,
// which keeps the undo payload no larger than what it restores.
function emptySource(ctx: OpContext, order: ID[], group: readonly Region[]): InverseOp {
  ctx.charge(order.length)
  const regions = order.map((id): Region => {
    const region = needRegion(ctx, id)
    return { ...region, rev: region.rev + 1 }
  })
  // Safe in place: regionOrder() returned the draft's own copy.
  order.length = 0
  for (const region of group) ctx.draft.removeRegion(region.id)
  return { type: "createRegions", regions }
}

// Removes one source's doomed regions; returns the step that re-creates them in place.
function removeFromSource(
  ctx: OpContext,
  sourceId: ID,
  group: readonly Region[],
  single: boolean,
): InverseOp {
  const { draft } = ctx
  const order = draft.regionOrder(sourceId)
  if (!single && group.length === order.length) return emptySource(ctx, order, group)
  // Undoing re-inserts in reverse removal order, so remove the last-listed first.
  const removal = [...group].reverse()
  const positions = removeEntries(
    ctx.charge,
    order,
    removal.map((r) => r.id),
  )
  for (const region of removal) draft.removeRegion(region.id)
  const restored = group.map((region): Region => ({ ...region, rev: region.rev + 1 }))
  const places = [...positions].reverse()
  const [first] = restored
  if (single && first) return { type: "createRegion", region: first, position: places[0] ?? "top" }
  return { type: "createRegions", regions: restored, positions: places }
}

// deleteRegion and deleteRegions: deletes `roots` (and under "delete" their
// subtrees; under "detach" their other children lose the parent link).
// Undone by one createRegion(s) per source, then the parent patches.
export function removeRegions(
  ctx: OpContext,
  roots: readonly ID[],
  policy: ChildPolicy,
): InverseOp[] {
  const { draft } = ctx
  const doomed = policy === "delete" ? subtrees(ctx, roots) : [...roots]
  const children = policy === "detach" ? survivingChildren(ctx, doomed) : []
  if (doomed.some((id) => !draft.region(id)) || children.some(([id]) => !draft.region(id))) {
    throw new AnnotateError("IN_USE", "Tracks as children are not supported yet")
  }
  const patches = detachAll(ctx, children)
  const creations: InverseOp[] = []
  for (const [sourceId, group] of bySource(ctx, doomed)) {
    creations.push(removeFromSource(ctx, sourceId, group, doomed.length === 1))
  }
  return [...creations, ...patches.reverse()]
}

export function deleteRegion(ctx: OpContext, op: DeleteRegionOp): InverseOp[] {
  const region = needRegion(ctx, op.regionId)
  checkBaseRev(ctx, op, region.rev)
  return removeRegions(ctx, [op.regionId], op.children)
}

export function moveRegionToSource(ctx: OpContext, op: MoveRegionToSourceOp): InverseOp[] {
  const { draft } = ctx
  const region = needRegion(ctx, op.regionId)
  const target = needSource(ctx, op.sourceId)
  checkBaseRev(ctx, op, region.rev)
  // Within one source a move is exactly a reorder: parent, frame and region rev stay.
  if (region.sourceId === target.id) return reorder(ctx, region, op.position ?? "top")
  const from = needSource(ctx, region.sourceId)
  if (draft.childrenOf(op.regionId).length > 0) {
    throw new AnnotateError("IN_USE", "Children would end up in a different source")
  }
  if (from.kind !== target.kind) {
    throw new AnnotateError(
      "INVALID_DOCUMENT",
      "Regions move between sources of the same kind only",
    )
  }
  const index = insertionIndex(ctx.charge, target.regionOrder, op.regionId, op.position ?? "top")
  const fromIndex = findOrdered(ctx.charge, from.regionOrder, op.regionId)
  const restore = positionAt(from.regionOrder, fromIndex)
  const { parentId } = region
  const moved = touched({ ...without(region, "parentId"), sourceId: target.id } as Region, ctx.at)
  storeRegion(ctx, validateRegion(ctx, moved))
  removeAt(ctx.charge, draft.regionOrder(from.id), fromIndex)
  insertAt(ctx.charge, draft.regionOrder(target.id), index, op.regionId)
  const inverse: InverseOp[] = [
    { type: "moveRegionToSource", regionId: op.regionId, sourceId: from.id, position: restore },
  ]
  if (parentId !== undefined) {
    inverse.push({ type: "patchRegion", regionId: op.regionId, patch: { parentId } })
  }
  return inverse
}
