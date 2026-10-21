import {
  type GenericSchema,
  array,
  boolean,
  exactOptional,
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
  union,
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
} from "./primitives.js"

const ProvenanceSchema = looseObject({
  createdBy: exactOptional(TextSchema),
  createdAt: exactOptional(TimestampSchema),
  updatedAt: exactOptional(TimestampSchema),
  source: union([
    literal("manual"),
    looseObject({
      model: TextSchema,
      version: exactOptional(TextSchema),
      confidence: exactOptional(pipe(number(), finite(), minValue(0), maxValue(1))),
    }),
  ]),
})

/** Fields shared by regions and tracks (Spec 0001, AnnotationBase). */
const annotationEntries = {
  id: IdSchema,
  rev: RevSchema,
  sourceId: IdSchema,
  parentId: exactOptional(IdSchema),
  classId: exactOptional(IdSchema),
  tagIds: array(IdSchema),
  attributes: AttributesSchema,
  comment: exactOptional(TextSchema),
  status: pipe(string(), minLength(1)),
  locked: exactOptional(boolean()),
  hidden: exactOptional(boolean()),
  provenance: ProvenanceSchema,
  meta: MetaSchema,
}

export const RegionSchema: GenericSchema<unknown, Region> = looseObject({
  ...annotationEntries,
  geometry: GeometrySchema,
  frame: exactOptional(IntSchema),
})

const KeyframeSchema: GenericSchema<unknown, Keyframe> = looseObject({
  frame: IntSchema,
  geometry: GeometrySchema,
  outside: boolean(),
  occluded: boolean(),
  interpolation: picklist(["none", "step", "linear"] as const),
})

export const TrackSchema: GenericSchema<unknown, Track> = looseObject({
  ...annotationEntries,
  geometryType: TrackGeometryTypeSchema,
  keyframes: pipe(array(KeyframeSchema), minLength(1)),
})
