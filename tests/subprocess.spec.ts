import { describe, it, expect, afterEach } from 'vitest'
import { createStdioTransport } from '../src/transports/subprocess'

function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const check = () => {
      if (condition()) return resolve()
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'))
      setTimeout(check, 20)
    }
    check()
  })
}

describe('Stdio Transport Environment Scrubbing', () => {
  const originalSshAuthSock = process.env.SSH_AUTH_SOCK
  const originalGpgAgentInfo = process.env.GPG_AGENT_INFO

  afterEach(() => {
    if (originalSshAuthSock === undefined) delete process.env.SSH_AUTH_SOCK
    else process.env.SSH_AUTH_SOCK = originalSshAuthSock
    if (originalGpgAgentInfo === undefined) delete process.env.GPG_AGENT_INFO
    else process.env.GPG_AGENT_INFO = originalGpgAgentInfo
  })

  it('strips inherited SSH_AUTH_SOCK and GPG_AGENT_INFO from the spawned child env', () => {
    process.env.SSH_AUTH_SOCK = '/tmp/ssh-agent.sock'
    process.env.GPG_AGENT_INFO = '/tmp/gpg-agent:0:1'

    const managed = createStdioTransport({
      transport: 'stdio',
      command: 'some-mcp-server',
    })

    const spawnedEnv = (managed.transport as any)._serverParams.env as Record<string, string>
    expect(spawnedEnv.SSH_AUTH_SOCK).toBeUndefined()
    expect(spawnedEnv.GPG_AGENT_INFO).toBeUndefined()
  })

  it('expands a normally-blocked ${VAR} in config.env when listed in allowedVars', () => {
    process.env.API_TOKEN = 'tok-abc123'
    try {
      const blocked = createStdioTransport({
        transport: 'stdio',
        command: 'some-mcp-server',
        env: { API_TOKEN: '${API_TOKEN}' },
      })
      expect((blocked.transport as any)._serverParams.env.API_TOKEN).toBe('')

      const allowed = createStdioTransport({
        transport: 'stdio',
        command: 'some-mcp-server',
        env: { API_TOKEN: '${API_TOKEN}' },
        allowedVars: ['API_TOKEN'],
      })
      expect((allowed.transport as any)._serverParams.env.API_TOKEN).toBe('tok-abc123')
    } finally {
      delete process.env.API_TOKEN
    }
  })

  it('still allows an explicit config.env value to pass through', () => {
    process.env.SSH_AUTH_SOCK = '/tmp/ssh-agent.sock'

    const managed = createStdioTransport({
      transport: 'stdio',
      command: 'some-mcp-server',
      env: { SSH_AUTH_SOCK: '/explicit/override.sock' },
    })

    const spawnedEnv = (managed.transport as any)._serverParams.env as Record<string, string>
    expect(spawnedEnv.SSH_AUTH_SOCK).toBe('/explicit/override.sock')
  })
})

describe('Stdio Transport Message Size Cap', () => {
  it('closes the transport with a clear error when a single message exceeds maxMessageBytes', async () => {
    // Multi-byte (3-byte UTF-8) characters: 20 chars = 60 bytes, which is over
    // a 50-byte cap even though the JS string length (20) is well under it —
    // proves the cap counts bytes, not JS string/char length.
    const line = '你'.repeat(20)
    const managed = createStdioTransport({
      transport: 'stdio',
      command: 'node',
      args: ['-e', `process.stdout.write(${JSON.stringify(line)} + '\\n')`],
      maxMessageBytes: 50,
    })

    let closed = false
    let error: Error | undefined
    managed.transport.onclose = () => { closed = true }
    managed.transport.onerror = (err) => { error = err }

    await managed.transport.start()
    await waitFor(() => closed)

    expect(closed).toBe(true)
    expect(error?.message).toMatch(/exceeded maximum/i)

    await managed.dispose()
  })

  it('delivers a normal-sized JSON-RPC line under the cap without closing', async () => {
    const message = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
    const managed = createStdioTransport({
      transport: 'stdio',
      command: 'node',
      args: ['-e', `process.stdout.write(${JSON.stringify(message)} + '\\n')`],
      maxMessageBytes: 1024,
    })

    const received: unknown[] = []
    let error: Error | undefined
    managed.transport.onmessage = (msg) => { received.push(msg) }
    managed.transport.onerror = (err) => { error = err }

    await managed.transport.start()
    // The one-shot `node -e` process exits right after writing its line, so
    // the transport closes naturally afterwards; what matters is the message
    // was delivered and no size-cap error fired first.
    await waitFor(() => received.length > 0)

    expect(received).toEqual([{ jsonrpc: '2.0', id: 1, method: 'ping' }])
    expect(error).toBeUndefined()

    await managed.dispose()
  })
})
