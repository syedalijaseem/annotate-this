import type { AnnotationDocument, ID, Meta, Region, Source } from "../types.js"
import { walkGeometries } from "../validate/issues.js"
import { geometryWeight } from "../validate/limit-checks.js"
import type { ChangeSet } from "./types.js"

// Spends work units against the batch budget; throws LIMIT_EXCEEDED when it runs out.
export type Charge = (units: number) => void

function copyRecord<V>(record: Record<string, V>, charge: Charge): Record<string, V> {
  const copy = Object.assign(Object.create(null) as Record<string, V>, record)
  charge(Object.keys(copy).length)
  return copy
}

// The working copy a batch is applied to. `apply` never mutates its input:
// the draft copies a record (and a source's region order) the first time it
// is written and replaces entities instead of editing them, so one batch
// costs O(records touched), not O(ops x records). The copies are private to
// the draft, which is the only place they are edited in place.
export class Draft {
  private doc: AnnotationDocument
  private regionsOwned = false
  private sourcesOwned = false
  private readonly created = new Set<ID>()
  private readonly updated = new Set<ID>()
  private readonly deleted = new Set<ID>()
  // rev of each region at the moment it was deleted in this batch.
  private readonly deletedRevs = new Map<ID, number>()
  // Sources whose regionOrder array belongs to this draft.
  private readonly ownedOrders = new Set<ID>()
  // Sources the current operation changed; each gets one rev bump in endOp().
  private readonly opSources = new Set<ID>()
  // parentId -> ids of the regions and tracks that name it. Built on first use.
  private childIndex: Map<ID, Set<ID>> | null = null
  // Running vertex total (Limits.maxTotalVertices). Computed on first use.
  private vertices: number | null = null
  annotationCount: number
  // Tracks are not operation targets yet, so their number is fixed for the batch.
  private readonly trackCount: number

  constructor(
    readonly original: AnnotationDocument,
    readonly charge: Charge,
  ) {
    this.doc = { ...original }
    this.trackCount = Object.keys(original.tracks).length
    this.annotationCount = Object.keys(original.regions).length + this.trackCount
  }

  get regionCount(): number {
    return this.annotationCount - this.trackCount
  }

  // Read-only view for validators and lookups. Replaced (never edited) when a record is first written.
  get view(): AnnotationDocument {
    return this.doc
  }

  region(id: ID): Region | undefined {
    return Object.hasOwn(this.doc.regions, id) ? this.doc.regions[id] : undefined
  }

  source(id: ID): Source | undefined {
    return Object.hasOwn(this.doc.sources, id) ? this.doc.sources[id] : undefined
  }

  // Ids are unique across the whole document (Spec 0001, invariant 2).
  idInUse(id: ID): boolean {
    const { doc } = this
    return (
      id === doc.id ||
      Object.hasOwn(doc.sources, id) ||
      Object.hasOwn(doc.regions, id) ||
      Object.hasOwn(doc.tracks, id) ||
      Object.hasOwn(doc.config.classes, id) ||
      Object.hasOwn(doc.config.tags, id) ||
      Object.hasOwn(doc.config.skeletons, id)
    )
  }

  // The rev a region had when this batch deleted it, if it did.
  deletedRev(id: ID): number | undefined {
    return this.deletedRevs.get(id)
  }

  // Regions and tracks whose `parentId` is `id`.
  childrenOf(id: ID): ID[] {
    if (!this.childIndex) {
      this.childIndex = new Map()
      for (const entity of [
        ...Object.values(this.doc.regions),
        ...Object.values(this.doc.tracks),
      ]) {
        this.link(entity.id, entity.parentId)
      }
      this.charge(this.annotationCount)
    }
    return [...(this.childIndex.get(id) ?? [])]
  }

  // Vertices in the whole document, counted as parseDocument counts them.
  totalVertices(): number {
    if (this.vertices === null) {
      let total = 0
      for (const { geometry } of walkGeometries(this.doc)) total += geometryWeight(geometry)
      this.charge(this.annotationCount)
      this.vertices = total
    }
    return this.vertices
  }

