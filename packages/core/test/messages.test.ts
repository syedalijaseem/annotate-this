import { describe, expect, it } from "vitest"
import { createDocument } from "../src/create-document.js"
import { type Loose, box, clone, validDocument } from "./fixtures.js"
import { errorOf, manyRegions, opId, reload, run } from "./ops-helpers.js"

// Messages are shown to users and logged: input they quote is clipped.
describe("error messages stay short whatever the input", () => {
  it("clips a status quoted by setConfig", () => {
    const doc: Loose = clone(validDocument())
    doc.config.statuses = ["draft", "s".repeat(9000)]
    doc.regions.r1.status = "s".repeat(9000)
    const op = { id: opId(), type: "setConfig", patch: { statuses: ["draft"] } }
    const error = errorOf(() => run(reload(doc), [op]))
    expect(error.code).toBe("IN_USE")
    expect(error.message.length).toBeLessThan(300)
  })

  it("clips a duplicate label id quoted by createDocument", () => {
    const id = "x".repeat(100_000)
    const error = errorOf(() =>
      createDocument({
        classes: [
          { id, name: "a" },
          { id, name: "b" },
        ],
      }),
    )
    expect(error.code).toBe("DUPLICATE_ID")
    expect(error.message.length).toBeLessThan(300)
  })
})

describe("the annotation-room check names the limit that tripped", () => {
  it("reports maxEntries when the regions record is full", () => {
    const doc = manyRegions(20)
    const create = { id: opId(), type: "createRegion", region: box("n1") }
    const error = errorOf(() => run(doc, [create], { limits: { maxEntries: 20 } }))
    expect(error.code).toBe("LIMIT_EXCEEDED")
    expect(error.message).toMatch(/more than 20 entries/)
    expect(error.message).not.toMatch(/annotations/)
  })

  it("still reports maxAnnotations when that is the limit", () => {
    const doc = manyRegions(3)
    const create = { id: opId(), type: "createRegion", region: box("n1") }
    const error = errorOf(() => run(doc, [create], { limits: { maxAnnotations: 3 } }))
    expect(error.message).toMatch(/More than 3 annotations/)
  })
})
