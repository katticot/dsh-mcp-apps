/**
 * Default maximum size, in bytes, of a single incoming protocol message
 * (a stdio line, an SSE event, or a streamable-http response body) before
 * the transport is treated as misbehaving and closed. Shared by every
 * transport so the default never drifts between stdio and remote configs.
 */
export const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024 // 16 MB

/** Maximum total characters of text delivered by a single app ui/message submission. */
export const MAX_APP_MESSAGE_TEXT_CHARS = 32_768
/** Maximum content blocks accepted in a single app ui/message submission. */
export const MAX_APP_MESSAGE_BLOCKS = 32

/** Sliding-window cap on delivered app messages per app session. */
export const MAX_APP_MESSAGES_PER_WINDOW = 6
/** Length (ms) of the per-session app-message rate-limit window. */
export const APP_MESSAGE_WINDOW_MS = 60_000
