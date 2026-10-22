// Spends work units against the batch budget (Limits.maxBatchWork); throws
// LIMIT_EXCEEDED when it runs out.
export type Charge = (units: number) => void
