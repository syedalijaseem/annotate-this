import {
  type GenericSchema,
  array,
  maxLength,
  boolean,
  exactOptional,
  looseObject,
  minLength,
  picklist,
  pipe,
  string,
  strictTuple,
} from "valibot"
import type { AttributeDef, ClassDef, Config, GeometryType, Skeleton, TagDef } from "../types.js"
import { BoxSchema, GeometryTypeSchema } from "./geometry.js"
import {
  MAX_LIST_LENGTH,
  AttributeValueSchema,
  ColorSchema,
  IdSchema,
  IntSchema,
  MetaSchema,
  NonNegativeSchema,
  NumSchema,
  RevSchema,
  TextSchema,
  safeRecord,
} from "./primitives.js"

/** Shared by the document schema and the operation patches, so both accept the same values. */
export const AllowedGeometrySchema: GenericSchema<unknown, GeometryType[]> = pipe(
  array(GeometryTypeSchema),
  maxLength(MAX_LIST_LENGTH),
)
export const ShortListSchema: GenericSchema<unknown, string[]> = pipe(
  array(TextSchema),
  maxLength(MAX_LIST_LENGTH),
)
export const StatusesSchema: GenericSchema<unknown, string[]> = pipe(
  array(TextSchema),
  minLength(1),
  maxLength(MAX_LIST_LENGTH),
)
export const SkeletonPointsSchema: GenericSchema<unknown, Skeleton["points"]> = pipe(
  array(looseObject({ name: TextSchema, color: exactOptional(ColorSchema) })),
  minLength(1),
)
export const EdgesSchema: GenericSchema<unknown, Skeleton["edges"]> = array(
  strictTuple([IntSchema, IntSchema]),
)

export const ClassDefSchema: GenericSchema<unknown, ClassDef> = looseObject({
  id: IdSchema,
  name: TextSchema,
  color: exactOptional(ColorSchema),
  parentId: exactOptional(IdSchema),
  allowedGeometry: exactOptional(AllowedGeometrySchema),
  attributeKeys: exactOptional(array(IdSchema)),
  hotkey: exactOptional(TextSchema),
  meta: MetaSchema,
})

export const TagDefSchema: GenericSchema<unknown, TagDef> = looseObject({
  id: IdSchema,
  name: TextSchema,
  color: exactOptional(ColorSchema),
  meta: MetaSchema,
})

export const AttributeDefSchema: GenericSchema<unknown, AttributeDef> = looseObject({
  key: IdSchema,
  label: TextSchema,
  required: exactOptional(boolean()),
  type: picklist(["string", "number", "boolean", "enum"] as const),
  options: exactOptional(ShortListSchema),
  min: exactOptional(NumSchema),
  max: exactOptional(NumSchema),
  default: exactOptional(AttributeValueSchema),
})

export const SkeletonSchema: GenericSchema<unknown, Skeleton> = looseObject({
  id: IdSchema,
  name: TextSchema,
  points: SkeletonPointsSchema,
  edges: EdgesSchema,
})

export const ConfigSchema: GenericSchema<unknown, Config> = looseObject({
  rev: RevSchema,
  taskDescription: exactOptional(string()),
  classes: safeRecord(ClassDefSchema),
  classOrder: array(IdSchema),
  tags: safeRecord(TagDefSchema),
  tagOrder: array(IdSchema),
  attributes: safeRecord(AttributeDefSchema),
  skeletons: safeRecord(SkeletonSchema),
  tools: exactOptional(ShortListSchema),
  allowedArea: exactOptional(BoxSchema),
  minRegionSize: exactOptional(NonNegativeSchema),
  statuses: exactOptional(StatusesSchema),
  meta: MetaSchema,
})

/** Statuses an annotation may have when the config does not list its own. */
export const DEFAULT_STATUSES: readonly string[] = ["draft", "submitted", "accepted", "rejected"]
