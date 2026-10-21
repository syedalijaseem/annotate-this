export type * from "./types.js"

export { AnnotateError, ERROR_CODES, isAnnotateError } from "./errors.js"
export type { ErrorCode, ErrorDetail, ErrorIssue } from "./errors.js"

export { ID_PATTERN, createIdGenerator, isValidId } from "./ids.js"
export type { IdGeneratorOptions } from "./ids.js"

export { DEFAULT_LIMITS, resolveLimits } from "./limits.js"
export type { Limits } from "./limits.js"

export { boundsWithin, geometryBounds, vertexCount } from "./geometry/bounds.js"
export type { Bounds } from "./geometry/bounds.js"

export { SCHEMA_MAJOR, SCHEMA_MINOR, SCHEMA_VERSION } from "./schema/document.js"
export { DocumentSchema } from "./schema/document.js"

export { parseDocument } from "./validate/index.js"
export type { ParseOptions } from "./validate/index.js"
export { parseDocumentJson, utf8ByteLength } from "./validate/json.js"

export { createDocument } from "./create-document.js"
export type { CreateDocumentInput, ImageInput, LabelInput } from "./create-document.js"
