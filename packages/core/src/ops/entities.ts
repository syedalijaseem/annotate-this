import { AnnotateError } from "../errors.js"
import { isForbiddenKey } from "../schema/primitives.js"
import type { AnnotationBase, ID, Region, Source } from "../types.js"
import { RESERVED_ID } from "../validate/identity.js"
import { type Issue, clip, fail } from "../validate/issues.js"
import { geometryWeight } from "../validate/limit-checks.js"
import type { InverseOp, OpContext } from "./context.js"
import type { Def, DefKind, Draft, OrderKind } from "./draft.js"
import { findOrdered, moveEntry, moveIndex, positionAt } from "./order.js"
import type { Position } from "./types.js"

const notFound = (what: string, id: ID): AnnotateError =>
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

const DEF_NAMES: Record<DefKind, string> = {
  classes: "Class",
  tags: "Tag",
  attributes: "Attribute",
  skeletons: "Skeleton",
}

export function needDef<K extends DefKind>(ctx: OpContext, kind: K, key: string): Def<K> {
  const def = ctx.draft.def(kind, key)
  if (!def) throw notFound(DEF_NAMES[kind], key)
  return def
}

export const inUse = (message: string): AnnotateError => new AnnotateError("IN_USE", message)

// Throws the first issue's code (as parseDocument would) when there are any.
export function assertNone(issues: readonly Issue[]): void {
  if (issues.length > 0) fail(issues)
}

// Ids that collide with prototype names or with the change set's "config" entry.
export function assertUsableId(ctx: OpContext, id: ID): void {
  if (isForbiddenKey(id) || id === RESERVED_ID) {
    throw new AnnotateError("INVALID_DOCUMENT", `Id "${clip(id)}" is reserved`)
  }
  if (ctx.draft.idInUse(id)) {
    throw new AnnotateError("DUPLICATE_ID", `Id "${clip(id)}" is already used`)
  }
}

// Re-creating an id deleted earlier in this batch continues its rev (revs are never reused).
export function continuedRev<T extends { id: ID; rev: number }>(draft: Draft, entity: T): T {
  const deletedRev = draft.deletedRev(entity.id)
  return deletedRev === undefined || entity.rev > deletedRev
    ? entity
    : { ...entity, rev: deletedRev + 1 }
}

// Moves `id` within `order` to `position`. Returns the position that moves it
// back, or null when it is already there (a no-op). `writable` yields the
// draft-owned copy and is only called when something moves.
function moveWithin(
  ctx: OpContext,
  order: readonly ID[],
  id: ID,
  position: Position,
  writable: () => ID[],
): Position | null {
  const from = findOrdered(ctx.charge, order, id)
  const to = moveIndex(ctx.charge, order, from, position)
  if (to === from) return null
  const restore = positionAt(order, from)
  moveEntry(ctx.charge, writable(), from, to)
  return restore
}

// reorderSource / reorderClass / reorderTag: the order belongs to the document or the config.
export function reorderIn(ctx: OpContext, kind: OrderKind, id: ID, position: Position) {
  const order = kind === "sourceOrder" ? ctx.draft.view.sourceOrder : ctx.draft.view.config[kind]
  return moveWithin(ctx, order, id, position, () => ctx.draft.order(kind))
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
  const source = needSource(ctx, region.sourceId)
  const restore = moveWithin(ctx, source.regionOrder, region.id, position, () =>
    ctx.draft.regionOrder(source.id),
  )
  return restore ? [{ type: "reorderRegion", regionId: region.id, position: restore }] : []
}
