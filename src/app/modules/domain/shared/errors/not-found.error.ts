// Marker base for "entity does not exist" domain errors; mapped to HTTP 404 at the exception filter boundary.
export abstract class NotFoundError extends Error {}
