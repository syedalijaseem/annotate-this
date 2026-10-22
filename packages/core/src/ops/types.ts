// Operation types. Normative source: Spec 0002 (operation catalog).

import type { Limits } from "../limits.js"
import type {
  AnnotationDocument,
  AttributeDef,
  AttributeValue,
  BoxGeometry,
  ClassDef,
  Geometry,
  GeometryType,
  ID,
  JSONValue,
  Region,
  Skeleton,
  Source,
  SourceScale,
  TagDef,
} from "../types.js"

/** Where to put an entity in its ordering. Never an index (indices shift under concurrent edits). */
export type Position = "top" | "bottom" | { after: ID }

export type BatchOrigin = "local" | "remote" | "system"

export interface OperationBase {
  /** Unique; the basis of the idempotency window. */
  id: ID
  /** Expected `rev` of the operation's primary target. */
  baseRev?: number
}

/** `null` deletes a key. */
export type MetaPatch = Record<string, JSONValue | null>
/** `null` deletes a key. */
export type AttributesPatch = Record<string, AttributeValue | null>

/** Fields shared by region and track patches. Absent = unchanged, `null` = clear. */
export interface AnnotationPatch {
  classId?: ID | null
  /** Replaced wholesale. */
  tagIds?: ID[]
  attributes?: AttributesPatch
  comment?: string | null
  status?: string
  locked?: boolean | null
  hidden?: boolean | null
  parentId?: ID | null
  meta?: MetaPatch
}

export interface RegionPatch extends AnnotationPatch {
  /** Video sources only. */
  frame?: number | null
}

/** A region as passed to `createRegion`: `rev` defaults to 0. */
export type NewRegion = Omit<Region, "rev"> & { rev?: number }

export type ChildPolicy = "delete" | "detach"

export interface SetDocumentMetaOp extends OperationBase {
  type: "setDocumentMeta"
  patch: MetaPatch
}

/**
 * Adds a region to its source. A creation has no existing primary target, so
 * `baseRev` is ignored (as for `addSource`; config creations such as
 * `addClass` check it against the config).
 */
export interface CreateRegionOp extends OperationBase {
  type: "createRegion"
  region: NewRegion
  position?: Position
}

export interface SetGeometryOp extends OperationBase {
  type: "setGeometry"
  regionId: ID
  geometry: Geometry
}

export interface PatchRegionOp extends OperationBase {
  type: "patchRegion"
  regionId: ID
  patch: RegionPatch
}

export interface DeleteRegionOp extends OperationBase {
  type: "deleteRegion"
  regionId: ID
  children: ChildPolicy
}

/**
 * Adds several regions in one operation, with the same result as one
 * `createRegion` per entry in list order (`positions[k]` places `regions[k]`,
 * default `"top"`, and may anchor on an entry listed before it), except that
 * the regions are validated as a set: a parent may appear anywhere in the
 * list, and parent loops within the list fail with `CYCLE`. Regions may
 * belong to different sources. Inverses use it to restore many regions at
 * once in linear time (`removeSource`, subtree deletes); any caller may use
 * it. `baseRev` is ignored, as for `createRegion`.
 */
export interface CreateRegionsOp extends OperationBase {
  type: "createRegions"
  /** At least one. */
  regions: NewRegion[]
  /** Same length as `regions` when present. */
  positions?: Position[]
}

/**
 * Deletes several regions in one operation, with the same result as one
 * `deleteRegion` per id: under `"delete"` their subtrees go too, under
 * `"detach"` their remaining children lose `parentId`. Undone by
 * `createRegions`. There is no single primary target, so `baseRev` is ignored.
 */
export interface DeleteRegionsOp extends OperationBase {
  type: "deleteRegions"
  /** At least one, each listed once. */
  regionIds: ID[]
  children: ChildPolicy
}

export interface ReorderRegionOp extends OperationBase {
  type: "reorderRegion"
  regionId: ID
  position: Position
}

export interface MoveRegionToSourceOp extends OperationBase {
  type: "moveRegionToSource"
  regionId: ID
  sourceId: ID
  position?: Position
}

/** What to do when the entity being removed is still referenced. */
export type InUsePolicy = "reject" | "detach"

/** Config settings patch. Absent = unchanged, `null` = clear (back to the default). */
export interface ConfigPatch {
  taskDescription?: string | null
  tools?: string[] | null
  allowedArea?: BoxGeometry | null
  minRegionSize?: number | null
  statuses?: string[] | null
  /** Merged per key; `null` deletes a key. */
  meta?: MetaPatch
}

/** Absent = unchanged, `null` = clear. */
export interface ClassPatch {
  name?: string
  color?: string | null
  parentId?: ID | null
  allowedGeometry?: GeometryType[] | null
  attributeKeys?: string[] | null
  hotkey?: string | null
  meta?: MetaPatch
}

/** Absent = unchanged, `null` = clear. */
export interface TagPatch {
  name?: string
  color?: string | null
  meta?: MetaPatch
}

/** `points` and `edges` are replaced wholesale. */
export interface SkeletonPatch {
  name?: string
  points?: Skeleton["points"]
  edges?: Skeleton["edges"]
}

