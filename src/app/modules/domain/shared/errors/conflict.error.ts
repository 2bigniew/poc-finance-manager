// Marker base for "conflicts with existing state" domain errors; mapped to HTTP 409 at the exception filter boundary.
export abstract class ConflictError extends Error {}
