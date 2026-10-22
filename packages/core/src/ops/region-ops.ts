import { safeParse } from "valibot"
import { AnnotateError } from "../errors.js"
import { clip } from "../validate/issues.js"
import { GeometrySchema } from "../schema/geometry.js"
import type { Region } from "../types.js"
import {
  GEOMETRY_LEVEL,
  REGION_LEVEL,
  assertDepth,
  assertRegionRules,
  parseRegion,
  validateRegion,
} from "./check.js"
import { type InverseOp, type OpContext, checkBaseRev } from "./context.js"
import {
  assertUsableId,
  continuedRev,
  needRegion,
  needSource,
  reorder,
  storeRegion,
  touched,
} from "./entities.js"
import { insertAt, insertionIndex } from "./order.js"
import { applyPatch } from "./patch.js"
import type {
  CreateRegionOp,
  PatchRegionOp,
  RegionPatch,
  ReorderRegionOp,
  SetGeometryOp,
} from "./types.js"
import { assertNoCycle } from "./region-tree.js"
import { deepEqual } from "./util.js"

// Fails when `count` more regions would not fit.
export function assertRoom(ctx: OpContext, count: number): void {
  const { draft, limits } = ctx
  // The regions record is one object, so it is also bound by maxEntries.
  if (
    draft.annotationCount + count > limits.maxAnnotations ||
    draft.regionCount + count > limits.maxEntries
  ) {
    throw new AnnotateError("LIMIT_EXCEEDED", `More than ${limits.maxAnnotations} annotations`)
  }
}

// A createRegion payload as it will be stored: rev defaults to 0 (continued
// past a delete earlier in the batch) and updatedAt is the batch time.
export function parseNewRegion(ctx: OpContext, input: unknown): Region {
  const payload = input as Record<string, unknown>
  assertDepth(payload, ctx.limits, REGION_LEVEL, "region")
  const parsed = parseRegion({
    ...payload,
    rev: payload["rev"] ?? 0,
    provenance: { ...(payload["provenance"] as object), updatedAt: ctx.at },
  })
  return continuedRev(ctx.draft, parsed)
}

export function createRegion(ctx: OpContext, op: CreateRegionOp): InverseOp[] {
  const { draft } = ctx
  const region = parseNewRegion(ctx, op.region)
  assertUsableId(ctx, region.id)
  const source = needSource(ctx, region.sourceId)
  assertRoom(ctx, 1)
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
  const result = applyPatch(ctx, region, op.patch)
  if (!result) return []
  if (typeof op.patch.parentId === "string") assertNoCycle(ctx, op.regionId, op.patch.parentId)
  storeRegion(ctx, validateRegion(ctx, touched(result.next, ctx.at)))
  return [{ type: "patchRegion", regionId: op.regionId, patch: result.undo as RegionPatch }]
}

export function reorderRegion(ctx: OpContext, op: ReorderRegionOp): InverseOp[] {
  const region = needRegion(ctx, op.regionId)
  checkBaseRev(ctx, op, region.rev)
  return reorder(ctx, region, op.position)
}
