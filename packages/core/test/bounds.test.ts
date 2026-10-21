import { describe, expect, it } from "vitest"
import { boundsWithin, geometryBounds, vertexCount } from "../src/geometry/bounds.js"
import { must } from "./fixtures.js"

describe("geometryBounds", () => {
  it("box", () => {
    expect(geometryBounds({ type: "box", x: 10, y: 20, w: 30, h: 40 })).toEqual({
      minX: 10,
      minY: 20,
      maxX: 40,
      maxY: 60,
    })
  })

  it("point", () => {
    expect(geometryBounds({ type: "point", x: 5, y: 6 })).toEqual({
      minX: 5,
      minY: 6,
      maxX: 5,
      maxY: 6,
    })
  })

  it("polygon uses all rings", () => {
    expect(
      geometryBounds({
        type: "polygon",
        rings: [
          [0, 0, 10, 0, 10, 10],
          [50, 50, 60, 50, 60, 60],
        ],
      }),
    ).toEqual({
      minX: 0,
      minY: 0,
      maxX: 60,
      maxY: 60,
    })
  })

  it("polyline", () => {
    expect(geometryBounds({ type: "polyline", points: [1, 2, 3, -4] })).toEqual({
      minX: 1,
      minY: -4,
      maxX: 3,
      maxY: 2,
    })
  })

  it("rotated box at 90 degrees swaps width and height", () => {
    const b = must(
      geometryBounds({
        type: "rotatedBox",
        cx: 100,
        cy: 100,
        w: 40,
        h: 20,
        angle: Math.PI / 2,
      }),
    )
    expect(b.minX).toBeCloseTo(90)
    expect(b.maxX).toBeCloseTo(110)
    expect(b.minY).toBeCloseTo(80)
    expect(b.maxY).toBeCloseTo(120)
  })

  it("rotated box at 45 degrees grows the axis-aligned bounds", () => {
    const b = must(
      geometryBounds({
        type: "rotatedBox",
        cx: 0,
        cy: 0,
        w: 10,
        h: 10,
        angle: Math.PI / 4,
      }),
    )
    expect(b.maxX).toBeCloseTo(Math.SQRT2 * 5)
    expect(b.minX).toBeCloseTo(-Math.SQRT2 * 5)
  })

  it("keypoints ignore unlabeled points (visibility 0)", () => {
    expect(
      geometryBounds({
        type: "keypoints",
        skeletonId: "k",
        points: [10, 10, 2, 0, 0, 0, 30, 40, 1],
      }),
    ).toEqual({
      minX: 10,
      minY: 10,
      maxX: 30,
      maxY: 40,
    })
  })

  it("keypoints that are all unlabeled have no bounds", () => {
    expect(geometryBounds({ type: "keypoints", skeletonId: "k", points: [0, 0, 0] })).toBeNull()
  })

  it("mask uses its offset and size", () => {
    expect(
      geometryBounds({ type: "mask", x: 5, y: 6, width: 10, height: 20, counts: [200] }),
    ).toEqual({
      minX: 5,
      minY: 6,
      maxX: 15,
      maxY: 26,
    })
  })

  it("custom geometry has no core-known bounds", () => {
    expect(geometryBounds({ type: "custom", kind: "acme:x", data: null })).toBeNull()
  })
})

describe("boundsWithin", () => {
  const outer = { minX: 0, minY: 0, maxX: 100, maxY: 100 }
  it("accepts contained bounds", () => {
    expect(boundsWithin({ minX: 10, minY: 10, maxX: 90, maxY: 90 }, outer)).toBe(true)
  })
  it("rejects bounds that stick out", () => {
    expect(boundsWithin({ minX: -1, minY: 10, maxX: 90, maxY: 90 }, outer)).toBe(false)
  })
  it("honours the tolerance", () => {
    expect(boundsWithin({ minX: -0.4, minY: 0, maxX: 100.4, maxY: 100 }, outer, 0.5)).toBe(true)
    expect(boundsWithin({ minX: -0.6, minY: 0, maxX: 100, maxY: 100 }, outer, 0.5)).toBe(false)
  })
})

describe("vertexCount", () => {
  it("counts polygon rings, polylines and keypoints", () => {
    expect(
      vertexCount({
        type: "polygon",
        rings: [
          [0, 0, 1, 1, 2, 2],
          [0, 0, 1, 1, 2, 2, 3, 3],
        ],
      }),
    ).toBe(7)
    expect(vertexCount({ type: "polyline", points: [0, 0, 1, 1] })).toBe(2)
    expect(vertexCount({ type: "keypoints", skeletonId: "k", points: [0, 0, 2, 1, 1, 2] })).toBe(2)
  })
  it("counts other geometries as one", () => {
    expect(vertexCount({ type: "box", x: 0, y: 0, w: 1, h: 1 })).toBe(1)
  })
})
