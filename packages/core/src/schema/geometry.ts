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
const withinCoordinateCap = /* @__PURE__ */ check(
  (value: unknown) => !Array.isArray(value) || value.length <= MAX_COORDINATES,
  "Too many coordinates",
)

/** Same for mask runs: the cap is checked before any run is validated. */
const withinMaskRunCap = /* @__PURE__ */ check(
  (value: unknown) => !Array.isArray(value) || value.length <= MAX_MASK_RUNS,
  "Too many mask runs",
)

const evenLength = (values: number[]) => values.length % 2 === 0

export const BoxSchema = /* @__PURE__ */ looseObject({
  type: /* @__PURE__ */ literal("box"),
  x: NumSchema,
  y: NumSchema,
  w: NonNegativeSchema,
  h: NonNegativeSchema,
})

const RotatedBoxSchema = /* @__PURE__ */ looseObject({
  type: /* @__PURE__ */ literal("rotatedBox"),
  cx: NumSchema,
  cy: NumSchema,
  w: NonNegativeSchema,
  h: NonNegativeSchema,
  angle: NumSchema,
})

const PointSchema = /* @__PURE__ */ looseObject({
  type: /* @__PURE__ */ literal("point"),
  x: NumSchema,
  y: NumSchema,
})

/** A flat coordinate list with an even length and at least `minPoints` points. */
/* @__NO_SIDE_EFFECTS__ */
function flatCoordinates(minPoints: number) {
  return /* @__PURE__ */ pipe(
    /* @__PURE__ */ unknown(),
    withinCoordinateCap,
    /* @__PURE__ */ array(NumSchema),
    /* @__PURE__ */ check(evenLength, "Coordinates must come in x,y pairs"),
    /* @__PURE__ */ minLength(minPoints * 2, `At least ${minPoints} points are required`),
  )
}

const PolygonSchema = /* @__PURE__ */ looseObject({
  type: /* @__PURE__ */ literal("polygon"),
  rings: /* @__PURE__ */ pipe(
    /* @__PURE__ */ array(flatCoordinates(3)),
    /* @__PURE__ */ minLength(1),
  ),
})

const PolylineSchema = /* @__PURE__ */ looseObject({
  type: /* @__PURE__ */ literal("polyline"),
  points: flatCoordinates(2),
})

const KeypointsSchema = /* @__PURE__ */ looseObject({
  type: /* @__PURE__ */ literal("keypoints"),
  skeletonId: IdSchema,
  points: /* @__PURE__ */ pipe(
    /* @__PURE__ */ unknown(),
    withinCoordinateCap,
    /* @__PURE__ */ array(NumSchema),
    /* @__PURE__ */ check(
      (values: number[]) => values.length % 3 === 0,
      "Keypoints come in x,y,visibility triples",
    ),
    /* @__PURE__ */ check(
      (values: number[]) =>
        values.every((value, i) => i % 3 !== 2 || value === 0 || value === 1 || value === 2),
      "Visibility must be 0, 1 or 2",
    ),
  ),
})

const MaskSchema = /* @__PURE__ */ looseObject({
  type: /* @__PURE__ */ literal("mask"),
  x: NumSchema,
  y: NumSchema,
  width: PositiveIntSchema,
  height: PositiveIntSchema,
  counts: /* @__PURE__ */ pipe(
    /* @__PURE__ */ unknown(),
    withinMaskRunCap,
    /* @__PURE__ */ array(IntSchema),
  ),
})

const CustomSchema = /* @__PURE__ */ looseObject({
  type: /* @__PURE__ */ literal("custom"),
  kind: /* @__PURE__ */ pipe(
    /* @__PURE__ */ string(),
    /* @__PURE__ */ maxLength(MAX_CUSTOM_KIND_LENGTH),
    /* @__PURE__ */ check(
      (value) => /^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/.test(value),
      'Custom kind must look like "vendor:name"',
    ),
  ),
  data: JsonSchema,
})

export const GeometrySchema: GenericSchema<unknown, Geometry> = /* @__PURE__ */ variant("type", [
  BoxSchema,
  RotatedBoxSchema,
  PointSchema,
  PolygonSchema,
  PolylineSchema,
  KeypointsSchema,
  MaskSchema,
  CustomSchema,
])

const GEOMETRY_TYPES = [
  "box",
  "rotatedBox",
  "point",
  "polygon",
  "polyline",
  "keypoints",
  "mask",
  "custom",
] as const
export const GeometryTypeSchema = /* @__PURE__ */ picklist(GEOMETRY_TYPES)
export const TrackGeometryTypeSchema = /* @__PURE__ */ picklist([
  "box",
  "rotatedBox",
  "point",
  "polygon",
  "polyline",
  "keypoints",
] as const)
