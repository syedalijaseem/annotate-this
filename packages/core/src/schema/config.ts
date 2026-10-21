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
import type { Config } from "../types.js"
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

const ClassDefSchema = looseObject({
  id: IdSchema,
  name: TextSchema,
  color: exactOptional(ColorSchema),
  parentId: exactOptional(IdSchema),
  allowedGeometry: exactOptional(pipe(array(GeometryTypeSchema), maxLength(MAX_LIST_LENGTH))),
  attributeKeys: exactOptional(array(IdSchema)),
  hotkey: exactOptional(TextSchema),
  meta: MetaSchema,
})

const TagDefSchema = looseObject({
  id: IdSchema,
  name: TextSchema,
  color: exactOptional(ColorSchema),
  meta: MetaSchema,
})

const AttributeDefSchema = looseObject({
  key: IdSchema,
  label: TextSchema,
  required: exactOptional(boolean()),
  type: picklist(["string", "number", "boolean", "enum"] as const),
  options: exactOptional(pipe(array(TextSchema), maxLength(MAX_LIST_LENGTH))),
  min: exactOptional(NumSchema),
  max: exactOptional(NumSchema),
  default: exactOptional(AttributeValueSchema),
})

const SkeletonSchema = looseObject({
  id: IdSchema,
  name: TextSchema,
  points: pipe(
    array(looseObject({ name: TextSchema, color: exactOptional(ColorSchema) })),
    minLength(1),
  ),
  edges: array(strictTuple([IntSchema, IntSchema])),
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
  tools: exactOptional(pipe(array(TextSchema), maxLength(MAX_LIST_LENGTH))),
  allowedArea: exactOptional(BoxSchema),
  minRegionSize: exactOptional(NonNegativeSchema),
  statuses: exactOptional(pipe(array(TextSchema), minLength(1), maxLength(MAX_LIST_LENGTH))),
  meta: MetaSchema,
})

/** Statuses an annotation may have when the config does not list its own. */
export const DEFAULT_STATUSES: readonly string[] = ["draft", "submitted", "accepted", "rejected"]
