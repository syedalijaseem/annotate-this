import type { BoxGeometry, Geometry, ID, Region, Source, Track } from "../types.js"
import { areaIssues } from "../validate/geometry-rules.js"
import { own } from "../validate/issues.js"
import { geometryWeight } from "../validate/limit-checks.js"
import type { InverseOp, OpContext } from "./context.js"
import { inUse, storeRegion, touched } from "./entities.js"
import { applyPatch } from "./patch.js"
import type { SourcePatch } from "./types.js"

// Entities that can reference config entries (classes, tags, attribute keys).
export type Holder = Region | Track | Source

export interface Uses {
  regions: Region[]
  tracks: Track[]
  sources: Source[]
}

// Work units per entity a whole-document scan visits. Measured at about 0.4 µs
// per region on a 50,000-region document, so that a batch of scans (config
// toggles) runs out of budget within about a second.
export const SCAN_COST = 32

// Every region, track and (unless `withSources` is false) source that `test`
// accepts. These are the whole-document scans config changes need; each is
// charged SCAN_COST per entity scanned, so a batch of them stays bounded.
export function findUses(ctx: OpContext, test: (h: Holder) => boolean, withSources = true): Uses {
  const { draft } = ctx
  const { regions, tracks, sources } = draft.view
  const scanned = draft.annotationCount + (withSources ? draft.view.sourceOrder.length : 0)
  ctx.charge(SCAN_COST * scanned)
  return {
    regions: Object.values(regions).filter(test),
    tracks: Object.values(tracks).filter(test),
    sources: withSources ? Object.values(sources).filter(test) : [],
  }
}

// Regions and tracks that `test` accepts; sources are not scanned, so `test` only sees annotations.
export const findAnnotationUses = (ctx: OpContext, test: (a: Region | Track) => boolean): Uses =>
  findUses(ctx, test as (h: Holder) => boolean, false)

// The geometries of a region or track (one per keyframe), charged per geometry.
export function geometriesOf(ctx: OpContext, h: Region | Track): Geometry[] {
  if ("geometry" in h) return [h.geometry]
  ctx.charge(h.keyframes.length)
  return h.keyframes.map((k) => k.geometry)
}

// Tracks are not operation targets yet (no createTrack/patchTrack), so an op
// that would have to change or delete one could not be undone: refuse it.
export function assertNoTrackChanges(uses: Uses): void {
  if (uses.tracks.length > 0) {
    throw inUse(`Used by track "${uses.tracks[0]?.id}"; tracks cannot be changed by operations yet`)
  }
}

export const anyUse = (uses: Uses): boolean =>
  uses.regions.length + uses.tracks.length + uses.sources.length > 0

// Applies `patchOf(entity)` to every region and source in `uses` (each one
// changes once, rev +1) and returns the steps that undo it.
export function detach(ctx: OpContext, uses: Uses, patchOf: (h: Holder) => object): InverseOp[] {
  const { draft } = ctx
  const steps: InverseOp[] = []
  for (const region of uses.regions) {
    const result = applyPatch(ctx, region, patchOf(region))
    if (!result) continue
    storeRegion(ctx, touched(result.next, ctx.at))
    steps.push({ type: "patchRegion", regionId: region.id, patch: result.undo })
  }
  for (const source of uses.sources) {
    const result = applyPatch(ctx, source, patchOf(source))
    if (!result) continue
    draft.putSource(result.next)
    draft.touchSource(source.id)
    steps.push({ type: "updateSource", sourceId: source.id, patch: result.undo as SourcePatch })
  }
  return steps
}

// Fails with IN_USE when a geometry on `source` (regions and track keyframes)
// would lie outside `area`. Read-only over tracks. Charged by vertices.
export function assertAreaHolds(ctx: OpContext, source: Source, area: BoxGeometry | undefined) {
  if (!area) return
  const { draft } = ctx
  const ids: ID[] =
    source.kind === "video" ? [...source.regionOrder, ...source.trackOrder] : source.regionOrder
  ctx.charge(SCAN_COST * ids.length)
  for (const id of ids) {
    const holder = draft.region(id) ?? own(draft.view.tracks, id)
    for (const geometry of holder ? geometriesOf(ctx, holder) : []) {
      ctx.charge(geometryWeight(geometry))
      if (areaIssues(geometry, id, source, area).length > 0) {
        throw inUse(`Annotation "${id}" would lie outside the allowed area`)
      }
    }
  }
}
