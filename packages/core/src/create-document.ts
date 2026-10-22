import { AnnotateError } from "./errors.js"
import { createIdGenerator } from "./ids.js"
import { SCHEMA_VERSION } from "./schema/document.js"
import type { AnnotationDocument, ClassDef, ID, ImageSource, TagDef } from "./types.js"
import { parseDocument } from "./validate/index.js"
import { clip } from "./validate/issues.js"

export interface ImageInput {
  src: string
  /** Display name; defaults to the last path segment of `src`. */
  name?: string
  thumbnailSrc?: string
  /** Oriented (post-EXIF) pixel size. The browser package can measure this for you. */
  width: number
  height: number
}

/** A label given as plain text, or with an explicit id and color. */
export type LabelInput = string | { id?: ID; name: string; color?: string }

export interface CreateDocumentInput {
  images?: readonly ImageInput[]
  classes?: readonly LabelInput[]
  tags?: readonly LabelInput[]
  taskDescription?: string
  tools?: readonly string[]
  allowedArea?: { x: number; y: number; w: number; h: number }
  /** Id source; inject a deterministic one for reproducible output. Defaults to UUIDv7. */
  idGenerator?: () => ID
}

function displayName(src: string): string {
  const withoutQuery = src.split(/[?#]/, 1)[0] ?? src
  const last = withoutQuery.split("/").filter(Boolean).pop() ?? src
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

function buildSource(image: ImageInput, id: ID): ImageSource {
  return {
    kind: "image",
    id,
    rev: 0,
    name: image.name ?? displayName(image.src),
    uri: image.src,
    ...(image.thumbnailSrc !== undefined ? { thumbnailUri: image.thumbnailSrc } : {}),
    width: image.width,
    height: image.height,
    regionOrder: [],
    tagIds: [],
    attributes: {},
    meta: {},
  }
}

interface LabelEntry {
  id: ID
  name: string
  color?: string
}

// Ids are one flat space (Spec 0001): every id createDocument uses is claimed here.
function claim(seen: Set<ID>, id: ID, kind: string): ID {
  if (seen.has(id)) {
    throw new AnnotateError("DUPLICATE_ID", `Duplicate ${kind} id "${clip(String(id))}"`)
  }
  seen.add(id)
  return id
}

function labelEntries(
  labels: readonly LabelInput[],
  nextId: () => ID,
  kind: string,
  seen: Set<ID>,
): LabelEntry[] {
  return labels.map((label) => {
    const entry = typeof label === "string" ? { name: label } : label
    const id = claim(seen, entry.id ?? nextId(), kind)
    return {
      id,
      name: entry.name,
      ...("color" in entry && entry.color !== undefined ? { color: entry.color } : {}),
    }
  })
}

const toClassDef = (entry: LabelEntry): ClassDef => ({ ...entry, meta: {} })
const toTagDef = (entry: LabelEntry): TagDef => ({ ...entry, meta: {} })

function indexById<T extends { id: ID }>(items: readonly T[]): Record<ID, T> {
  return Object.fromEntries(items.map((item) => [item.id, item]))
}

/**
 * Builds a valid document from simple inputs (the common "load these images
 * with these labels" case). The result has been through `parseDocument`, so
 * bad input (non-integer sizes, duplicate ids) fails here with a typed error.
 * Ids share one flat space: an id generator that repeats itself, or an
 * explicit label id equal to another id, fails with DUPLICATE_ID.
 */
export function createDocument(input: CreateDocumentInput = {}): AnnotationDocument {
  const nextId = input.idGenerator ?? createIdGenerator()
  const seen = new Set<ID>()
  const id = claim(seen, nextId(), "document")
  const sources = (input.images ?? []).map((image) =>
    buildSource(image, claim(seen, nextId(), "image")),
  )
  const classes = labelEntries(input.classes ?? [], nextId, "class", seen).map(toClassDef)
  const tags = labelEntries(input.tags ?? [], nextId, "tag", seen).map(toTagDef)

  const document: AnnotationDocument = {
    id,
    schemaVersion: SCHEMA_VERSION,
    rev: 0,
    config: {
      rev: 0,
      ...(input.taskDescription !== undefined ? { taskDescription: input.taskDescription } : {}),
      classes: indexById(classes),
      classOrder: classes.map((c) => c.id),
      tags: indexById(tags),
      tagOrder: tags.map((t) => t.id),
      attributes: {},
      skeletons: {},
      ...(input.tools !== undefined ? { tools: [...input.tools] } : {}),
      ...(input.allowedArea !== undefined
        ? { allowedArea: { type: "box" as const, ...input.allowedArea } }
        : {}),
      meta: {},
    },
    sources: indexById(sources),
    sourceOrder: sources.map((s) => s.id),
    regions: {},
    tracks: {},
    meta: {},
  }
  return parseDocument(document)
}
