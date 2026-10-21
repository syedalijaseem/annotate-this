import { safeParse } from "valibot"
import { AnnotateError } from "../errors.js"
import { GeometrySchema } from "../schema/geometry.js"
import type { AnnotationBase, ID, Region, Source } from "../types.js"
import { clip } from "../validate/issues.js"
import { assertRegionRules, parseRegion, validateRegion } from "./check.js"
import { type InverseOp, type OpContext, checkBaseRev } from "./context.js"
import { assertSafePatchKeys, applyAnnotationPatch } from "./patch.js"
import type {
  CreateRegionOp,
  DeleteRegionOp,
  MoveRegionToSourceOp,
  PatchRegionOp,
  Position,
  ReorderRegionOp,
  SetGeometryOp,
} from "./types.js"
import { deepEqual, place, positionOf, sameOrder, without } from "./util.js"

const notFound = (what: string, id: ID): AnnotateError =>
  new AnnotateError("NOT_FOUND", `${what} "${clip(String(id))}" does not exist`)

function needRegion(ctx: OpContext, id: ID): Region {
  const region = ctx.draft.region(id)
  if (!region) throw notFound("Region", id)
  return region
}

function needSource(ctx: OpContext, id: ID): Source {
  const source = ctx.draft.source(id)
  if (!source) throw notFound("Source", id)
  return source
}

/** One rev bump and an updatedAt stamp, as every changed annotation gets. */
const touched = <T extends AnnotationBase>(entity: T, at: string): T => ({
  ...entity,
  rev: entity.rev + 1,
  provenance: { ...entity.provenance, updatedAt: at },
})

function orderAfter(order: readonly ID[], id: ID, position: Position): ID[] {
  const placed = place(order, id, position)
  if (placed.ok) return placed.order
  if (placed.reason === "self-anchor") {
    throw new AnnotateError("INVALID_DOCUMENT", "A region cannot be placed after itself")
  }
  throw notFound("Region", (position as { after: ID }).after)
}

function withOrder(ctx: OpContext, source: Source, regionOrder: ID[]): void {
  ctx.draft.putSource({ ...source, regionOrder, rev: source.rev + 1 })
}

/** Walks the parent chain from `parentId`; reaching `id` means the new link would close a loop. */
function assertNoCycle(ctx: OpContext, id: ID, parentId: ID): void {
  const { regions, tracks } = ctx.draft.view
  let current: ID | undefined = parentId
  for (let steps = 0; current !== undefined && steps <= ctx.draft.annotationCount; steps++) {
    if (current === id) throw new AnnotateError("CYCLE", "Parent links must not form a loop")
    current = Object.hasOwn(regions, current)
      ? regions[current]?.parentId
      : Object.hasOwn(tracks, current)
        ? tracks[current]?.parentId
        : undefined
  }
}

export function createRegion(ctx: OpContext, op: CreateRegionOp): InverseOp[] {
  const { draft } = ctx
  const candidate = { ...op.region, rev: op.region.rev ?? 0 }
  const region = parseRegion({
    ...candidate,
    provenance: { ...candidate.provenance, updatedAt: ctx.at },
  })
  if (draft.idInUse(region.id)) {
    throw new AnnotateError("DUPLICATE_ID", `Id "${clip(region.id)}" is already used`)
  }
  const source = needSource(ctx, region.sourceId)
  if (draft.annotationCount + 1 > ctx.limits.maxAnnotations) {
    throw new AnnotateError("LIMIT_EXCEEDED", `More than ${ctx.limits.maxAnnotations} annotations`)
  }
  const order = orderAfter(source.regionOrder, region.id, op.position ?? "top")
  assertRegionRules(draft.view, region, ctx.limits)
  draft.putRegion(region)
  withOrder(ctx, source, order)
  return [{ type: "deleteRegion", regionId: region.id, children: "detach" }]
}

export function setGeometry(ctx: OpContext, op: SetGeometryOp): InverseOp[] {
  const region = needRegion(ctx, op.regionId)
  checkBaseRev(ctx, op, region.rev)
  const parsed = safeParse(GeometrySchema, op.geometry, { abortEarly: true })
  if (!parsed.success) {
    throw new AnnotateError(
      "INVALID_GEOMETRY",
      `geometry: ${clip(parsed.issues[0]?.message ?? "")}`,
    )
  }
  if (deepEqual(parsed.output, region.geometry)) return []
  const next = validateRegion(
    ctx.draft.view,
    touched({ ...region, geometry: parsed.output }, ctx.at),
    ctx.limits,
  )
  ctx.draft.putRegion(next)
  return [{ type: "setGeometry", regionId: op.regionId, geometry: region.geometry }]
}

