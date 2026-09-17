// Marker base for "invalid input relative to a domain invariant" errors; mapped to HTTP 400 at the exception filter boundary.
export abstract class BadRequestError extends Error {}
