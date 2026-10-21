// Public document types. Normative source: Spec 0001 (document schema).
// The Valibot schemas in ./schema are annotated with these types, so the compiler
// rejects any drift between a schema and its interface.

/** Opaque identifier, `^[A-Za-z0-9_.:-]{1,64}$`, unique across the whole document. */
export type ID = string

export type JSONValue =
  string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue }

/** Namespaced extension data (`"acme:foo"`), preserved untouched by the core. */
export type Meta = Record<string, JSONValue>

export type AttributeValue = string | number | boolean

export interface Point {
  x: number
  y: number
}

// ---------- geometry ----------

export interface BoxGeometry {
  type: "box"
  x: number
  y: number
  w: number
  h: number
}

export interface RotatedBoxGeometry {
  type: "rotatedBox"
  cx: number
  cy: number
  w: number
  h: number
  /** Radians, clockwise-positive (y points down). */
  angle: number
}

export interface PointGeometry {
  type: "point"
  x: number
  y: number
}

export interface PolygonGeometry {
  type: "polygon"
  /** Flat `[x0, y0, x1, y1, ...]` rings; `rings[0]` is the outer ring, the rest are holes. */
  rings: number[][]
}

export interface PolylineGeometry {
  type: "polyline"
  points: number[]
}

export interface KeypointsGeometry {
  type: "keypoints"
  skeletonId: ID
  /** Flat `[x, y, v, ...]` aligned to the skeleton points; v: 0 unlabeled, 1 hidden, 2 visible. */
  points: number[]
}

export interface MaskGeometry {
  type: "mask"
  x: number
  y: number
  width: number
  height: number
  /** Row-major run lengths; the first run counts 0-pixels; they sum to `width * height`. */
  counts: number[]
}

export interface CustomGeometry {
  type: "custom"
  /** `"vendor:name"`. */
  kind: string
  data: JSONValue
}

export type Geometry =
  | BoxGeometry
  | RotatedBoxGeometry
  | PointGeometry
  | PolygonGeometry
  | PolylineGeometry
  | KeypointsGeometry
  | MaskGeometry
  | CustomGeometry

export type GeometryType = Geometry["type"]

// ---------- config (label schema and settings) ----------

export interface ClassDef {
  id: ID
  name: string
  color?: string
  parentId?: ID
  allowedGeometry?: GeometryType[]
  attributeKeys?: string[]
  hotkey?: string
  meta: Meta
}

export interface TagDef {
  id: ID
  name: string
  color?: string
  meta: Meta
}

export interface AttributeDef {
  key: string
  label: string
  required?: boolean
  type: "string" | "number" | "boolean" | "enum"
  options?: string[]
  min?: number
  max?: number
  default?: AttributeValue
}

export interface Skeleton {
  id: ID
  name: string
  points: { name: string; color?: string }[]
  edges: [number, number][]
}

export interface Config {
  rev: number
  taskDescription?: string
  classes: Record<ID, ClassDef>
  classOrder: ID[]
  tags: Record<ID, TagDef>
  tagOrder: ID[]
  attributes: Record<string, AttributeDef>
  skeletons: Record<ID, Skeleton>
  tools?: string[]
  allowedArea?: BoxGeometry
  minRegionSize?: number
  statuses?: string[]
  meta: Meta
}

// ---------- sources ----------

export interface SourceScale {
  pixelSize?: { w: number; h: number }
  realSize?: { w: number; h: number; unit: string }
}

export interface SourceBase {
  id: ID
  rev: number
  name: string
  uri: string
  thumbnailUri?: string
  /** Z-order, bottom to top; exactly this source's regions. */
  regionOrder: ID[]
  classId?: ID
  tagIds: ID[]
  attributes: Record<string, AttributeValue>
  comment?: string
  allowedArea?: BoxGeometry
  scale?: SourceScale
  meta: Meta
}

export interface ImageSource extends SourceBase {
  kind: "image"
  /** Oriented (post-EXIF) pixel size. */
  width: number
  height: number
}

export interface VideoSource extends SourceBase {
  kind: "video"
  width: number
  height: number
  frameCount: number
  /** Constant frame rate. Exactly one of `fps` or `timestamps` is present. */
  fps?: number
  /** Seconds per frame, strictly increasing, length `frameCount`. */
  timestamps?: number[]
  /** Z-order of tracks, bottom to top. */
  trackOrder: ID[]
}

export type Source = ImageSource | VideoSource

// ---------- annotations ----------

export type ProvenanceSource = "manual" | { model: string; version?: string; confidence?: number }

export interface Provenance {
  createdBy?: string
  createdAt?: string
  updatedAt?: string
  source: ProvenanceSource
}

export interface AnnotationBase {
  id: ID
  rev: number
  sourceId: ID
  parentId?: ID
  classId?: ID
  tagIds: ID[]
  attributes: Record<string, AttributeValue>
  comment?: string
  status: string
  locked?: boolean
  hidden?: boolean
  provenance: Provenance
  meta: Meta
}

export interface Region extends AnnotationBase {
  geometry: Geometry
  /** Video sources only: the frame this region lives on. */
  frame?: number
}

export interface Keyframe {
  frame: number
  geometry: Geometry
  outside: boolean
  occluded: boolean
  /** How to reach the NEXT keyframe. */
  interpolation: "none" | "step" | "linear"
}

export interface Track extends AnnotationBase {
  geometryType: Exclude<GeometryType, "mask" | "custom">
  keyframes: Keyframe[]
}

// ---------- document ----------

export interface AnnotationDocument {
  id: ID
  /** `"major.minor"`. */
  schemaVersion: string
  rev: number
  config: Config
  sources: Record<ID, Source>
  sourceOrder: ID[]
  regions: Record<ID, Region>
  tracks: Record<ID, Track>
  meta: Meta
}
