import {
  type GenericSchema,
  type ObjectEntries,
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
  merge,
  safeRecord,
} from "../schema/primitives.js"
import { ScaleSchema } from "../schema/source.js"
import { clip } from "../validate/issues.js"
import type {
  AttributesPatch,
  ClassPatch,
  ConfigPatch,
  Operation,
  OperationType,
  Position,
  RegionPatch,
  SkeletonPatch,
  SourcePatch,
  TagPatch,
} from "./types.js"

// valibot's object schemas accept arrays; operation payload objects must not be arrays.
const notArray = /* @__PURE__ */ check(
  (value: unknown) => !Array.isArray(value),
  "Expected an object",
)

const PositionSchema: GenericSchema<unknown, Position> = /* @__PURE__ */ union([
  /* @__PURE__ */ picklist(["top", "bottom"] as const),
  /* @__PURE__ */ pipe(
    /* @__PURE__ */ unknown(),
    notArray,
    /* @__PURE__ */ strictObject({ after: IdSchema }),
  ),
])

/* @__NO_SIDE_EFFECTS__ */
const clearable = <T>(schema: GenericSchema<unknown, T>) =>
  /* @__PURE__ */ exactOptional(/* @__PURE__ */ nullable(schema))

// A patch schema whose fields are exactly those of patch interface T: a
// missing or extra field fails to compile, and the annotation on each schema
// below makes a mistyped field fail too.
/* @__NO_SIDE_EFFECTS__ */
const patchOf =
  <T>() =>
  <E extends ObjectEntries & Record<keyof T, unknown>>(
    entries: E & Record<Exclude<keyof E, keyof T>, never>,
  ) =>
    /* @__PURE__ */ pipe(/* @__PURE__ */ unknown(), notArray, /* @__PURE__ */ strictObject(entries))

const AttributesPatchSchema = /* @__PURE__ */ exactOptional(
  safeRecord(/* @__PURE__ */ nullable(AttributeValueSchema)) as GenericSchema<
    unknown,
    AttributesPatch
  >,
)

// Spec 0002: the patchable fields of each entity. Anything else is rejected, not ignored.
const RegionPatchSchema: GenericSchema<unknown, RegionPatch> =
  /* @__PURE__ */ patchOf<RegionPatch>()({
    classId: clearable(IdSchema),
    tagIds: /* @__PURE__ */ exactOptional(/* @__PURE__ */ array(IdSchema)),
    attributes: AttributesPatchSchema,
    comment: clearable(TextSchema),
    status: /* @__PURE__ */ exactOptional(
      /* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ minLength(1)),
    ),
    locked: clearable(/* @__PURE__ */ boolean()),
    hidden: clearable(/* @__PURE__ */ boolean()),
    parentId: clearable(IdSchema),
    frame: clearable(IntSchema),
    meta: /* @__PURE__ */ exactOptional(MetaSchema),
  })

const ConfigPatchSchema: GenericSchema<unknown, ConfigPatch> =
  /* @__PURE__ */ patchOf<ConfigPatch>()({
    taskDescription: clearable(/* @__PURE__ */ string()),
    tools: clearable(ShortListSchema),
    allowedArea: clearable(BoxSchema),
    minRegionSize: clearable(NonNegativeSchema),
    statuses: clearable(StatusesSchema),
    meta: /* @__PURE__ */ exactOptional(MetaSchema),
  })

// Fields classes and tags share.
const labelPatch = {
  name: /* @__PURE__ */ exactOptional(TextSchema),
  color: clearable(ColorSchema),
  meta: /* @__PURE__ */ exactOptional(MetaSchema),
}

const TagPatchSchema: GenericSchema<unknown, TagPatch> =
  /* @__PURE__ */ patchOf<TagPatch>()(labelPatch)

const ClassPatchSchema: GenericSchema<unknown, ClassPatch> = /* @__PURE__ */ patchOf<ClassPatch>()(
  merge(labelPatch, {
    parentId: clearable(IdSchema),
    allowedGeometry: clearable(AllowedGeometrySchema),
    attributeKeys: clearable(/* @__PURE__ */ array(IdSchema)),
    hotkey: clearable(TextSchema),
  }),
)

const SkeletonPatchSchema: GenericSchema<unknown, SkeletonPatch> =
  /* @__PURE__ */ patchOf<SkeletonPatch>()({
    name: /* @__PURE__ */ exactOptional(TextSchema),
    points: /* @__PURE__ */ exactOptional(SkeletonPointsSchema),
    edges: /* @__PURE__ */ exactOptional(EdgesSchema),
  })

const SourcePatchSchema: GenericSchema<unknown, SourcePatch> =
  /* @__PURE__ */ patchOf<SourcePatch>()({
    name: /* @__PURE__ */ exactOptional(TextSchema),
    uri: /* @__PURE__ */ exactOptional(TextSchema),
    thumbnailUri: clearable(TextSchema),
    classId: clearable(IdSchema),
    tagIds: /* @__PURE__ */ exactOptional(/* @__PURE__ */ array(IdSchema)),
    attributes: AttributesPatchSchema,
    comment: clearable(TextSchema),
    allowedArea: clearable(BoxSchema),
    scale: clearable(ScaleSchema),
    meta: /* @__PURE__ */ exactOptional(MetaSchema),
  })

