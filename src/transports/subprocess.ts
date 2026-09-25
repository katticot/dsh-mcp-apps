import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { EXTRA_BLOCKED_ENV_VARS, expandEnvVars, type StdioServerConfig } from '../config'

export interface ManagedStdio {
  transport: StdioClientTransport
  dispose: () => Promise<void>
}

export function createStdioTransport(config: StdioServerConfig): ManagedStdio {
  const expandedEnv = expandEnvVars(config.env)

  // scrubbedParentEnv() strips DSH_* and KEY/PASSWORD/SECRET/TOKEN-shaped
  // names, but not agent-socket variables like SSH_AUTH_SOCK or
  // GPG_AGENT_INFO, which would otherwise hand a spawned MCP server access
  // to the host's live credential agents. Strip those from the inherited
  // env; an explicit value in config.env still wins below.
  const inheritedEnv = scrubbedParentEnv()
  for (const blocked of EXTRA_BLOCKED_ENV_VARS) {
    delete inheritedEnv[blocked]
  }

  const safeEnv = {
    ...inheritedEnv,
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
