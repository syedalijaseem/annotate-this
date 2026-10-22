import { AnnotateError } from "../errors.js"
import { SourceSchema } from "../schema/source.js"
import type { Region, Source } from "../types.js"
import { countNodes } from "../validate/depth.js"
import { type Issue, pushAll } from "../validate/issues.js"
import { attributeIssues } from "../validate/labels.js"
import { metaDepthIssues, sourceStrings, textLimit } from "../validate/limit-checks.js"
import { sourceRefIssues } from "../validate/references.js"
import { videoSourceIssues } from "../validate/video.js"
import { LEVELS, assertDepth, parseWith } from "./check.js"
import { type InverseOp, type OpContext, checkBaseRev } from "./context.js"
import {
  assertNone,
  assertUsableId,
  continuedRev,
  inUse,
  needSource,
  reorderIn,
} from "./entities.js"
import { insertAt, insertionIndex, removeEntries } from "./order.js"
import { applyPatch } from "./patch.js"
import type {
  AddSourceOp,
  NewSource,
  RemoveSourceOp,
  ReorderSourceOp,
  SourcePatch,
  UpdateSourceOp,
} from "./types.js"
import { assertAreaHolds } from "./uses.js"

// The parseDocument rules for one source as it would be stored. Frame timing
// is only checked when the source is new: updateSource cannot change it.
function sourceIssues(ctx: OpContext, source: Source, isNew: boolean): Issue[] {
  const doc = ctx.draft.view
  const { limits } = ctx
  const at = `sources.${source.id}`
  ctx.charge(
    1 + source.tagIds.length + Object.keys(source.attributes).length + countNodes(source.meta),
  )
  const issues = [
    ...sourceRefIssues(doc, source.id, source),
    ...attributeIssues(doc, `${at}.attributes`, source.attributes),
    ...metaDepthIssues(`${at}.meta`, source.meta, limits),
  ]
  sourceStrings(textLimit(issues), source.id, source, limits)
  if (isNew && source.kind === "video") {
    ctx.charge(source.timestamps?.length ?? 0)
    pushAll(issues, videoSourceIssues(source.id, source))
  }
  return issues
}

export function addSource(ctx: OpContext, op: AddSourceOp): InverseOp[] {
  const { draft, limits } = ctx
  const payload = op.source as unknown as Record<string, unknown>
  assertDepth(payload, limits, LEVELS.source, "source")
  const parsed = parseWith(SourceSchema, { ...payload, rev: payload["rev"] ?? 0 }, "source")
  const source = continuedRev(draft, parsed)
  assertUsableId(ctx, source.id)
  // Regions and tracks are added by their own operations, which keep the orders exact.
  if (source.regionOrder.length > 0 || (source.kind === "video" && source.trackOrder.length > 0)) {
    throw new AnnotateError("INVALID_DOCUMENT", "A new source must start without regions or tracks")
  }
  const order = draft.view.sourceOrder
  // The sources record is one object, so it is bound by maxEntries.
  if (order.length + 1 > limits.maxEntries) {
    throw new AnnotateError("LIMIT_EXCEEDED", `More than ${limits.maxEntries} sources`)
  }
  const index = insertionIndex(ctx.charge, order, source.id, op.position ?? "top")
  assertNone(sourceIssues(ctx, source, true))
  draft.putSource(source)
  insertAt(ctx.charge, draft.order("sourceOrder"), index, source.id)
  return [{ type: "removeSource", sourceId: source.id }]
}

export function updateSource(ctx: OpContext, op: UpdateSourceOp): InverseOp[] {
  const { draft, limits } = ctx
  const source = needSource(ctx, op.sourceId)
  checkBaseRev(ctx, op, source.rev)
  for (const field of ["allowedArea", "scale"] as const) {
    const value = op.patch[field]
    if (value) assertDepth(value, limits, LEVELS.sourceField, `source.${field}`)
  }
  const result = applyPatch(ctx, source, op.patch)
  if (!result) return []
  const { next, undo } = result
  assertNone(sourceIssues(ctx, next, false))
  // Clearing the source's own area falls back to the config area, which may be stricter.
  if ("allowedArea" in undo) {
    assertAreaHolds(ctx, next, next.allowedArea ?? draft.view.config.allowedArea)
  }
  draft.putSource(next)
  draft.touchSource(next.id)
  return [{ type: "updateSource", sourceId: next.id, patch: undo as SourcePatch }]
}

// Deletes every region of the source; returns the createRegions step that
// restores them (bottom to top, each at rev + 1). createRegions validates the
// regions as a set, so parents may come after their children: one linear step.
function removeRegionsOf(ctx: OpContext, source: Source): InverseOp[] {
  const { draft } = ctx
  const ids = source.regionOrder
  if (ids.length === 0) return []
  ctx.charge(ids.length)
  const regions = ids.map((id): Region => {
    const region = draft.region(id)
    if (!region) throw new AnnotateError("INVALID_DOCUMENT", "The source's region order is stale")
    return { ...region, rev: region.rev + 1 }
  })
  for (const id of ids) draft.removeRegion(id)
  return [{ type: "createRegions", regions }]
}

export function removeSource(ctx: OpContext, op: RemoveSourceOp): InverseOp[] {
  const { draft } = ctx
  const source = needSource(ctx, op.sourceId)
  checkBaseRev(ctx, op, source.rev)
  // Tracks are not operation targets yet, so a cascade could not restore them on undo.
  if (source.kind === "video" && source.trackOrder.length > 0) {
    throw inUse(`Source "${source.id}" has tracks; tracks cannot be removed by operations yet`)
  }
  const regions = removeRegionsOf(ctx, source)
  const [position] = removeEntries(ctx.charge, draft.order("sourceOrder"), [source.id])
  draft.removeSource(source.id)
  // Restored with rev = deletedRev + 1 and an empty order; the createRegions step refills it.
  const restored = { ...source, rev: source.rev + 1, regionOrder: [] } as NewSource
  return [{ type: "addSource", source: restored, position: position ?? "top" }, ...regions]
}

export function reorderSource(ctx: OpContext, op: ReorderSourceOp): InverseOp[] {
  const source = needSource(ctx, op.sourceId)
  checkBaseRev(ctx, op, source.rev)
  const restore = reorderIn(ctx, "sourceOrder", source.id, op.position)
  return restore ? [{ type: "reorderSource", sourceId: source.id, position: restore }] : []
}
