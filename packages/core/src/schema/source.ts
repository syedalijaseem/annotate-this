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
import type { Source, SourceScale } from "../types.js"
import { BoxSchema } from "./geometry.js"
import {
  EPSILON,
  AttributesSchema,
  IdSchema,
  MetaSchema,
  NonNegativeSchema,
  NumSchema,
  PositiveIntSchema,
  RevSchema,
  TextSchema,
  merge,
} from "./primitives.js"

const sizeSchema = /* @__PURE__ */ looseObject({ w: NonNegativeSchema, h: NonNegativeSchema })

export const ScaleSchema: GenericSchema<unknown, SourceScale> = /* @__PURE__ */ looseObject({
  pixelSize: /* @__PURE__ */ exactOptional(sizeSchema),
  realSize: /* @__PURE__ */ exactOptional(
    /* @__PURE__ */ looseObject({ w: NonNegativeSchema, h: NonNegativeSchema, unit: TextSchema }),
  ),
})

const sourceEntries = {
  id: IdSchema,
  rev: RevSchema,
  name: TextSchema,
  uri: TextSchema,
  thumbnailUri: /* @__PURE__ */ exactOptional(TextSchema),
  regionOrder: /* @__PURE__ */ array(IdSchema),
  classId: /* @__PURE__ */ exactOptional(IdSchema),
  tagIds: /* @__PURE__ */ array(IdSchema),
  attributes: AttributesSchema,
  comment: /* @__PURE__ */ exactOptional(TextSchema),
  allowedArea: /* @__PURE__ */ exactOptional(BoxSchema),
  scale: /* @__PURE__ */ exactOptional(ScaleSchema),
  meta: MetaSchema,
}

const ImageSourceSchema = /* @__PURE__ */ looseObject(
  merge(sourceEntries, {
    kind: /* @__PURE__ */ literal("image"),
    width: PositiveIntSchema,
    height: PositiveIntSchema,
  }),
)

const VideoSourceSchema = /* @__PURE__ */ looseObject(
  merge(sourceEntries, {
    kind: /* @__PURE__ */ literal("video"),
    width: PositiveIntSchema,
    height: PositiveIntSchema,
    frameCount: PositiveIntSchema,
    fps: /* @__PURE__ */ exactOptional(
      /* @__PURE__ */ pipe(
        /* @__PURE__ */ number(),
        /* @__PURE__ */ finite(),
        /* @__PURE__ */ minValue(EPSILON),
      ),
    ),
    timestamps: /* @__PURE__ */ exactOptional(
      /* @__PURE__ */ array(/* @__PURE__ */ pipe(NumSchema, /* @__PURE__ */ minValue(0))),
    ),
    trackOrder: /* @__PURE__ */ array(IdSchema),
  }),
)

export const SourceSchema: GenericSchema<unknown, Source> = /* @__PURE__ */ variant("kind", [
  ImageSourceSchema,
  VideoSourceSchema,
])
