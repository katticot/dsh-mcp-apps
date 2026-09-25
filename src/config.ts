import Schema from '@deepseek-ai/schemastery'

export interface ReconnectOptions {
  maxRetries?: number
  initialDelayMs?: number
  maxDelayMs?: number
  backoffFactor?: number
}

export type AppToolCallsSetting = 'deny' | 'approve' | 'allow'

export interface StdioServerConfig {
  transport: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  toolCallTimeoutMs?: number
  reconnectOptions?: ReconnectOptions
  allowAppToolCalls?: AppToolCallsSetting | boolean
  allowedPermissions?: string[]
  /** Names normally blocked from `${VAR}` expansion (DSH_*, secret-shaped, agent sockets) that this server may read. */
  allowedVars?: string[]
}

export interface RemoteServerConfig {
  transport: 'sse' | 'streamable-http' | 'websocket'
  url: string
  headers?: Record<string, string>
  toolCallTimeoutMs?: number
  reconnectOptions?: ReconnectOptions
  allowAppToolCalls?: AppToolCallsSetting | boolean
  allowedPermissions?: string[]
  /** Names normally blocked from `${VAR}` expansion (DSH_*, secret-shaped, agent sockets) that this server may read. */
  allowedVars?: string[]
}

export interface IpcServerConfig {
  transport: 'ipc'
  socketPath: string
  toolCallTimeoutMs?: number
  reconnectOptions?: ReconnectOptions
  allowAppToolCalls?: AppToolCallsSetting | boolean
  allowedPermissions?: string[]
}

export type ServerConfig = StdioServerConfig | RemoteServerConfig | IpcServerConfig

export interface Config {
  servers: Record<string, ServerConfig>
  defaultTimeoutMs?: number
}

const AppToolCallsSchema = Schema.union([
  Schema.const('deny' as const),
  Schema.const('approve' as const),
  Schema.const('allow' as const),
  Schema.boolean(),
]).default(false)

const ReconnectSchema: Schema<ReconnectOptions> = Schema.object({
  maxRetries: Schema.number().default(5),
  initialDelayMs: Schema.number().default(1000),
  maxDelayMs: Schema.number().default(30000),
  backoffFactor: Schema.number().default(1.5),
})

const StdioSchema: Schema<StdioServerConfig> = Schema.object({
  transport: Schema.const('stdio').default('stdio'),
  command: Schema.string().required(),
  args: Schema.array(String).default([]),
  env: Schema.dict(String).default({}),
  cwd: Schema.string(),
  toolCallTimeoutMs: Schema.number().default(30000),
  reconnectOptions: ReconnectSchema.default({}),
  allowAppToolCalls: AppToolCallsSchema,
  allowedPermissions: Schema.array(String).default([]),
  allowedVars: Schema.array(String).default([]),
})

const RemoteSchema: Schema<RemoteServerConfig> = Schema.object({
  transport: Schema.union([
    Schema.const('sse'),
    Schema.const('streamable-http'),
    Schema.const('websocket'),
  ]).required(),
  url: Schema.string().required(),
  headers: Schema.dict(String).default({}),
  toolCallTimeoutMs: Schema.number().default(30000),
  reconnectOptions: ReconnectSchema.default({}),
  allowAppToolCalls: AppToolCallsSchema,
  allowedPermissions: Schema.array(String).default([]),
  allowedVars: Schema.array(String).default([]),
})

const IpcSchema: Schema<IpcServerConfig> = Schema.object({
  transport: Schema.const('ipc').required(),
  socketPath: Schema.string().required(),
  toolCallTimeoutMs: Schema.number().default(30000),
  reconnectOptions: ReconnectSchema.default({}),
  allowAppToolCalls: AppToolCallsSchema,
  allowedPermissions: Schema.array(String).default([]),
})

export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 30000

/**
 * Resolves the effective tool-call timeout for a server: the server's own
 * override, falling back to the plugin-wide default, falling back to the
 * hard-coded default. Shared by every call site (forward tool execution,
 * app-initiated reverse tool calls, and resource reads) so the resolution
 * order never drifts between them.
 */
export function resolveToolCallTimeoutMs(
  serverConfig?: Pick<ServerConfig, 'toolCallTimeoutMs'>,
  defaultTimeoutMs?: number
): number {
  return serverConfig?.toolCallTimeoutMs ?? defaultTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS
}

export const SERVER_NAME_REGEX = /^(?!.*__)(?!.*_$)[a-zA-Z0-9_-]+$/

const ServerNameSchema = Schema.string()
  .pattern(SERVER_NAME_REGEX)
  .description('Server name cannot contain consecutive underscores or end with an underscore')

export const Config: Schema<Config> = Schema.object({
  servers: Schema.dict(Schema.union([StdioSchema, RemoteSchema, IpcSchema]), ServerNameSchema).default({}),
  defaultTimeoutMs: Schema.number().default(30000),
})

import { DSH_ENV_PREFIX, SENSITIVE_ENV_PATTERN } from '@deepseek-ai/dsh-subprocess'

/**
 * Agent-socket style variables that `scrubbedParentEnv()` does not strip
 * (they don't match DSH_* or the KEY/PASSWORD/SECRET/TOKEN pattern) but that
 * still grant access to a live credential agent if leaked to a spawned MCP
 * server or forwarded remote header. Blocked from `${VAR}` expansion here,
 * and stripped from the inherited environment before spawning (see
 * `createStdioTransport`), unless explicitly allow-listed.
 */
export const EXTRA_BLOCKED_ENV_VARS = new Set(['SSH_AUTH_SOCK', 'GPG_AGENT_INFO'])

/**
 * Expands environment variable expressions like `${FOO}` or `${FOO:-default}`
 * using the provided environment (defaulting to process.env).
 * Blocks reading DSH_* and sensitive secret patterns unless explicitly included in allowedVars.
 */
export function expandEnvString(
  value: string,
  env: Record<string, string | undefined> = process.env,
  allowedVars?: Set<string>
): string {
  return value.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)(?::-([^}]*))?\}/g, (_, varName, defaultValue) => {
    const isBlocked = (varName.startsWith(DSH_ENV_PREFIX) || SENSITIVE_ENV_PATTERN.test(varName) || EXTRA_BLOCKED_ENV_VARS.has(varName)) && !allowedVars?.has(varName)
    if (isBlocked) {
      return defaultValue ?? ''
    }
    const val = env[varName]
    if (val !== undefined && val !== '') {
      return val
    }
    return defaultValue ?? ''
  })
}

/**
 * Recursively expands environment variables in dictionary values.
 */
export function expandEnvVars(
  dict?: Record<string, string>,
  env: Record<string, string | undefined> = process.env,
  allowedVars?: Set<string>
): Record<string, string> {
  if (!dict) return {}
  const result: Record<string, string> = {}
  for (const [key, val] of Object.entries(dict)) {
    result[key] = expandEnvString(val, env, allowedVars)
  }
  return result
}
