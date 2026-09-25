import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { expandEnvVars, type StdioServerConfig } from '../config'

export interface ManagedStdio {
  transport: StdioClientTransport
  dispose: () => Promise<void>
}

export function createStdioTransport(config: StdioServerConfig): ManagedStdio {
  const expandedEnv = expandEnvVars(config.env)
  const safeEnv = {
    ...scrubbedParentEnv(),
    ...expandedEnv,
  }

  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: safeEnv,
    cwd: config.cwd || undefined,
  })

  return {
    transport,
    dispose: async () => {
      await transport.close().catch(() => void 0)
    },
  }
}
