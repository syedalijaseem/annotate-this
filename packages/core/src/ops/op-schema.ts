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
  AttributeValueSchema,
  IdSchema,
  IntSchema,
  MetaSchema,
  TextSchema,
  safeRecord,
} from "../schema/primitives.js"
import { clip } from "../validate/issues.js"
import type { Operation } from "./types.js"

// valibot's object schemas accept arrays; operation payload objects must not be arrays.
const notArray = check((value: unknown) => !Array.isArray(value), "Expected an object")

const PositionSchema = union([
  picklist(["top", "bottom"] as const),
  pipe(unknown(), notArray, strictObject({ after: IdSchema })),
])

const clearable = <T>(schema: GenericSchema<unknown, T>) => exactOptional(nullable(schema))

// Spec 0002: the patchable region fields. Anything else is rejected, not ignored.
const RegionPatchSchema = pipe(
  unknown(),
  notArray,
  strictObject({
    classId: clearable(IdSchema),
    tagIds: exactOptional(array(IdSchema)),
    attributes: exactOptional(safeRecord(nullable(AttributeValueSchema))),
    comment: clearable(TextSchema),
    status: exactOptional(pipe(string(), minLength(1))),
    locked: clearable(boolean()),
    hidden: clearable(boolean()),
    parentId: clearable(IdSchema),
    frame: clearable(IntSchema),
    meta: exactOptional(MetaSchema),
  }),
)

const base = { id: IdSchema, baseRev: exactOptional(IntSchema) }

// Shapes of operation payloads. Entity payloads (`region`, `geometry`) are only
// required here: their handlers parse them with the document schemas, so the
// error codes match whole-document validation.
const OperationSchema = variant("type", [
  strictObject({ ...base, type: literal("setDocumentMeta"), patch: MetaSchema }),
  strictObject({
    ...base,
    type: literal("createRegion"),
    region: pipe(unknown(), notArray, looseObject({})),
    position: exactOptional(PositionSchema),
  }),
  strictObject({ ...base, type: literal("setGeometry"), regionId: IdSchema, geometry: unknown() }),
  strictObject({
    ...base,
    type: literal("patchRegion"),
    regionId: IdSchema,
    patch: RegionPatchSchema,
  }),
  strictObject({
    ...base,
    type: literal("deleteRegion"),
    regionId: IdSchema,
    children: picklist(["delete", "detach"] as const),
  }),
  strictObject({
    ...base,
    type: literal("reorderRegion"),
    regionId: IdSchema,
    position: PositionSchema,
  }),
  strictObject({
    ...base,
    type: literal("moveRegionToSource"),
    regionId: IdSchema,
    sourceId: IdSchema,
    position: exactOptional(PositionSchema),
  }),
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
