import type { AnnotationDocument, ID, Meta, Region, Source } from "../types.js"
import type { ChangeSet } from "./types.js"

const copyRecord = <V>(record: Record<string, V>): Record<string, V> =>
  Object.assign(Object.create(null) as Record<string, V>, record)

/**
 * The working copy a batch is applied to. `apply` never mutates its input:
 * the draft copies a record the first time it is written and replaces entities
 * instead of editing them, so one batch costs O(records touched), not O(ops x records).
 */
export class Draft {
  private doc: AnnotationDocument
  private regionsOwned = false
  private sourcesOwned = false
  private readonly created = new Set<ID>()
  private readonly updated = new Set<ID>()
  private readonly deleted = new Set<ID>()
  /** parentId -> ids of the regions and tracks that name it. Built on first use. */
  private childIndex: Map<ID, Set<ID>> | null = null
  annotationCount: number

  constructor(readonly original: AnnotationDocument) {
    this.doc = { ...original }
    this.annotationCount =
      Object.keys(original.regions).length + Object.keys(original.tracks).length
  }

  /** Read-only view for validators and lookups. Replaced (never edited) when a record is first written. */
  get view(): AnnotationDocument {
    return this.doc
  }

  region(id: ID): Region | undefined {
    return Object.hasOwn(this.doc.regions, id) ? this.doc.regions[id] : undefined
  }

  source(id: ID): Source | undefined {
    return Object.hasOwn(this.doc.sources, id) ? this.doc.sources[id] : undefined
  }

  /** Ids are unique across the whole document (Spec 0001, invariant 2). */
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

  /** Regions and tracks whose `parentId` is `id`. */
  childrenOf(id: ID): ID[] {
    if (!this.childIndex) {
      this.childIndex = new Map()
      for (const entity of [
        ...Object.values(this.doc.regions),
        ...Object.values(this.doc.tracks),
      ]) {
        this.link(entity.id, entity.parentId)
      }
    }
    return [...(this.childIndex.get(id) ?? [])]
  }

  /** Whether a track (not yet an operation target) names `id` as its parent. */
  hasTrackChildren(id: ID): boolean {
    return this.childrenOf(id).some((child) => Object.hasOwn(this.doc.tracks, child))
  }

  /** Adds or replaces a region. */
  putRegion(region: Region): void {
    const previous = this.region(region.id)
    this.ownRegions()
    this.doc.regions[region.id] = region
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
    this.annotationCount -= 1
    this.unlink(id, previous.parentId)
    this.markDeleted(id)
  }

  putSource(source: Source): void {
    this.ownSources()
    this.doc.sources[source.id] = source
    this.markUpdated(source.id)
  }

  setDocumentMeta(meta: Meta): void {
    this.doc = { ...this.doc, meta }
  }

  /** Commits the batch: one document rev bump, and the net change set. */
  finish(): { doc: AnnotationDocument; changes: ChangeSet } {
    const changed =
      this.created.size + this.updated.size + this.deleted.size > 0 || this.metaChanged()
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

  private metaChanged(): boolean {
    return this.doc.meta !== this.original.meta
  }

  private ownRegions(): void {
    if (this.regionsOwned) return
    this.doc = { ...this.doc, regions: copyRecord(this.doc.regions) }
    this.regionsOwned = true
  }

  private ownSources(): void {
    if (this.sourcesOwned) return
    this.doc = { ...this.doc, sources: copyRecord(this.doc.sources) }
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

  markCreated(id: ID): void {
    if (this.deleted.delete(id)) this.updated.add(id)
    else this.created.add(id)
  }

  markUpdated(id: ID): void {
    if (!this.created.has(id)) this.updated.add(id)
  }

  markDeleted(id: ID): void {
    if (this.created.delete(id)) return
    this.updated.delete(id)
    this.deleted.add(id)
  }
}
