import {
  type GenericSchema,
  array,
  check,
  literal,
  looseObject,
  maxLength,
  minLength,
  pipe,
  picklist,
  string,
  unknown,
  variant,
} from "valibot"
import type { Geometry } from "../types.js"
import {
  IdSchema,
  IntSchema,
  JsonSchema,
  MAX_COORDINATES,
  MAX_CUSTOM_KIND_LENGTH,
  MAX_MASK_RUNS,
  NonNegativeSchema,
  NumSchema,
  PositiveIntSchema,
} from "./primitives.js"

/** Runs before the items are validated, so an enormous array is refused without walking it. */
const withinCoordinateCap = check(
  (value: unknown) => !Array.isArray(value) || value.length <= MAX_COORDINATES,
  "Too many coordinates",
)

const evenLength = (values: number[]) => values.length % 2 === 0

export const BoxSchema = looseObject({
  type: literal("box"),
  x: NumSchema,
  y: NumSchema,
  w: NonNegativeSchema,
  h: NonNegativeSchema,
})

const RotatedBoxSchema = looseObject({
  type: literal("rotatedBox"),
  cx: NumSchema,
  cy: NumSchema,
  w: NonNegativeSchema,
  h: NonNegativeSchema,
  angle: NumSchema,
})

const PointSchema = looseObject({
  type: literal("point"),
  x: NumSchema,
  y: NumSchema,
})

/** A flat coordinate list with an even length and at least `minPoints` points. */
const flatCoordinates = (minPoints: number) =>
  pipe(
    unknown(),
    withinCoordinateCap,
    array(NumSchema),
    check(evenLength, "Coordinates must come in x,y pairs"),
    minLength(minPoints * 2, `At least ${minPoints} points are required`),
  )

const PolygonSchema = looseObject({
  type: literal("polygon"),
  rings: pipe(array(flatCoordinates(3)), minLength(1)),
})

const PolylineSchema = looseObject({
  type: literal("polyline"),
  points: flatCoordinates(2),
})

const KeypointsSchema = looseObject({
  type: literal("keypoints"),
  skeletonId: IdSchema,
  points: pipe(
    unknown(),
    withinCoordinateCap,
    array(NumSchema),
    check(
      (values: number[]) => values.length % 3 === 0,
      "Keypoints come in x,y,visibility triples",
    ),
    check(
      (values: number[]) =>
        values.every((value, i) => i % 3 !== 2 || value === 0 || value === 1 || value === 2),
      "Visibility must be 0, 1 or 2",
    ),
  ),
})

const MaskSchema = looseObject({
  type: literal("mask"),
  x: NumSchema,
  y: NumSchema,
  width: PositiveIntSchema,
  height: PositiveIntSchema,
  counts: pipe(array(IntSchema), maxLength(MAX_MASK_RUNS)),
})

const CustomSchema = looseObject({
  type: literal("custom"),
  kind: pipe(
    string(),
    maxLength(MAX_CUSTOM_KIND_LENGTH),
    check(
      (value) => /^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/.test(value),
      'Custom kind must look like "vendor:name"',
    ),
  ),
  data: JsonSchema,
})

export const GeometrySchema: GenericSchema<unknown, Geometry> = variant("type", [
  BoxSchema,
  RotatedBoxSchema,
  PointSchema,
  PolygonSchema,
  PolylineSchema,
  KeypointsSchema,
  MaskSchema,
  CustomSchema,
])

export const GEOMETRY_TYPES = [
  "box",
  "rotatedBox",
  "point",
  "polygon",
  "polyline",
  "keypoints",
  "mask",
  "custom",
] as const
export const GeometryTypeSchema = picklist(GEOMETRY_TYPES)
export const TrackGeometryTypeSchema = picklist([
  "box",
  "rotatedBox",
  "point",
  "polygon",
  "polyline",
  "keypoints",
] as const)
