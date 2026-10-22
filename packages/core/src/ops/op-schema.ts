import {
  type GenericSchema,
  array,
  boolean,
  check,
  exactOptional,
  getDotPath,
  literal,
  looseObject,
  minLength,
  nullable,
  picklist,
  pipe,
  safeParse,
  strictObject,
  string,
  union,
  unknown,
  variant,
} from "valibot"
import { AnnotateError } from "../errors.js"
import {
  AllowedGeometrySchema,
  AttributeDefSchema,
  ClassDefSchema,
  EdgesSchema,
  ShortListSchema,
  SkeletonPointsSchema,
  SkeletonSchema,
  StatusesSchema,
  TagDefSchema,
} from "../schema/config.js"
import { BoxSchema } from "../schema/geometry.js"
import {
  AttributeValueSchema,
  ColorSchema,
  IdSchema,
  IntSchema,
  MetaSchema,
  NonNegativeSchema,
  TextSchema,
  safeRecord,
} from "../schema/primitives.js"
import { ScaleSchema } from "../schema/source.js"
import { clip } from "../validate/issues.js"
import type { Operation } from "./types.js"

// valibot's object schemas accept arrays; operation payload objects must not be arrays.
const notArray = check((value: unknown) => !Array.isArray(value), "Expected an object")

const PositionSchema = union([
  picklist(["top", "bottom"] as const),
  pipe(unknown(), notArray, strictObject({ after: IdSchema })),
])

const clearable = <T>(schema: GenericSchema<unknown, T>) => exactOptional(nullable(schema))

const patchOf = (entries: Parameters<typeof strictObject>[0]) =>
  pipe(unknown(), notArray, strictObject(entries))

const AttributesPatchSchema = exactOptional(safeRecord(nullable(AttributeValueSchema)))

// Spec 0002: the patchable fields of each entity. Anything else is rejected, not ignored.
const RegionPatchSchema = patchOf({
  classId: clearable(IdSchema),
  tagIds: exactOptional(array(IdSchema)),
  attributes: AttributesPatchSchema,
  comment: clearable(TextSchema),
  status: exactOptional(pipe(string(), minLength(1))),
  locked: clearable(boolean()),
  hidden: clearable(boolean()),
  parentId: clearable(IdSchema),
  frame: clearable(IntSchema),
  meta: exactOptional(MetaSchema),
})

const ConfigPatchSchema = patchOf({
  taskDescription: clearable(string()),
  tools: clearable(ShortListSchema),
  allowedArea: clearable(BoxSchema),
  minRegionSize: clearable(NonNegativeSchema),
  statuses: clearable(StatusesSchema),
  meta: exactOptional(MetaSchema),
})

// Fields classes and tags share.
const labelPatch = {
  name: exactOptional(TextSchema),
  color: clearable(ColorSchema),
  meta: exactOptional(MetaSchema),
}

const TagPatchSchema = patchOf(labelPatch)

const ClassPatchSchema = patchOf({
  ...labelPatch,
  parentId: clearable(IdSchema),
  allowedGeometry: clearable(AllowedGeometrySchema),
  attributeKeys: clearable(array(IdSchema)),
  hotkey: clearable(TextSchema),
})

const SkeletonPatchSchema = patchOf({
  name: exactOptional(TextSchema),
  points: exactOptional(SkeletonPointsSchema),
  edges: exactOptional(EdgesSchema),
})

const SourcePatchSchema = patchOf({
  name: exactOptional(TextSchema),
  uri: exactOptional(TextSchema),
  thumbnailUri: clearable(TextSchema),
  classId: clearable(IdSchema),
  tagIds: exactOptional(array(IdSchema)),
  attributes: AttributesPatchSchema,
  comment: clearable(TextSchema),
  allowedArea: clearable(BoxSchema),
  scale: clearable(ScaleSchema),
  meta: exactOptional(MetaSchema),
})

const OnInUseSchema = picklist(["reject", "detach"] as const)
const ChildrenSchema = picklist(["delete", "detach"] as const)

