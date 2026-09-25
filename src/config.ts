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
}

export interface RemoteServerConfig {
  transport: 'sse' | 'streamable-http' | 'websocket'
  url: string
  headers?: Record<string, string>
  toolCallTimeoutMs?: number
  reconnectOptions?: ReconnectOptions
  allowAppToolCalls?: AppToolCallsSetting | boolean
}

export interface IpcServerConfig {
  transport: 'ipc'
  socketPath: string
  toolCallTimeoutMs?: number
  reconnectOptions?: ReconnectOptions
  allowAppToolCalls?: AppToolCallsSetting | boolean
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
  allowAppToolCalls: AppToolCallsSchema,
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
})

const IpcSchema: Schema<IpcServerConfig> = Schema.object({
  transport: Schema.const('ipc').required(),
  socketPath: Schema.string().required(),
  toolCallTimeoutMs: Schema.number().default(30000),
  allowAppToolCalls: AppToolCallsSchema,
})

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
    const isBlocked = (varName.startsWith(DSH_ENV_PREFIX) || SENSITIVE_ENV_PATTERN.test(varName)) && !allowedVars?.has(varName)
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
