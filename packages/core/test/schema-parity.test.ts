import { describe, expect, it } from "vitest"
import { ConfigSchema } from "../src/schema/config.js"
import { DocumentSchema } from "../src/schema/document.js"
import { RegionSchema, TrackSchema } from "../src/schema/annotation.js"
import { GeometrySchema } from "../src/schema/geometry.js"
import { SourceSchema } from "../src/schema/source.js"
import type {
  AnnotationDocument,
  Config,
  Geometry,
  ImageSource,
  Region,
  Track,
  VideoSource,
} from "../src/types.js"

// The schemas are annotated with the public types, which only checks one
// direction. These key tables are exhaustive in the other direction: adding or
// removing a field on a type fails to compile until the table (and so the
// schema, checked below) is updated.
const documentKeys = {
  id: 1,
  schemaVersion: 1,
  rev: 1,
  config: 1,
  sources: 1,
  sourceOrder: 1,
  regions: 1,
  tracks: 1,
  meta: 1,
} satisfies Record<keyof AnnotationDocument, 1>
const configKeys = {
  rev: 1,
  taskDescription: 1,
  classes: 1,
  classOrder: 1,
  tags: 1,
  tagOrder: 1,
  attributes: 1,
  skeletons: 1,
  tools: 1,
  allowedArea: 1,
  minRegionSize: 1,
  statuses: 1,
  meta: 1,
} satisfies Record<keyof Config, 1>
const regionKeys = {
  id: 1,
  rev: 1,
  sourceId: 1,
  classId: 1,
  tagIds: 1,
  attributes: 1,
  parentId: 1,
  status: 1,
  comment: 1,
  provenance: 1,
  meta: 1,
  geometry: 1,
  frame: 1,
  locked: 1,
  hidden: 1,
} satisfies Record<keyof Region, 1>
const trackKeys = {
  id: 1,
  rev: 1,
  sourceId: 1,
  classId: 1,
  tagIds: 1,
  attributes: 1,
  parentId: 1,
  status: 1,
  comment: 1,
  provenance: 1,
  meta: 1,
  geometryType: 1,
  keyframes: 1,
  locked: 1,
  hidden: 1,
} satisfies Record<keyof Track, 1>
const imageKeys = {
  kind: 1,
  id: 1,
  rev: 1,
  name: 1,
  uri: 1,
  thumbnailUri: 1,
  regionOrder: 1,
  classId: 1,
  tagIds: 1,
  attributes: 1,
  comment: 1,
  scale: 1,
  allowedArea: 1,
  meta: 1,
  width: 1,
  height: 1,
} satisfies Record<keyof ImageSource, 1>
const videoKeys = {
  ...imageKeys,
  frameCount: 1,
  fps: 1,
  timestamps: 1,
  trackOrder: 1,
} satisfies Record<keyof VideoSource, 1>

type Entries = { entries: Record<string, unknown> }
const keysOf = (schema: unknown) => Object.keys((schema as Entries).entries).sort()
const sorted = (table: object) => Object.keys(table).sort()
const optionsOf = (schema: unknown) => (schema as { options: unknown[] }).options

describe("schemas cover every field of the public types", () => {
  it.each([
    ["document", DocumentSchema, documentKeys],
    ["config", ConfigSchema, configKeys],
    ["region", RegionSchema, regionKeys],
    ["track", TrackSchema, trackKeys],
  ])("%s", (_name, schema, table) => {
    expect(keysOf(schema)).toEqual(sorted(table))
  })

  it("image and video sources", () => {
    const [image, video] = optionsOf(SourceSchema)
    expect(keysOf(image)).toEqual(sorted(imageKeys))
    expect(keysOf(video)).toEqual(sorted(videoKeys))
  })

  it("every geometry type has a schema", () => {
    const types: Record<Geometry["type"], 1> = {
      box: 1,
      rotatedBox: 1,
      point: 1,
      polygon: 1,
      polyline: 1,
      keypoints: 1,
      mask: 1,
      custom: 1,
    }
    const schemaTypes = optionsOf(GeometrySchema).map(
      (option) => ((option as Entries).entries.type as { literal: string }).literal,
    )
    expect(schemaTypes.sort()).toEqual(sorted(types))
  })
})
