import { describe, it, expect } from 'vitest'
import { Config, expandEnvString, expandEnvVars } from '../src/config'

describe('Config Schema Validation', () => {
  it('validates a complete multi-transport configuration', () => {
    const raw = {
      servers: {
        powerhive: {
          transport: 'stdio',
          command: 'go',
          args: ['run', 'main.go'],
        },
        cloudMcp: {
          transport: 'sse',
          url: 'https://mcp.example.com/sse',
          headers: {
            Authorization: 'Bearer secret-token',
          },
        },
        streamMcp: {
          transport: 'streamable-http',
          url: 'https://mcp.example.com/stream',
        },
        wsMcp: {
          transport: 'websocket',
          url: 'wss://mcp.example.com/ws',
          reconnectOptions: {
            maxRetries: 10,
          },
        },
        localIpc: {
          transport: 'ipc',
          socketPath: '/tmp/mcp.sock',
        },
      },
    }

    const parsed: any = Config(raw as any)
    expect(parsed.servers.powerhive.transport).toBe('stdio')
    expect(parsed.servers.powerhive.command).toBe('go')
    expect(parsed.servers.powerhive.toolCallTimeoutMs).toBe(30000)
    expect(parsed.servers.powerhive.allowAppToolCalls).toBe(false)

    expect(parsed.servers.cloudMcp.transport).toBe('sse')
    expect(parsed.servers.cloudMcp.url).toBe('https://mcp.example.com/sse')
    expect(parsed.servers.cloudMcp.allowAppToolCalls).toBe(false)

    expect(parsed.servers.streamMcp.transport).toBe('streamable-http')
    expect(parsed.servers.wsMcp.transport).toBe('websocket')
    expect(parsed.servers.wsMcp.reconnectOptions?.maxRetries).toBe(10)
    expect(parsed.servers.wsMcp.allowAppToolCalls).toBe(false)

    expect(parsed.servers.localIpc.transport).toBe('ipc')
    expect(parsed.servers.localIpc.socketPath).toBe('/tmp/mcp.sock')
    expect(parsed.servers.localIpc.allowAppToolCalls).toBe(false)
  })

  it('allows enabling allowAppToolCalls per server', () => {
    const raw = {
      servers: {
        trusted: {
          command: 'python3',
          allowAppToolCalls: true,
        },
        untrusted: {
          command: 'node',
          allowAppToolCalls: false,
        },
      },
    }

    const parsed: any = Config(raw as any)
    expect(parsed.servers.trusted.allowAppToolCalls).toBe(true)
    expect(parsed.servers.untrusted.allowAppToolCalls).toBe(false)
  })

  it('supports three-way allowAppToolCalls settings: deny, approve, allow', () => {
    const raw = {
      servers: {
        deniedServer: {
          command: 'python3',
          allowAppToolCalls: 'deny',
        },
        approvedServer: {
          command: 'python3',
          allowAppToolCalls: 'approve',
        },
        allowedServer: {
          command: 'python3',
          allowAppToolCalls: 'allow',
        },
      },
    }

    const parsed: any = Config(raw as any)
    expect(parsed.servers.deniedServer.allowAppToolCalls).toBe('deny')
    expect(parsed.servers.approvedServer.allowAppToolCalls).toBe('approve')
    expect(parsed.servers.allowedServer.allowAppToolCalls).toBe('allow')
  })

  it('defaults stdio transport when omitted', () => {
    const raw = {
      servers: {
        local: {
          command: 'python3',
          args: ['server.py'],
        },
      },
    }

    const parsed: any = Config(raw as any)
    expect(parsed.servers.local.transport).toBe('stdio')
    expect(parsed.servers.local.command).toBe('python3')
  })

  it('rejects invalid remote configuration lacking url', () => {
    const raw = {
      servers: {
        broken: {
          transport: 'sse',
        },
      },
    }

    expect(() => Config(raw as any)).toThrow()
  })

  it('rejects invalid ipc configuration lacking socketPath', () => {
    const raw = {
      servers: {
        broken: {
          transport: 'ipc',
        },
      },
    }

    expect(() => Config(raw as any)).toThrow()
  })

  it('rejects server names that contain __ or end with _', () => {
    expect(() => Config({
      servers: {
        'invalid__name': { transport: 'stdio', command: 'node' },
      },
    } as any)).toThrow()

    expect(() => Config({
      servers: {
        'trailing_': { transport: 'stdio', command: 'node' },
      },
    } as any)).toThrow()

    const valid = Config({
      servers: {
        'valid-name': { transport: 'stdio', command: 'node' },
        'valid_name_2': { transport: 'stdio', command: 'node' },
      },
    } as any)
    expect(valid.servers['valid-name']).toBeDefined()
    expect(valid.servers['valid_name_2']).toBeDefined()
  })

  it('rejects a null server entry', () => {
    const raw = {
      servers: {
        a: null,
      },
    }

    expect(() => Config(raw)).toThrow()
  })

  it('rejects a negative or zero toolCallTimeoutMs', () => {
    expect(() => Config({
      servers: {
        a: { transport: 'stdio', command: 'x', toolCallTimeoutMs: -5 },
      },
    })).toThrow()

    expect(() => Config({
      servers: {
        a: { transport: 'stdio', command: 'x', toolCallTimeoutMs: 0 },
      },
    })).toThrow()
  })

  it('rejects a negative or zero defaultTimeoutMs', () => {
    expect(() => Config({ servers: {}, defaultTimeoutMs: 0 })).toThrow()
    expect(() => Config({ servers: {}, defaultTimeoutMs: -1 })).toThrow()
  })

  it('rejects an invalid url for remote servers', () => {
    expect(() => Config({
      servers: {
        a: { transport: 'sse', url: 'not a url' },
      },
    })).toThrow()

    expect(() => Config({
      servers: {
        a: { transport: 'streamable-http', url: 'ftp://example.com' },
      },
    })).toThrow()
  })

  it('accepts valid http(s)/ws(s) urls for remote servers', () => {
    expect(() => Config({
      servers: {
        a: { transport: 'sse', url: 'https://mcp.example.com/sse' },
        b: { transport: 'websocket', url: 'wss://mcp.example.com/ws' },
      },
    })).not.toThrow()
  })
})

