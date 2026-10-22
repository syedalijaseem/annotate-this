import {
  type GenericSchema,
  array,
  boolean,
  exactOptional,
  lazy,
  literal,
  looseObject,
  maxValue,
  minLength,
  minValue,
  number,
  finite,
  picklist,
  pipe,
  string,
} from "valibot"
import type { Keyframe, Region, Track } from "../types.js"
import { GeometrySchema, TrackGeometryTypeSchema } from "./geometry.js"
import {
  AttributesSchema,
  IdSchema,
  IntSchema,
  MetaSchema,
  RevSchema,
  TextSchema,
  TimestampSchema,
  merge,
} from "./primitives.js"

const ModelSourceSchema = /* @__PURE__ */ looseObject({
  model: TextSchema,
  version: /* @__PURE__ */ exactOptional(TextSchema),
  confidence: /* @__PURE__ */ exactOptional(
    /* @__PURE__ */ pipe(
      /* @__PURE__ */ number(),
      /* @__PURE__ */ finite(),
      /* @__PURE__ */ minValue(0),
      /* @__PURE__ */ maxValue(1),
    ),
  ),
})
const ManualSourceSchema = /* @__PURE__ */ literal("manual")

const ProvenanceSchema = /* @__PURE__ */ looseObject({
  createdBy: /* @__PURE__ */ exactOptional(TextSchema),
  createdAt: /* @__PURE__ */ exactOptional(TimestampSchema),
  updatedAt: /* @__PURE__ */ exactOptional(TimestampSchema),
  // Chosen by input, not a union: a union would hide which field of the model source failed.
  source: /* @__PURE__ */ lazy((input) =>
    input === "manual" ? ManualSourceSchema : ModelSourceSchema,
  ),
})

/** Fields shared by regions and tracks (Spec 0001, AnnotationBase). */
const annotationEntries = {
  id: IdSchema,
  rev: RevSchema,
  sourceId: IdSchema,
  parentId: /* @__PURE__ */ exactOptional(IdSchema),
  classId: /* @__PURE__ */ exactOptional(IdSchema),
  tagIds: /* @__PURE__ */ array(IdSchema),
  attributes: AttributesSchema,
  comment: /* @__PURE__ */ exactOptional(TextSchema),
  status: /* @__PURE__ */ pipe(/* @__PURE__ */ string(), /* @__PURE__ */ minLength(1)),
  locked: /* @__PURE__ */ exactOptional(/* @__PURE__ */ boolean()),
  hidden: /* @__PURE__ */ exactOptional(/* @__PURE__ */ boolean()),
  provenance: ProvenanceSchema,
  meta: MetaSchema,
}

export const RegionSchema: GenericSchema<unknown, Region> = /* @__PURE__ */ looseObject(
  merge(annotationEntries, {
    geometry: GeometrySchema,
    frame: /* @__PURE__ */ exactOptional(IntSchema),
  }),
)

const KeyframeSchema: GenericSchema<unknown, Keyframe> = /* @__PURE__ */ looseObject({
  frame: IntSchema,
  geometry: GeometrySchema,
  outside: /* @__PURE__ */ boolean(),
  occluded: /* @__PURE__ */ boolean(),
  interpolation: /* @__PURE__ */ picklist(["none", "step", "linear"] as const),
})

export const TrackSchema: GenericSchema<unknown, Track> = /* @__PURE__ */ looseObject(
  merge(annotationEntries, {
    geometryType: TrackGeometryTypeSchema,
    keyframes: /* @__PURE__ */ pipe(
      /* @__PURE__ */ array(KeyframeSchema),
      /* @__PURE__ */ minLength(1),
    ),
  }),
)
