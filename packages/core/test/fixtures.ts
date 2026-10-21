import type { AnnotationDocument, ImageSource, Region, Track, VideoSource } from "../src/types.js"

const baseAnnotation = (id: string, sourceId: string) => ({
  id,
  rev: 0,
  sourceId,
  tagIds: [] as string[],
  attributes: {},
  status: "draft",
  provenance: { source: "manual" as const },
  meta: {},
})

export function box(id: string, sourceId = "s1", x = 10, y = 20, w = 100, h = 50): Region {
  return { ...baseAnnotation(id, sourceId), geometry: { type: "box", x, y, w, h } }
}

/** A valid image document with one region of every common geometry type. */
export function validDocument(): AnnotationDocument {
  const image: ImageSource = {
    kind: "image",
    id: "s1",
    rev: 0,
    name: "photo.jpg",
    uri: "https://example.com/photo.jpg",
    width: 1000,
    height: 800,
    regionOrder: ["r1", "r2", "r3", "r4", "r5"],
    tagIds: [],
    attributes: {},
    meta: {},
  }
  const regions: Record<string, Region> = {
    r1: {
      ...box("r1"),
      classId: "c1",
      tagIds: ["t1"],
      attributes: { occluded: false, score: 0.5 },
    },
    r2: {
      ...baseAnnotation("r2", "s1"),
      geometry: { type: "polygon", rings: [[100, 100, 200, 100, 200, 200, 100, 200]] },
    },
    r3: { ...baseAnnotation("r3", "s1"), geometry: { type: "point", x: 500, y: 400 } },
    r4: {
      ...baseAnnotation("r4", "s1"),
      geometry: { type: "keypoints", skeletonId: "k1", points: [10, 10, 2, 20, 20, 2, 30, 30, 1] },
    },
    r5: {
      ...baseAnnotation("r5", "s1"),
      geometry: { type: "mask", x: 0, y: 0, width: 4, height: 2, counts: [2, 3, 3] },
    },
  }
  return {
    id: "doc1",
    schemaVersion: "1.0",
    rev: 0,
    config: {
      rev: 0,
      classes: { c1: { id: "c1", name: "Alpha", color: "#336699", meta: {} } },
      classOrder: ["c1"],
      tags: { t1: { id: "t1", name: "blurry", meta: {} } },
      tagOrder: ["t1"],
      attributes: {
        occluded: { key: "occluded", label: "Occluded", type: "boolean" },
        score: { key: "score", label: "Score", type: "number", min: 0, max: 1 },
      },
      skeletons: {
        k1: {
          id: "k1",
          name: "Triangle",
          points: [{ name: "a" }, { name: "b" }, { name: "c" }],
          edges: [
            [0, 1],
            [1, 2],
          ],
        },
      },
      meta: {},
    },
    sources: { s1: image },
    sourceOrder: ["s1"],
    regions,
    tracks: {},
    meta: {},
  }
}

/** A valid video document with one single-frame region and one track. */
export function validVideoDocument(): AnnotationDocument {
  const doc = validDocument()
  const video: VideoSource = {
    kind: "video",
    id: "v1",
    rev: 0,
    name: "clip.mp4",
    uri: "https://example.com/clip.mp4",
    width: 640,
    height: 480,
    frameCount: 100,
    fps: 25,
    regionOrder: ["vr1"],
    trackOrder: ["tr1"],
    tagIds: [],
    attributes: {},
    meta: {},
  }
  const track: Track = {
    ...baseAnnotation("tr1", "v1"),
    geometryType: "box",
    keyframes: [
      {
        frame: 0,
        geometry: { type: "box", x: 10, y: 10, w: 50, h: 50 },
        outside: false,
        occluded: false,
        interpolation: "linear",
      },
      {
        frame: 50,
        geometry: { type: "box", x: 100, y: 100, w: 50, h: 50 },
        outside: false,
        occluded: false,
        interpolation: "none",
      },
    ],
  }
  return {
    ...doc,
    sources: { ...doc.sources, v1: video },
    sourceOrder: ["s1", "v1"],
    regions: { ...doc.regions, vr1: { ...box("vr1", "v1"), frame: 10 } },
    tracks: { tr1: track },
  }
}

/** Loosely typed view of a document, for tests that deliberately corrupt it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Loose = any

/** Deep clone through JSON, so tests can mutate freely. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Asserts a lookup succeeded, so tests need no non-null assertions. */
export function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null)
    throw new Error("expected a value but got " + String(value))
  return value
}
