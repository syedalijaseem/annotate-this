import type { Limits } from "../limits.js"
import type { AnnotationDocument, Config, ID, Meta, Region, Source } from "../types.js"
import { RESERVED_ID } from "../validate/identity.js"
import { own, walkGeometries } from "../validate/issues.js"
import { type DefKind, geometryWeight } from "../validate/limit-checks.js"
import { ZERO, configShellSize, defSize, metaSize, regionSize, sourceSize } from "./doc-size.js"
import { SizeMeter } from "./size-meter.js"
import type { ChangeSet } from "./types.js"
import { deepEqual } from "./util.js"

// Spends work units against the batch budget; throws LIMIT_EXCEEDED when it runs out.
export type Charge = (units: number) => void

export type { DefKind }
export type Def<K extends DefKind> = Config[K][string]
// Orderings outside sources: the document's sourceOrder and the config's class and tag orders.
export type OrderKind = "sourceOrder" | "classOrder" | "tagOrder"

function copyRecord<V>(record: Record<string, V>, charge: Charge): Record<string, V> {
  const copy = Object.assign(Object.create(null) as Record<string, V>, record)
  charge(Object.keys(copy).length)
  return copy
}

// The change-set id of the config (Spec 0002, change events); parseDocument reserves it.
const CONFIG = RESERVED_ID

// Classes and tags also have an entry in a config ordering.
const isOrdered = (kind: DefKind): boolean => kind === "classes" || kind === "tags"

const sameOrder = (a: readonly ID[], b: readonly ID[]): boolean =>
  a === b || (a.length === b.length && a.every((id, i) => id === b[i]))