// An entity payload: any plain object here; the handler parses it with the document schema.
const EntitySchema = pipe(unknown(), notArray, looseObject({}))

const base = { id: IdSchema, baseRev: exactOptional(IntSchema) }

const op = <T extends string, E extends Parameters<typeof strictObject>[0]>(type: T, entries: E) =>
  strictObject({ ...base, type: literal(type), ...entries })

const position = exactOptional(PositionSchema)

// Shapes of operation payloads. Region and source payloads are only required
// here: their handlers parse them with the document schemas (after applying
// defaults such as rev 0), so the error codes match whole-document validation.
const OperationSchema = variant("type", [
  op("setDocumentMeta", { patch: MetaSchema }),
  op("createRegion", { region: EntitySchema, position }),
  op("createRegions", {
    regions: pipe(array(EntitySchema), minLength(1)),
    positions: exactOptional(array(PositionSchema)),
  }),
  op("setGeometry", { regionId: IdSchema, geometry: unknown() }),
  op("patchRegion", { regionId: IdSchema, patch: RegionPatchSchema }),
  op("deleteRegion", { regionId: IdSchema, children: ChildrenSchema }),
  op("deleteRegions", { regionIds: pipe(array(IdSchema), minLength(1)), children: ChildrenSchema }),
  op("reorderRegion", { regionId: IdSchema, position: PositionSchema }),
  op("moveRegionToSource", { regionId: IdSchema, sourceId: IdSchema, position }),
  op("setConfig", { patch: ConfigPatchSchema }),
  op("addClass", { def: pipe(unknown(), notArray, ClassDefSchema), position }),
  op("updateClass", { classId: IdSchema, patch: ClassPatchSchema }),
  op("removeClass", { classId: IdSchema, onInUse: OnInUseSchema }),
  op("reorderClass", { classId: IdSchema, position: PositionSchema }),
  op("addTag", { def: pipe(unknown(), notArray, TagDefSchema), position }),
  op("updateTag", { tagId: IdSchema, patch: TagPatchSchema }),
  op("removeTag", { tagId: IdSchema, onInUse: OnInUseSchema }),
  op("reorderTag", { tagId: IdSchema, position: PositionSchema }),
  op("setAttributeDef", { def: pipe(unknown(), notArray, AttributeDefSchema) }),
  op("removeAttributeDef", { key: IdSchema, onInUse: OnInUseSchema }),
  op("addSkeleton", { def: pipe(unknown(), notArray, SkeletonSchema) }),
  op("updateSkeleton", { skeletonId: IdSchema, patch: SkeletonPatchSchema }),
  op("removeSkeleton", { skeletonId: IdSchema }),
  op("addSource", { source: EntitySchema, position }),
  op("updateSource", { sourceId: IdSchema, patch: SourcePatchSchema }),
  op("removeSource", { sourceId: IdSchema }),
  op("reorderSource", { sourceId: IdSchema, position: PositionSchema }),
])

const TYPES: ReadonlySet<unknown> = new Set(
  OperationSchema.options.map((o) => o.entries.type.literal),
)

// Parses a snapshot (see snapshot.ts) into an operation; the output shares nothing with the input's caller.
export function parseOperation(input: unknown): Operation {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new AnnotateError("INVALID_DOCUMENT", "operation: expected an object")
  }
  const type = (input as { type?: unknown }).type
  if (!TYPES.has(type)) {
    throw new AnnotateError("INVALID_DOCUMENT", `operation: unknown type "${clip(String(type))}"`)
  }
  const parsed = safeParse(OperationSchema, input, { abortEarly: true })
  if (parsed.success) return parsed.output as Operation
  const first = parsed.issues[0]
  const path = first ? getDotPath(first) : null
  const message = clip(first?.message ?? "invalid payload", 120)
  throw new AnnotateError(
    "INVALID_DOCUMENT",
    `operation${path ? `.${clip(path)}` : ""}: ${message}`,
  )
}