/** The patchable source fields (never kind, size, frame count or orders). Absent = unchanged, `null` = clear. */
export interface SourcePatch {
  name?: string
  uri?: string
  thumbnailUri?: string | null
  classId?: ID | null
  /** Replaced wholesale. */
  tagIds?: ID[]
  attributes?: AttributesPatch
  comment?: string | null
  allowedArea?: BoxGeometry | null
  scale?: SourceScale | null
  meta?: MetaPatch
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** A source as passed to `addSource`: `rev` defaults to 0; its region and track orders must be empty. */
export type NewSource = DistributiveOmit<Source, "rev"> & { rev?: number }

/** Changes config settings. Primary target: the config. */
export interface SetConfigOp extends OperationBase {
  type: "setConfig"
  patch: ConfigPatch
}

export interface AddClassOp extends OperationBase {
  type: "addClass"
  def: ClassDef
  position?: Position
}

export interface UpdateClassOp extends OperationBase {
  type: "updateClass"
  classId: ID
  patch: ClassPatch
}

/** Child classes are re-parented to the removed class's parent under either policy. */
export interface RemoveClassOp extends OperationBase {
  type: "removeClass"
  classId: ID
  onInUse: InUsePolicy
}

export interface ReorderClassOp extends OperationBase {
  type: "reorderClass"
  classId: ID
  position: Position
}

export interface AddTagOp extends OperationBase {
  type: "addTag"
  def: TagDef
  position?: Position
}

export interface UpdateTagOp extends OperationBase {
  type: "updateTag"
  tagId: ID
  patch: TagPatch
}

export interface RemoveTagOp extends OperationBase {
  type: "removeTag"
  tagId: ID
  onInUse: InUsePolicy
}

export interface ReorderTagOp extends OperationBase {
  type: "reorderTag"
  tagId: ID
  position: Position
}

/** Adds or replaces the definition with `def.key`. */
export interface SetAttributeDefOp extends OperationBase {
  type: "setAttributeDef"
  def: AttributeDef
}

export interface RemoveAttributeDefOp extends OperationBase {
  type: "removeAttributeDef"
  key: string
  onInUse: InUsePolicy
}

export interface AddSkeletonOp extends OperationBase {
  type: "addSkeleton"
  def: Skeleton
}

export interface UpdateSkeletonOp extends OperationBase {
  type: "updateSkeleton"
  skeletonId: ID
  patch: SkeletonPatch
}

export interface RemoveSkeletonOp extends OperationBase {
  type: "removeSkeleton"
  skeletonId: ID
}

/**
 * Adds an empty source. As for `createRegion`, `baseRev` is ignored: a
 * creation has no existing primary target.
 */
export interface AddSourceOp extends OperationBase {
  type: "addSource"
  source: NewSource
  position?: Position
}

export interface UpdateSourceOp extends OperationBase {
  type: "updateSource"
  sourceId: ID
  patch: SourcePatch
}

/** Deletes the source and all of its regions. */
export interface RemoveSourceOp extends OperationBase {
  type: "removeSource"
  sourceId: ID
}

export interface ReorderSourceOp extends OperationBase {
  type: "reorderSource"
  sourceId: ID
  position: Position
}

export type Operation =
  | SetDocumentMetaOp
  | SetConfigOp
  | AddClassOp
  | UpdateClassOp
  | RemoveClassOp
  | ReorderClassOp
  | AddTagOp
  | UpdateTagOp
  | RemoveTagOp
  | ReorderTagOp
  | SetAttributeDefOp
  | RemoveAttributeDefOp
  | AddSkeletonOp
  | UpdateSkeletonOp
  | RemoveSkeletonOp
  | AddSourceOp
  | UpdateSourceOp
  | RemoveSourceOp
  | ReorderSourceOp
  | CreateRegionOp
  | CreateRegionsOp
  | SetGeometryOp
  | PatchRegionOp
  | DeleteRegionOp
  | DeleteRegionsOp
  | ReorderRegionOp
  | MoveRegionToSourceOp

export type OperationType = Operation["type"]

export interface Batch {
  /** Batch id (logging, grouping). */
  id: ID
  origin: BatchOrigin
  actor?: string
  /** ISO-8601 UTC, supplied by the caller; becomes `provenance.updatedAt`. */
  at: string
  /** Human name for an undo UI, e.g. "Paste 20 regions". */
  label?: string
  /** 1..maxBatchOps, applied in order. */
  ops: Operation[]
}

export interface ApplyOptions {
  /** Skip `baseRev` checks. */
  ignoreRev?: boolean
  limits?: Partial<Limits>
  /**
   * Id for the `index`-th inverse operation of operation `opId`. Must be
   * deterministic (apply stays pure), return a valid id, and be unique across
   * the store's idempotency window. The default derives one by hashing
   * `(opId, index)`, which anyone can predict: a store that accepts operations
   * from remote peers should supply ids a peer cannot pre-empt (for example a
   * keyed hash or ids drawn before the call).
   */
  inverseId?: (opId: ID, index: number) => ID
}

/** Entity ids touched by a committed batch; `"config"` and the document id are included when they change. */
export interface ChangeSet {
  created: ID[]
  updated: ID[]
  deleted: ID[]
}

export interface ApplyResult {
  doc: AnnotationDocument
  changes: ChangeSet
  /** Operations that restore the previous state (except `rev` and `updatedAt`), in application order. */
  inverse: Operation[]
}