// The working copy a batch is applied to. `apply` never mutates its input:
// the draft copies a record (an order, the config) the first time it is
// written and replaces entities instead of editing them, so one batch costs
// O(records touched), not O(ops x records). The copies are private to the
// draft, which is the only place they are edited in place. Every entity it
// replaces is reported to a SizeMeter, which keeps the document-wide value and
// size limits without re-walking the document.
export class Draft {
  private doc: AnnotationDocument
  private regionsOwned = false
  private sourcesOwned = false
  private configOwned = false
  // Config records and document/config orders that are private copies.
  private readonly ownedParts = new Set<string>()
  private readonly created = new Set<ID>()
  private readonly updated = new Set<ID>()
  private readonly deleted = new Set<ID>()
  // rev of each region or source at the moment it was deleted in this batch.
  private readonly deletedRevs = new Map<ID, number>()
  // Sources whose regionOrder array belongs to this draft.
  private readonly ownedOrders = new Set<ID>()
  // Sources the current operation changed; each gets one rev bump in endOp().
  private readonly opSources = new Set<ID>()
  // Sources added by this batch: they appear with the rev they were added
  // with, so later operations of the batch do not bump them.
  private readonly bornSources = new Set<ID>()
  private readonly meter: SizeMeter
  // Whether the current operation changed the config; it gets one rev bump in endOp().
  private opConfig = false
  // Entry counts of config records, computed on first use.
  private readonly sizes = new Map<DefKind, number>()
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
    limits: Limits,
  ) {
    this.meter = new SizeMeter(original, limits, charge)
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
    return own(this.doc.regions, id)
  }

  source(id: ID): Source | undefined {
    return own(this.doc.sources, id)
  }

  def<K extends DefKind>(kind: K, key: string): Def<K> | undefined {
    return own(this.doc.config[kind] as Record<string, Def<K>>, key)
  }

  // Ids are unique across the whole document (Spec 0001, invariant 1).
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

  // The rev a region or source had when this batch deleted it, if it did.
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
    this.meter.change(previous ? regionSize(previous) : ZERO, regionSize(region))
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
    this.meter.change(regionSize(previous), ZERO)
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
    this.setRegionOrder(sourceId, order)
    return order
  }

  // Replaces an existing source's region order with `order`, which becomes the draft's own copy.
  setRegionOrder(sourceId: ID, order: ID[]): void {
    const source = this.source(sourceId) as Source
    this.opSources.add(sourceId)
    this.ownedOrders.add(sourceId)
    this.storeSource({ ...source, regionOrder: order })
  }

  // Adds or replaces a source. A replaced source keeps its rev here: call
  // touchSource() so that endOp() bumps it once.
  putSource(source: Source): void {
    const previous = this.source(source.id)
    if (!previous) this.bornSources.add(source.id)
    this.meter.change(previous ? sourceSize(previous) : ZERO, sourceSize(source))
    this.storeSource(source)
  }

  touchSource(id: ID): void {
    this.opSources.add(id)
  }

  // Removes a source entry; its regions and its sourceOrder entry are the caller's job.
  removeSource(id: ID): void {
    const previous = this.source(id) as Source
    this.ownSources()
    // Safe in place: ownSources() made this record a private copy.
    Reflect.deleteProperty(this.doc.sources, id)
    this.meter.change(sourceSize(previous), ZERO)
    this.bornSources.delete(id)
    this.opSources.delete(id)
    this.ownedOrders.delete(id)
    this.deletedRevs.set(id, previous.rev)
    this.markDeleted(id)
  }

  // A writable ordering, copied once per batch. Class and tag orders belong
  // to the config, so writing one marks the config as changed by this op;
  // sourceOrder belongs to the document, whose rev moves once per batch anyway.
  order(kind: OrderKind): ID[] {
    if (kind !== "sourceOrder") return this.configPart(kind)
    if (!this.ownedParts.has(kind)) {
      this.doc = { ...this.doc, sourceOrder: [...this.doc.sourceOrder] }
      this.charge(this.doc.sourceOrder.length)
      this.ownedParts.add(kind)
    }
    return this.doc.sourceOrder
  }

  // Number of entries in a config record, kept up to date across the batch.
  defCount(kind: DefKind): number {
    let size = this.sizes.get(kind)
    if (size === undefined) {
      size = Object.keys(this.doc.config[kind]).length
      this.charge(size)
      this.sizes.set(kind, size)
    }
    return size
  }

  putDef<K extends DefKind>(kind: K, key: string, def: Def<K>): void {
    const count = this.defCount(kind)
    const previous = this.def(kind, key)
    const ordered = isOrdered(kind)
    this.meter.change(previous ? defSize(key, previous, ordered) : ZERO, defSize(key, def, ordered))
    const record = this.configPart(kind) as Record<string, Def<K>>
    if (!previous) this.sizes.set(kind, count + 1)
    record[key] = def
  }

  removeDef(kind: DefKind, key: string): void {
    const count = this.defCount(kind)
    const previous = this.def(kind, key)
    if (previous) this.meter.change(defSize(key, previous, isOrdered(kind)), ZERO)
    Reflect.deleteProperty(this.configPart(kind), key)
    this.sizes.set(kind, count - 1)
  }

  // Replaces the config's settings; `next` must be a fresh shallow copy of the current config.
  replaceConfig(next: Config): void {
    this.meter.change(configShellSize(this.doc.config), configShellSize(next))
    this.doc = { ...this.doc, config: next }
    this.configOwned = true
    this.opConfig = true
  }

  // Ends an operation: every source it changed, and the config, get exactly one rev bump.
  endOp(): void {
    for (const id of this.opSources) {
      if (this.bornSources.has(id)) continue
      const source = this.source(id) as Source
      this.storeSource({ ...source, rev: source.rev + 1 })
    }
    this.opSources.clear()
    if (this.opConfig) {
      const { config } = this.doc
      this.doc = { ...this.doc, config: { ...config, rev: config.rev + 1 } }
      this.markUpdated(CONFIG)
      this.opConfig = false
    }
  }

  setDocumentMeta(meta: Meta): void {
    this.meter.change(metaSize(this.doc.meta), metaSize(meta))
    this.doc = { ...this.doc, meta }
  }

  // Whether the batch changed anything, comparing the document's own fields
  // by content: a batch that nets out to nothing commits nothing.
  private changed(): boolean {
    const { doc, original } = this
    if (this.created.size + this.updated.size + this.deleted.size > 0) return true
    if (!sameOrder(doc.sourceOrder, original.sourceOrder)) return true
    return doc.meta !== original.meta && !deepEqual(doc.meta, original.meta)
  }

  // Commits the batch: one document rev bump, and the net change set.
  finish(): { doc: AnnotationDocument; changes: ChangeSet } {
    if (!this.changed()) {
      return { doc: this.original, changes: { created: [], updated: [], deleted: [] } }
    }
    this.markUpdated(this.doc.id)
    const doc = { ...this.doc, rev: this.original.rev + 1 }
    this.meter.commit(doc)
    return {
      doc,
      changes: {
        created: [...this.created],
        updated: [...this.updated],
        deleted: [...this.deleted],
      },
    }
  }

  // A writable config record or order, copied once per batch; marks the config as changed.
  private configPart<K extends DefKind | "classOrder" | "tagOrder">(key: K): Config[K] {
    if (!this.configOwned) {
      this.doc = { ...this.doc, config: { ...this.doc.config } }
      this.configOwned = true
    }
    this.opConfig = true
    const { config } = this.doc
    if (!this.ownedParts.has(key)) {
      const value: unknown = config[key]
      if (Array.isArray(value)) this.charge(value.length)
      config[key] = (
        Array.isArray(value)
          ? [...value]
          : copyRecord(value as Record<string, unknown>, this.charge)
      ) as Config[K]
      this.ownedParts.add(key)
    }
    return config[key]
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

  // Stores a source without re-measuring it: for changes that only touch its rev or regionOrder.
  private storeSource(source: Source): void {
    const existed = Object.hasOwn(this.doc.sources, source.id)
    this.ownSources()
    this.doc.sources[source.id] = source
    if (existed) this.markUpdated(source.id)
    else this.markCreated(source.id)
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