export function patchRegion(ctx: OpContext, op: PatchRegionOp): InverseOp[] {
  const region = needRegion(ctx, op.regionId)
  checkBaseRev(ctx, op, region.rev)
  assertSafePatchKeys(op.patch)
  const result = applyAnnotationPatch(region, op.patch)
  if (!result) return []
  if (typeof op.patch.parentId === "string") assertNoCycle(ctx, op.regionId, op.patch.parentId)
  ctx.draft.putRegion(validateRegion(ctx.draft.view, touched(result.next, ctx.at), ctx.limits))
  return [{ type: "patchRegion", regionId: op.regionId, patch: result.undo }]
}

/** The regions to delete for `id`, children before parents; tracks are not supported as children yet. */
function subtree(ctx: OpContext, id: ID): ID[] {
  const ordered: ID[] = []
  const visit = (current: ID): void => {
    for (const child of ctx.draft.childrenOf(current)) visit(child)
    ordered.push(current)
  }
  visit(id)
  return ordered
}

export function deleteRegion(ctx: OpContext, op: DeleteRegionOp): InverseOp[] {
  const { draft } = ctx
  const region = needRegion(ctx, op.regionId)
  checkBaseRev(ctx, op, region.rev)
  const doomed = op.children === "delete" ? subtree(ctx, op.regionId) : [op.regionId]
  const affected =
    op.children === "delete" ? doomed : [op.regionId, ...draft.childrenOf(op.regionId)]
  if (affected.some((id) => !draft.region(id))) {
    throw new AnnotateError("IN_USE", "Tracks as children are not supported yet")
  }
  const steps: InverseOp[] = []
  if (op.children === "detach") {
    for (const childId of draft.childrenOf(op.regionId)) {
      const child = needRegion(ctx, childId)
      draft.putRegion(touched(without(child, "parentId") as Region, ctx.at))
      steps.push({ type: "patchRegion", regionId: childId, patch: { parentId: op.regionId } })
    }
  }
  for (const id of doomed) {
    const current = needRegion(ctx, id)
    const source = needSource(ctx, current.sourceId)
    steps.push({
      type: "createRegion",
      region: { ...current, rev: current.rev + 1 },
      position: positionOf(source.regionOrder, id),
    })
    draft.removeRegion(id)
    withOrder(
      ctx,
      source,
      source.regionOrder.filter((entry) => entry !== id),
    )
  }
  return steps.reverse()
}

export function reorderRegion(ctx: OpContext, op: ReorderRegionOp): InverseOp[] {
  const region = needRegion(ctx, op.regionId)
  checkBaseRev(ctx, op, region.rev)
  const source = needSource(ctx, region.sourceId)
  const order = orderAfter(source.regionOrder, op.regionId, op.position)
  if (sameOrder(order, source.regionOrder)) return []
  withOrder(ctx, source, order)
  return [
    {
      type: "reorderRegion",
      regionId: op.regionId,
      position: positionOf(source.regionOrder, op.regionId),
    },
  ]
}

export function moveRegionToSource(ctx: OpContext, op: MoveRegionToSourceOp): InverseOp[] {
  const { draft } = ctx
  const region = needRegion(ctx, op.regionId)
  const target = needSource(ctx, op.sourceId)
  checkBaseRev(ctx, op, region.rev)
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
  const sameSource = from.id === target.id
  const targetOrder = orderAfter(
    sameSource ? from.regionOrder : target.regionOrder,
    op.regionId,
    op.position ?? "top",
  )
  const { parentId } = region
  if (sameSource && parentId === undefined && sameOrder(targetOrder, from.regionOrder)) return []

  const next = validateRegion(
    draft.view,
    touched({ ...without(region, "parentId"), sourceId: target.id } as Region, ctx.at),
    ctx.limits,
  )
  draft.putRegion(next)
  if (sameSource) {
    withOrder(ctx, from, targetOrder)
  } else {
    withOrder(
      ctx,
      from,
      from.regionOrder.filter((entry) => entry !== op.regionId),
    )
    withOrder(ctx, target, targetOrder)
  }
  const inverse: InverseOp[] = [
    {
      type: "moveRegionToSource",
      regionId: op.regionId,
      sourceId: from.id,
      position: positionOf(from.regionOrder, op.regionId),
    },
  ]
  if (parentId !== undefined)
    inverse.push({ type: "patchRegion", regionId: op.regionId, patch: { parentId } })
  return inverse
}
