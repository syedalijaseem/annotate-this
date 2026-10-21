import { AnnotateError } from "../errors.js"
import type { ID, Region } from "../types.js"
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
import type { DeleteRegionOp, MoveRegionToSourceOp } from "./types.js"
import { without } from "./util.js"

// Longest parent chain a new parent link is checked against.
export const MAX_PARENT_CHAIN = 10_000

// Walks the parent chain from `parentId`; reaching `id` means the new link would close a loop.
export function assertNoCycle(ctx: OpContext, id: ID, parentId: ID): void {
  const { regions, tracks } = ctx.draft.view
  let current: ID | undefined = parentId
  for (let steps = 0; current !== undefined; steps++) {
    if (current === id) throw new AnnotateError("CYCLE", "Parent links must not form a loop")
    if (steps >= MAX_PARENT_CHAIN) {
      throw new AnnotateError("LIMIT_EXCEEDED", `Parent chain is longer than ${MAX_PARENT_CHAIN}`)
    }
    ctx.charge(1)
    current = Object.hasOwn(regions, current)
      ? regions[current]?.parentId
      : Object.hasOwn(tracks, current)
        ? tracks[current]?.parentId
        : undefined
  }
}

// `id` and everything below it, parents before children. Iterative: chains can be very deep.
function subtree(ctx: OpContext, id: ID): ID[] {
  const { draft } = ctx
  const ordered: ID[] = []
  const stack = [id]
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    ordered.push(current)
    if (ordered.length > draft.annotationCount) {
      throw new AnnotateError("CYCLE", "Parent links must not form a loop")
    }
    for (const child of draft.childrenOf(current)) stack.push(child)
  }
  ctx.charge(ordered.length)
  return ordered
}

function detachChildren(ctx: OpContext, id: ID): InverseOp[] {
  const steps: InverseOp[] = []
  for (const childId of ctx.draft.childrenOf(id)) {
    const child = needRegion(ctx, childId)
    storeRegion(ctx, touched(without(child, "parentId") as Region, ctx.at))
    steps.push({ type: "patchRegion", regionId: childId, patch: { parentId: id } })
  }
  return steps
}

export function deleteRegion(ctx: OpContext, op: DeleteRegionOp): InverseOp[] {
  const { draft } = ctx
  const region = needRegion(ctx, op.regionId)
  checkBaseRev(ctx, op, region.rev)
  const doomed = op.children === "delete" ? subtree(ctx, op.regionId) : [op.regionId]
  const affected = op.children === "delete" ? doomed : [...doomed, ...draft.childrenOf(op.regionId)]
  if (affected.some((id) => !draft.region(id))) {
    throw new AnnotateError("IN_USE", "Tracks as children are not supported yet")
  }
  const steps = op.children === "detach" ? detachChildren(ctx, op.regionId) : []
  // Children go first, so undoing (in reverse) restores parents before children.
  const removal = [...doomed].reverse()
  const positions = removeEntries(ctx.charge, draft.regionOrder(region.sourceId), removal)
  for (const [k, id] of removal.entries()) {
    const current = needRegion(ctx, id)
    steps.push({
      type: "createRegion",
      region: { ...current, rev: current.rev + 1 },
      position: positions[k] ?? "top",
    })
    draft.removeRegion(id)
  }
  return steps.reverse()
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
