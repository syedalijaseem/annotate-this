import { describe, expect, it } from "vitest"
import { DEFAULT_LIMITS } from "../src/limits.js"
import { apply } from "../src/ops/apply.js"
import { jsonStringBytes, knownSize, measure } from "../src/ops/doc-size.js"
import { payloadBudget, snapshot } from "../src/ops/snapshot.js"
import type { Operation } from "../src/ops/types.js"
import { countNodes, findBudgetBreach } from "../src/validate/depth.js"
import { utf8ByteLength } from "../src/validate/json.js"
import { type Loose, box, validDocument } from "./fixtures.js"
import { batchOf, codeOf, opId, random, richDocument, run } from "./ops-helpers.js"

const op = (body: Loose): Operation => ({ id: opId(), ...body }) as Operation
const jsonBytes = (value: unknown): number => utf8ByteLength(JSON.stringify(value))

const ALPHABET = [
  "a",
  "Z",
  " ",
  '"',
  "\\",
  "/",
  "\u0000",
  "\u0001",
  "\n",
  "\t",
  "\b",
  "\f",
  "\r",
  "\u001f",
  "\u007f",
  "é",
  "ü",
  "一",
  " ",
  "😀",
  "\ud800",
  "\udfff",
  "\ud83d",
  "\ude00",
]

function randomString(rand: () => number): string {
  let text = ""
  const length = Math.floor(rand() * 12)
  for (let i = 0; i < length; i++) text += ALPHABET[Math.floor(rand() * ALPHABET.length)] as string
  return text
}

const NUMBERS = [
  0,
  -0,
  1,
  -1,
  0.5,
  -1.234567890123456e-300,
  1e21,
  1.5e-7,
  123456789.125,
  Number.MAX_SAFE_INTEGER,
  -Number.MAX_VALUE,
  Number.MIN_VALUE,
  2 ** 53 + 2,
]

function randomJson(rand: () => number, depth = 0): unknown {
  const roll = rand()
  if (depth > 4 || roll < 0.35) {
    const scalar = Math.floor(rand() * 5)
    if (scalar === 0) return randomString(rand)
    if (scalar === 1) return NUMBERS[Math.floor(rand() * NUMBERS.length)] ?? rand() * 1e6 - 5e5
    if (scalar === 2) return rand() * 2000 - 1000
    if (scalar === 3) return rand() < 0.5
    return null
  }
  const length = Math.floor(rand() * 5)
  if (roll < 0.65) return Array.from({ length }, () => randomJson(rand, depth + 1))
  return Object.fromEntries(
    Array.from({ length }, () => [randomString(rand), randomJson(rand, depth + 1)]),
  )
}

describe("the size meter matches compact JSON exactly", () => {
  it("measures strings as JSON.stringify writes them", () => {
    const rand = random(11)
    for (let i = 0; i < 2000; i++) {
      const text = randomString(rand)
      expect(jsonStringBytes(text), JSON.stringify(text)).toBe(jsonBytes(text))
    }
  })

  it("measures random JSON values byte for byte", () => {
    const rand = random(12)
    for (let i = 0; i < 2000; i++) {
      const value = randomJson(rand)
      expect(measure(value).bytes, JSON.stringify(value)).toBe(jsonBytes(value))
    }
  })

  it("skips undefined object values like JSON.stringify", () => {
    expect(measure({ a: 1, b: undefined, c: "x" }).bytes).toBe(jsonBytes({ a: 1, c: "x" }))
  })

  it("keeps a document's running size equal to its serialized size", () => {
    const doc = run(richDocument(), [
      op({ type: "setDocumentMeta", patch: { "a:é\u0001": ["😀", -1.5e-9, null, true] } }),
      op({ type: "createRegions", regions: [box("n1"), box("n2", "s2")] }),
      op({ type: "removeTag", tagId: "t2", onInUse: "detach" }),
      op({ type: "deleteRegion", regionId: "r1", children: "detach" }),
    ]).doc
    expect(knownSize(doc)?.bytes).toBe(jsonBytes(doc))
  })
})

describe("the four node counters agree", () => {
  it("on random JSON", () => {
    const rand = random(13)
    const budget = payloadBudget(DEFAULT_LIMITS)
    for (let i = 0; i < 1000; i++) {
      const value = { v: randomJson(rand) }
      const nodes = countNodes(value)
      expect(measure(value).nodes).toBe(nodes)
      const big = { ...budget, nodes }
      expect(findBudgetBreach(value, big)).toBeNull()
      expect(findBudgetBreach(value, { ...big, nodes: nodes - 1 })).toBe("nodes")
      expect(() => snapshot(value, big, () => {})).not.toThrow()
      expect(() => snapshot(value, { ...big, nodes: nodes - 1 }, () => {})).toThrow()
    }
  })
})

describe("the byte limit uses the real serialized size", () => {
  const base = validDocument()

  it("counts every digit of a number", () => {
    // 2,000 unrounded doubles take about 38,000 bytes.
    const values = Array.from({ length: 2000 }, (_, i) => 0.1 + i / 7)
    const limits = { maxDocumentBytes: 30_000 }
    const meta = op({ type: "setDocumentMeta", patch: { "a:n": values } })
    expect(codeOf(() => run(base, [meta], { limits }))).toBe("LIMIT_EXCEEDED")
    const rings = [values.map((v) => v * 5)]
    const polygon = { ...box("n1"), geometry: { type: "polygon", rings } }
    expect(
      codeOf(() => run(base, [op({ type: "createRegions", regions: [polygon] })], { limits })),
    ).toBe("LIMIT_EXCEEDED")
  })

  it("counts escapes and multi-byte characters", () => {
    const limits = { maxDocumentBytes: 30_000 }
    const control = op({ type: "setDocumentMeta", patch: { "a:c": "\u0001".repeat(5000) } })
    expect(codeOf(() => run(base, [control], { limits }))).toBe("LIMIT_EXCEEDED")
    const wide = op({ type: "setDocumentMeta", patch: { "a:w": "一".repeat(10_000) } })
    expect(codeOf(() => run(base, [wide], { limits }))).toBe("LIMIT_EXCEEDED")
  })

  it("accepts a document of exactly maxDocumentBytes and rejects one byte less", () => {
    const ops = [op({ type: "createRegion", region: { ...box("n1"), comment: "é\n😀" } })]
    const size = jsonBytes(apply(base, batchOf(ops)).doc)
    expect(() => apply(base, batchOf(ops), { limits: { maxDocumentBytes: size } })).not.toThrow()
    expect(
      codeOf(() => apply(base, batchOf(ops), { limits: { maxDocumentBytes: size - 1 } })),
    ).toBe("LIMIT_EXCEEDED")
  })
})
