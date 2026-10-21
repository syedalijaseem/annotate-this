import {
  type GenericSchema,
  array,
  exactOptional,
  literal,
  looseObject,
  minValue,
  number,
  finite,
  pipe,
  variant,
} from "valibot"
import type { Source } from "../types.js"
import { BoxSchema } from "./geometry.js"
import {
  AttributesSchema,
  IdSchema,
  MetaSchema,
  NonNegativeSchema,
  NumSchema,
  PositiveIntSchema,
  RevSchema,
  TextSchema,
} from "./primitives.js"

const sizeSchema = looseObject({ w: NonNegativeSchema, h: NonNegativeSchema })

const ScaleSchema = looseObject({
  pixelSize: exactOptional(sizeSchema),
  realSize: exactOptional(
    looseObject({ w: NonNegativeSchema, h: NonNegativeSchema, unit: TextSchema }),
  ),
})

const sourceEntries = {
  id: IdSchema,
  rev: RevSchema,
  name: TextSchema,
  uri: TextSchema,
  thumbnailUri: exactOptional(TextSchema),
  regionOrder: array(IdSchema),
  classId: exactOptional(IdSchema),
  tagIds: array(IdSchema),
  attributes: AttributesSchema,
  comment: exactOptional(TextSchema),
  allowedArea: exactOptional(BoxSchema),
  scale: exactOptional(ScaleSchema),
  meta: MetaSchema,
}

const ImageSourceSchema = looseObject({
  ...sourceEntries,
  kind: literal("image"),
  width: PositiveIntSchema,
  height: PositiveIntSchema,
})

const VideoSourceSchema = looseObject({
  ...sourceEntries,
  kind: literal("video"),
  width: PositiveIntSchema,
  height: PositiveIntSchema,
  frameCount: PositiveIntSchema,
  fps: exactOptional(pipe(number(), finite(), minValue(Number.EPSILON))),
  timestamps: exactOptional(array(pipe(NumSchema, minValue(0)))),
  trackOrder: array(IdSchema),
})

export const SourceSchema: GenericSchema<unknown, Source> = variant("kind", [
  ImageSourceSchema,
  VideoSourceSchema,
])
