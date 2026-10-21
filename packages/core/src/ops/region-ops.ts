import { safeParse } from "valibot"
import { AnnotateError } from "../errors.js"
import { GeometrySchema } from "../schema/geometry.js"
import { FORBIDDEN_KEYS } from "../schema/primitives.js"
import type { ID } from "../types.js"
import { clip } from "../validate/issues.js"
import {
  GEOMETRY_LEVEL,
  REGION_LEVEL,
  assertDepth,
  assertRegionRules,
  parseRegion,
  validateRegion,
} from "./check.js"
import { type InverseOp, type OpContext, checkBaseRev } from "./context.js"
import { needRegion, needSource, reorder, storeRegion, touched } from "./entities.js"
import { insertAt, insertionIndex } from "./order.js"
import { applyAnnotationPatch } from "./patch.js"
import type { CreateRegionOp, PatchRegionOp, ReorderRegionOp, SetGeometryOp } from "./types.js"
import { assertNoCycle } from "./region-tree.js"
import { deepEqual } from "./util.js"

// Ids that collide with prototype names or with the change set's "config" entry.
function assertUsableId(ctx: OpContext, id: ID): void {
  if (FORBIDDEN_KEYS.has(id) || id === "config") {
    throw new AnnotateError("INVALID_DOCUMENT", `Id "${clip(id)}" is reserved`)
  }
  if (ctx.draft.idInUse(id)) {
    throw new AnnotateError("DUPLICATE_ID", `Id "${clip(id)}" is already used`)
  }
}

function assertRoom(ctx: OpContext): void {
  const { draft, limits } = ctx
  // The regions record is one object, so it is also bound by maxEntries.
  if (
    draft.annotationCount + 1 > limits.maxAnnotations ||
    draft.regionCount + 1 > limits.maxEntries
  ) {
    throw new AnnotateError("LIMIT_EXCEEDED", `More than ${limits.maxAnnotations} annotations`)
  }
}

export function createRegion(ctx: OpContext, op: CreateRegionOp): InverseOp[] {
  const { draft } = ctx
  const payload = op.region as Record<string, unknown>
  assertDepth(payload, ctx.limits, REGION_LEVEL, "region")
  const parsed = parseRegion({
    ...payload,
    rev: payload["rev"] ?? 0,
    provenance: { ...(payload["provenance"] as object), updatedAt: ctx.at },
  })
  // Re-creating an id deleted earlier in this batch continues its rev (revs are never reused).
  const deletedRev = draft.deletedRev(parsed.id)
  const region =
    deletedRev === undefined || parsed.rev > deletedRev
      ? parsed
      : { ...parsed, rev: deletedRev + 1 }
  assertUsableId(ctx, region.id)
  const source = needSource(ctx, region.sourceId)
  assertRoom(ctx)
  const index = insertionIndex(ctx.charge, source.regionOrder, region.id, op.position ?? "top")
  assertRegionRules(ctx, region)
  storeRegion(ctx, region)
  insertAt(ctx.charge, draft.regionOrder(source.id), index, region.id)
  return [{ type: "deleteRegion", regionId: region.id, children: "detach" }]
}

export function setGeometry(ctx: OpContext, op: SetGeometryOp): InverseOp[] {
  const region = needRegion(ctx, op.regionId)
  checkBaseRev(ctx, op, region.rev)
  assertDepth(op.geometry, ctx.limits, GEOMETRY_LEVEL, "geometry")
  const parsed = safeParse(GeometrySchema, op.geometry, { abortEarly: true })
  if (!parsed.success) {
    throw new AnnotateError(
      "INVALID_GEOMETRY",
      `geometry: ${clip(parsed.issues[0]?.message ?? "")}`,
    )
  }
  if (deepEqual(parsed.output, region.geometry)) return []
  storeRegion(ctx, validateRegion(ctx, touched({ ...region, geometry: parsed.output }, ctx.at)))
  return [{ type: "setGeometry", regionId: op.regionId, geometry: region.geometry }]
}

export function patchRegion(ctx: OpContext, op: PatchRegionOp): InverseOp[] {
  const region = needRegion(ctx, op.regionId)
  checkBaseRev(ctx, op, region.rev)
  const result = applyAnnotationPatch(ctx, region, op.patch)
  if (!result) return []
  if (typeof op.patch.parentId === "string") assertNoCycle(ctx, op.regionId, op.patch.parentId)
  storeRegion(ctx, validateRegion(ctx, touched(result.next, ctx.at)))
  return [{ type: "patchRegion", regionId: op.regionId, patch: result.undo }]
}

export function reorderRegion(ctx: OpContext, op: ReorderRegionOp): InverseOp[] {
  const region = needRegion(ctx, op.regionId)
  checkBaseRev(ctx, op, region.rev)
  return reorder(ctx, region, op.position)
}