describe('Environment Variable Expansion', () => {
  const mockEnv = {
    USER_NAME: 'Alice',
    AUTH_TOKEN: 'Bearer secret-xyz',
    PORT: '8080',
    EMPTY_VAR: '',
  }

  it('expands existing environment variables', () => {
    expect(expandEnvString('Hello ${USER_NAME}', mockEnv)).toBe('Hello Alice')
    expect(expandEnvString('http://localhost:${PORT}', mockEnv)).toBe('http://localhost:8080')
  })

  it('expands default values when variable is unset or empty', () => {
    expect(expandEnvString('${MISSING:-default_val}', mockEnv)).toBe('default_val')
    expect(expandEnvString('${EMPTY_VAR:-fallback}', mockEnv)).toBe('fallback')
    expect(expandEnvString('${MISSING}', mockEnv)).toBe('')
  })

  it('expands headers dictionary recursively', () => {
    const headers = {
      Authorization: '${AUTH_TOKEN}',
      'X-Custom-Env': '${UNSET:-production}',
      'X-Port': '${PORT}',
    }
    const expanded = expandEnvVars(headers, mockEnv, new Set(['AUTH_TOKEN']))
    expect(expanded).toEqual({
      Authorization: 'Bearer secret-xyz',
      'X-Custom-Env': 'production',
      'X-Port': '8080',
    })
  })

  it('blocks reading DSH_* and sensitive secrets during variable expansion unless explicitly allowed', () => {
    const env = {
      DSH_INTERNAL_TOKEN: 'super-secret',
      API_SECRET_KEY: 'secret-123',
      SAFE_PORT: '9000',
    }

    // Default: blocked
    expect(expandEnvString('${DSH_INTERNAL_TOKEN}', env)).toBe('')
    expect(expandEnvString('${API_SECRET_KEY}', env)).toBe('')
    expect(expandEnvString('${SAFE_PORT}', env)).toBe('9000')

    // Explicitly allowed
    expect(expandEnvString('${DSH_INTERNAL_TOKEN}', env, new Set(['DSH_INTERNAL_TOKEN']))).toBe('super-secret')
    expect(expandEnvString('${API_SECRET_KEY}', env, new Set(['API_SECRET_KEY']))).toBe('secret-123')
  })

  it('treats $$ as an escaped literal $, not the start of a variable', () => {
    expect(expandEnvString('price: $$${PORT}', mockEnv)).toBe('price: $8080')
    expect(expandEnvString('$$FOO', mockEnv)).toBe('$FOO')
    expect(expandEnvString('$$', mockEnv)).toBe('$')
  })

  it('documents that a ${VAR} default cannot itself contain a nested ${VAR}', () => {
    // Known limitation: the default-value branch stops at the first `}`,
    // so it cannot parse a nested expansion. This test pins the current,
    // documented behavior rather than the ideal one.
    expect(expandEnvString('${MISSING:-${PORT}}', mockEnv)).toBe('${PORT}')
  })
})
