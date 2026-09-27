/**
 * Default maximum size, in bytes, of a single incoming protocol message
 * (a stdio line, an SSE event, or a streamable-http response body) before
 * the transport is treated as misbehaving and closed. Shared by every
 * transport so the default never drifts between stdio and remote configs.
 */
export const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024 // 16 MB
