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
export const AllowedGeometrySchema: GenericSchema<unknown, GeometryType[]> = /* @__PURE__ */ pipe(
  /* @__PURE__ */ array(GeometryTypeSchema),
  /* @__PURE__ */ maxLength(MAX_LIST_LENGTH),
)
export const ShortListSchema: GenericSchema<unknown, string[]> = /* @__PURE__ */ pipe(
  /* @__PURE__ */ array(TextSchema),
  /* @__PURE__ */ maxLength(MAX_LIST_LENGTH),
)
export const StatusesSchema: GenericSchema<unknown, string[]> = /* @__PURE__ */ pipe(
  /* @__PURE__ */ array(TextSchema),
  /* @__PURE__ */ minLength(1),
  /* @__PURE__ */ maxLength(MAX_LIST_LENGTH),
)
export const SkeletonPointsSchema: GenericSchema<unknown, Skeleton["points"]> =
  /* @__PURE__ */ pipe(
    /* @__PURE__ */ array(
      /* @__PURE__ */ looseObject({
        name: TextSchema,
        color: /* @__PURE__ */ exactOptional(ColorSchema),
      }),
    ),
    /* @__PURE__ */ minLength(1),
  )
export const EdgesSchema: GenericSchema<unknown, Skeleton["edges"]> = /* @__PURE__ */ array(
  /* @__PURE__ */ strictTuple([IntSchema, IntSchema]),
)

export const ClassDefSchema: GenericSchema<unknown, ClassDef> = /* @__PURE__ */ looseObject({
  id: IdSchema,
  name: TextSchema,
  color: /* @__PURE__ */ exactOptional(ColorSchema),
  parentId: /* @__PURE__ */ exactOptional(IdSchema),
  allowedGeometry: /* @__PURE__ */ exactOptional(AllowedGeometrySchema),
  attributeKeys: /* @__PURE__ */ exactOptional(/* @__PURE__ */ array(IdSchema)),
  hotkey: /* @__PURE__ */ exactOptional(TextSchema),
  meta: MetaSchema,
})

export const TagDefSchema: GenericSchema<unknown, TagDef> = /* @__PURE__ */ looseObject({
  id: IdSchema,
  name: TextSchema,
  color: /* @__PURE__ */ exactOptional(ColorSchema),
  meta: MetaSchema,
})

export const AttributeDefSchema: GenericSchema<unknown, AttributeDef> = /* @__PURE__ */ looseObject(
  {
    key: IdSchema,
    label: TextSchema,
    required: /* @__PURE__ */ exactOptional(/* @__PURE__ */ boolean()),
    type: /* @__PURE__ */ picklist(["string", "number", "boolean", "enum"] as const),
    options: /* @__PURE__ */ exactOptional(ShortListSchema),
    min: /* @__PURE__ */ exactOptional(NumSchema),
    max: /* @__PURE__ */ exactOptional(NumSchema),
    default: /* @__PURE__ */ exactOptional(AttributeValueSchema),
  },
)

export const SkeletonSchema: GenericSchema<unknown, Skeleton> = /* @__PURE__ */ looseObject({
  id: IdSchema,
  name: TextSchema,
  points: SkeletonPointsSchema,
  edges: EdgesSchema,
})

export const ConfigSchema: GenericSchema<unknown, Config> = /* @__PURE__ */ looseObject({
  rev: RevSchema,
  taskDescription: /* @__PURE__ */ exactOptional(/* @__PURE__ */ string()),
  classes: safeRecord(ClassDefSchema),
  classOrder: /* @__PURE__ */ array(IdSchema),
  tags: safeRecord(TagDefSchema),
  tagOrder: /* @__PURE__ */ array(IdSchema),
  attributes: safeRecord(AttributeDefSchema),
  skeletons: safeRecord(SkeletonSchema),
  tools: /* @__PURE__ */ exactOptional(ShortListSchema),
  allowedArea: /* @__PURE__ */ exactOptional(BoxSchema),
  minRegionSize: /* @__PURE__ */ exactOptional(NonNegativeSchema),
  statuses: /* @__PURE__ */ exactOptional(StatusesSchema),
  meta: MetaSchema,
})

/** Statuses an annotation may have when the config does not list its own. */
export const DEFAULT_STATUSES: readonly string[] = /* @__PURE__ */ Object.freeze([
  "draft",
  "submitted",
  "accepted",
  "rejected",
])
