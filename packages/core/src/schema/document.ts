import { type GenericSchema, array, looseObject, pipe, regex, string } from "valibot"
import type { AnnotationDocument } from "../types.js"
import { RegionSchema, TrackSchema } from "./annotation.js"
import { ConfigSchema } from "./config.js"
import { IdSchema, MetaSchema, RevSchema, safeRecord } from "./primitives.js"
import { SourceSchema } from "./source.js"

/** The schema major/minor this build understands (`"major.minor"`). */
export const SCHEMA_MAJOR = 1
export const SCHEMA_MINOR = 0
export const SCHEMA_VERSION = `${SCHEMA_MAJOR}.${SCHEMA_MINOR}`

export const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/**
 * Structural validation only (shapes, types, finite numbers, ID format).
 * Cross-references, orderings, bounds and limits are checked in ../validate.
 * Objects are loose, so unknown fields survive a round trip.
 */
export const DocumentSchema: GenericSchema<unknown, AnnotationDocument> = looseObject({
  id: IdSchema,
  schemaVersion: pipe(string(), regex(VERSION_PATTERN)),
  rev: RevSchema,
  config: ConfigSchema,
  sources: safeRecord(SourceSchema),
  sourceOrder: array(IdSchema),
  regions: safeRecord(RegionSchema),
  tracks: safeRecord(TrackSchema),
  meta: MetaSchema,
})