  // Adds or replaces a region.
  putRegion(region: Region): void {
    const previous = this.region(region.id)
    this.ownRegions()
    this.doc.regions[region.id] = region
    this.countVertices(previous, region)
    if (previous) {
      this.markUpdated(region.id)
      this.unlink(region.id, previous.parentId)
    } else {
      this.annotationCount += 1
      this.markCreated(region.id)
    }
    this.link(region.id, region.parentId)
  }

  removeRegion(id: ID): void {
    const previous = this.region(id)
    if (!previous) return
    this.ownRegions()
    // Safe in place: ownRegions() made this record a private copy.
    Reflect.deleteProperty(this.doc.regions, id)
    this.countVertices(previous, undefined)
    this.annotationCount -= 1
    this.unlink(id, previous.parentId)
    this.deletedRevs.set(id, previous.rev)
    this.markDeleted(id)
  }

  // The writable region order of an existing source, copied once per batch.
  // Calling it marks the source as changed by the current operation, so call
  // it only once the operation is known to change the order.
  regionOrder(sourceId: ID): ID[] {
    const source = this.source(sourceId) as Source
    this.opSources.add(sourceId)
    if (this.ownedOrders.has(sourceId)) return source.regionOrder
    const order = [...source.regionOrder]
    this.charge(order.length)
    this.ownedOrders.add(sourceId)
    this.putSource({ ...source, regionOrder: order })
    return order
  }

  // Ends an operation: every source it changed gets exactly one rev bump.
  endOp(): void {
    for (const id of this.opSources) {
      const source = this.source(id) as Source
      this.putSource({ ...source, rev: source.rev + 1 })
    }
    this.opSources.clear()
  }

  setDocumentMeta(meta: Meta): void {
    this.doc = { ...this.doc, meta }
  }

  // Commits the batch: one document rev bump, and the net change set.
  finish(): { doc: AnnotationDocument; changes: ChangeSet } {
    const changed =
      this.created.size + this.updated.size + this.deleted.size > 0 ||
      this.doc.meta !== this.original.meta
    if (!changed) {
      return { doc: this.original, changes: { created: [], updated: [], deleted: [] } }
    }
    this.markUpdated(this.doc.id)
    const doc = { ...this.doc, rev: this.original.rev + 1 }
    return {
      doc,
      changes: {
        created: [...this.created],
        updated: [...this.updated],
        deleted: [...this.deleted],
      },
    }
  }

  private putSource(source: Source): void {
    this.ownSources()
    this.doc.sources[source.id] = source
    this.markUpdated(source.id)
  }

  private countVertices(previous: Region | undefined, next: Region | undefined): void {
    if (this.vertices === null) return
    const before = previous ? geometryWeight(previous.geometry) : 0
    this.vertices += (next ? geometryWeight(next.geometry) : 0) - before
  }

  private ownRegions(): void {
    if (this.regionsOwned) return
    this.doc = { ...this.doc, regions: copyRecord(this.doc.regions, this.charge) }
    this.regionsOwned = true
  }

  private ownSources(): void {
    if (this.sourcesOwned) return
    this.doc = { ...this.doc, sources: copyRecord(this.doc.sources, this.charge) }
    this.sourcesOwned = true
  }

  private link(id: ID, parentId: ID | undefined): void {
    if (!this.childIndex || parentId === undefined) return
    const children = this.childIndex.get(parentId) ?? new Set<ID>()
    children.add(id)
    this.childIndex.set(parentId, children)
  }

  private unlink(id: ID, parentId: ID | undefined): void {
    if (!this.childIndex || parentId === undefined) return
    this.childIndex.get(parentId)?.delete(id)
  }

  private markCreated(id: ID): void {
    if (this.deleted.delete(id)) this.updated.add(id)
    else this.created.add(id)
  }

  private markUpdated(id: ID): void {
    if (!this.created.has(id)) this.updated.add(id)
  }

  private markDeleted(id: ID): void {
    if (this.created.delete(id)) return
    this.updated.delete(id)
    this.deleted.add(id)
  }
}
