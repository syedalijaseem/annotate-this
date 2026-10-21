// Operation types. Normative source: Spec 0002 (operation catalog).

import type { Limits } from "../limits.js"
import type {
  AnnotationDocument,
  AttributeValue,
  Geometry,
  ID,
  JSONValue,
  Region,
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

export type Operation =
  | SetDocumentMetaOp
  | CreateRegionOp
  | SetGeometryOp
  | PatchRegionOp
  | DeleteRegionOp
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