const OnInUseSchema = /* @__PURE__ */ picklist(["reject", "detach"] as const)
const ChildrenSchema = /* @__PURE__ */ picklist(["delete", "detach"] as const)

// An entity payload: any plain object here; the handler parses it with the document schema.
const EntitySchema = /* @__PURE__ */ pipe(
  /* @__PURE__ */ unknown(),
  notArray,
  /* @__PURE__ */ looseObject({}),
)

const base = { id: IdSchema, baseRev: /* @__PURE__ */ exactOptional(IntSchema) }

/* @__NO_SIDE_EFFECTS__ */
const op = <T extends OperationType, E extends ObjectEntries>(type: T, entries: E) =>
  /* @__PURE__ */ strictObject({ ...base, type: /* @__PURE__ */ literal(type), ...entries })

const position = /* @__PURE__ */ exactOptional(PositionSchema)

// Shapes of operation payloads. Region and source payloads are only required
// here: their handlers parse them with the document schemas (after applying
// defaults such as rev 0), so the error codes match whole-document validation.
// That is also why the parsed output is cast to Operation below: entity
// payloads are typed by the handlers' parse, not by this schema.
const OPERATION_SCHEMAS = {
  setDocumentMeta: op("setDocumentMeta", { patch: MetaSchema }),
  createRegion: op("createRegion", { region: EntitySchema, position }),
  createRegions: op("createRegions", {
    regions: /* @__PURE__ */ pipe(
      /* @__PURE__ */ array(EntitySchema),
      /* @__PURE__ */ minLength(1),
    ),
    positions: /* @__PURE__ */ exactOptional(/* @__PURE__ */ array(PositionSchema)),
  }),
  setGeometry: op("setGeometry", { regionId: IdSchema, geometry: /* @__PURE__ */ unknown() }),
  patchRegion: op("patchRegion", { regionId: IdSchema, patch: RegionPatchSchema }),
  deleteRegion: op("deleteRegion", { regionId: IdSchema, children: ChildrenSchema }),
  deleteRegions: op("deleteRegions", {
    regionIds: /* @__PURE__ */ pipe(/* @__PURE__ */ array(IdSchema), /* @__PURE__ */ minLength(1)),
    children: ChildrenSchema,
  }),
  reorderRegion: op("reorderRegion", { regionId: IdSchema, position: PositionSchema }),
  moveRegionToSource: op("moveRegionToSource", {
    regionId: IdSchema,
    sourceId: IdSchema,
    position,
  }),
  setConfig: op("setConfig", { patch: ConfigPatchSchema }),
  addClass: op("addClass", {
    def: /* @__PURE__ */ pipe(/* @__PURE__ */ unknown(), notArray, ClassDefSchema),
    position,
  }),
  updateClass: op("updateClass", { classId: IdSchema, patch: ClassPatchSchema }),
  removeClass: op("removeClass", { classId: IdSchema, onInUse: OnInUseSchema }),
  reorderClass: op("reorderClass", { classId: IdSchema, position: PositionSchema }),
  addTag: op("addTag", {
    def: /* @__PURE__ */ pipe(/* @__PURE__ */ unknown(), notArray, TagDefSchema),
    position,
  }),
  updateTag: op("updateTag", { tagId: IdSchema, patch: TagPatchSchema }),
  removeTag: op("removeTag", { tagId: IdSchema, onInUse: OnInUseSchema }),
  reorderTag: op("reorderTag", { tagId: IdSchema, position: PositionSchema }),
  setAttributeDef: op("setAttributeDef", {
    def: /* @__PURE__ */ pipe(/* @__PURE__ */ unknown(), notArray, AttributeDefSchema),
  }),
  removeAttributeDef: op("removeAttributeDef", { key: IdSchema, onInUse: OnInUseSchema }),
  addSkeleton: op("addSkeleton", {
    def: /* @__PURE__ */ pipe(/* @__PURE__ */ unknown(), notArray, SkeletonSchema),
  }),
  updateSkeleton: op("updateSkeleton", { skeletonId: IdSchema, patch: SkeletonPatchSchema }),
  removeSkeleton: op("removeSkeleton", { skeletonId: IdSchema }),
  addSource: op("addSource", { source: EntitySchema, position }),
  updateSource: op("updateSource", { sourceId: IdSchema, patch: SourcePatchSchema }),
  removeSource: op("removeSource", { sourceId: IdSchema }),
  reorderSource: op("reorderSource", { sourceId: IdSchema, position: PositionSchema }),
} satisfies Record<OperationType, ReturnType<typeof op>>
// Exhaustive over OperationType: an operation type without a schema, or a
// schema without an operation type, fails to compile.

const OperationSchema = /* @__PURE__ */ variant(
  "type",
  /* @__PURE__ */ Object.values(OPERATION_SCHEMAS),
)

const TYPES: ReadonlySet<unknown> = /* @__PURE__ */ new Set(
  /* @__PURE__ */ Object.keys(OPERATION_SCHEMAS),
)

/** The operation types parseOperation knows (for parity tests). */
export const OPERATION_TYPES: readonly string[] = /* @__PURE__ */ Object.freeze(
  /* @__PURE__ */ Object.keys(OPERATION_SCHEMAS),
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
