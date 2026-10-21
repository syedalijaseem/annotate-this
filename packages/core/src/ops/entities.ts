import { AnnotateError } from "../errors.js"
import type { AnnotationBase, ID, Region, Source } from "../types.js"
import { clip } from "../validate/issues.js"
import { geometryWeight } from "../validate/limit-checks.js"
import type { InverseOp, OpContext } from "./context.js"
import { findOrdered, moveEntry, moveIndex, positionAt } from "./order.js"
import type { Position } from "./types.js"

export const notFound = (what: string, id: ID): AnnotateError =>
  new AnnotateError("NOT_FOUND", `${what} "${clip(String(id))}" does not exist`)

export function needRegion(ctx: OpContext, id: ID): Region {
  const region = ctx.draft.region(id)
  if (!region) throw notFound("Region", id)
  return region
}

export function needSource(ctx: OpContext, id: ID): Source {
  const source = ctx.draft.source(id)
  if (!source) throw notFound("Source", id)
  return source
}

// One rev bump and an updatedAt stamp, as every changed annotation gets.
export const touched = <T extends AnnotationBase>(entity: T, at: string): T => ({
  ...entity,
  rev: entity.rev + 1,
  provenance: { ...entity.provenance, updatedAt: at },
})

// Stores an already validated region, enforcing the document-wide vertex limit.
export function storeRegion(ctx: OpContext, region: Region): void {
  const { draft, limits } = ctx
  const previous = draft.region(region.id)
  const added = geometryWeight(region.geometry) - (previous ? geometryWeight(previous.geometry) : 0)
  if (added > 0 && draft.totalVertices() + added > limits.maxTotalVertices) {
    throw new AnnotateError(
      "LIMIT_EXCEEDED",
      `More than ${limits.maxTotalVertices} vertices in the document`,
    )
  }
  draft.putRegion(region)
}

// Moves a region within its own source's z-order (reorderRegion semantics).
export function reorder(ctx: OpContext, region: Region, position: Position): InverseOp[] {
  const { draft } = ctx
  const source = needSource(ctx, region.sourceId)
  const from = findOrdered(ctx.charge, source.regionOrder, region.id)
  const to = moveIndex(ctx.charge, source.regionOrder, from, position)
  if (to === from) return []
  const restore = positionAt(source.regionOrder, from)
  moveEntry(ctx.charge, draft.regionOrder(source.id), from, to)
  return [{ type: "reorderRegion", regionId: region.id, position: restore }]
}
