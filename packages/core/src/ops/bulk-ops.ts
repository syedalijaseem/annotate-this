import { AnnotateError } from "../errors.js"
import type { ID, Region } from "../types.js"
import { clip } from "../validate/issues.js"
import { findCycles } from "../validate/references.js"
import { assertRegionRules } from "./check.js"
import type { InverseOp, OpContext } from "./context.js"
import { assertUsableId, needRegion, needSource, storeRegion } from "./entities.js"
import { placeAll } from "./order.js"
import { assertRoom, parseNewRegion } from "./region-ops.js"
import { removeRegions } from "./region-tree.js"
import type { CreateRegionsOp, DeleteRegionsOp, Position } from "./types.js"

// Parses every payload; ids must be new, also within the list.
function parseAll(ctx: OpContext, payloads: readonly unknown[]): Region[] {
  // Local working set, filled in place.
  const ids = new Set<ID>()
  return payloads.map((payload) => {
    const region = parseNewRegion(ctx, payload, false)
    assertUsableId(ctx, region.id)
    if (ids.has(region.id)) {
      throw new AnnotateError("DUPLICATE_ID", `Id "${clip(region.id)}" is listed twice`)
    }
    ids.add(region.id)
    needSource(ctx, region.sourceId)
    return region
  })
}

// New regions can only form a loop among themselves: nothing else can name them yet.
function assertNoLoops(ctx: OpContext, regions: readonly Region[]): void {
  ctx.charge(regions.length)
  const listed = new Set(regions.map((r) => r.id))
  const parents = new Map<ID, ID>()
  for (const { id, parentId } of regions) {
    if (parentId !== undefined && listed.has(parentId)) parents.set(id, parentId)
  }
  if (findCycles(parents).length > 0) {
    throw new AnnotateError("CYCLE", "Parent links must not form a loop")
  }
}

// Inserts the new ids into each source's order, one linear pass per source.
function place(ctx: OpContext, regions: readonly Region[], positions?: readonly Position[]) {
  const bySource = new Map<ID, { id: ID; position: Position }[]>()
  for (const [k, { id, sourceId }] of regions.entries()) {
    const entry = { id, position: positions?.[k] ?? "top" }
    const entries = bySource.get(sourceId)
    if (entries) entries.push(entry)
    else bySource.set(sourceId, [entry])
  }
  for (const [sourceId, entries] of bySource) {
    const current = needSource(ctx, sourceId).regionOrder
    ctx.draft.setRegionOrder(sourceId, placeAll(ctx.charge, current, entries))
  }
}

export function createRegions(ctx: OpContext, op: CreateRegionsOp): InverseOp[] {
  if (op.positions && op.positions.length !== op.regions.length) {
    throw new AnnotateError("INVALID_DOCUMENT", "createRegions: one position per region")
  }
  assertRoom(ctx, op.regions.length)
  const regions = parseAll(ctx, op.regions)
  assertNoLoops(ctx, regions)
  // Stored first so that parents listed later resolve; any failure discards the batch.
  for (const region of regions) storeRegion(ctx, region)
  for (const region of regions) assertRegionRules(ctx, region)
  place(ctx, regions, op.positions)
  const regionIds = regions.map((r) => r.id).reverse()
  return [{ type: "deleteRegions", regionIds, children: "detach" }]
}

export function deleteRegions(ctx: OpContext, op: DeleteRegionsOp): InverseOp[] {
  // Local working set, filled in place.
  const seen = new Set<ID>()
  for (const id of op.regionIds) {
    if (seen.has(id)) {
      throw new AnnotateError("INVALID_DOCUMENT", `Region "${clip(id)}" is listed twice`)
    }
    seen.add(id)
    needRegion(ctx, id)
  }
  return removeRegions(ctx, op.regionIds, op.children)
}
