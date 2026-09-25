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

export const Config: Schema<Config> = Schema.object({
  servers: Schema.dict(Schema.union([StdioSchema, RemoteSchema, IpcSchema])).default({}),
  defaultTimeoutMs: Schema.number().default(30000),
})

/**
 * Expands environment variable expressions like `${FOO}` or `${FOO:-default}`
 * using the provided environment (defaulting to process.env).
 */
export function expandEnvString(value: string, env: Record<string, string | undefined> = process.env): string {
  return value.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)(?::-([^}]*))?\}/g, (_, varName, defaultValue) => {
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
  env: Record<string, string | undefined> = process.env
): Record<string, string> {
  if (!dict) return {}
  const result: Record<string, string> = {}
  for (const [key, val] of Object.entries(dict)) {
    result[key] = expandEnvString(val, env)
  }
  return result
}
