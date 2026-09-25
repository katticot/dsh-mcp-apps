import { describe, it, expect, afterEach } from 'vitest'
import { createStdioTransport } from '../src/transports/subprocess'

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
