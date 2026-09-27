import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { EXTRA_BLOCKED_ENV_VARS, expandEnvVars, type StdioServerConfig } from '../config'
import { DEFAULT_MAX_MESSAGE_BYTES } from '../constants'

export interface ManagedStdio {
  transport: StdioClientTransport
  dispose: () => Promise<void>
}

export function createStdioTransport(config: StdioServerConfig): ManagedStdio {
  const expandedEnv = expandEnvVars(config.env, process.env, new Set(config.allowedVars))

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

  // The SDK's ReadBuffer accumulates bytes written to stdout until it sees a
  // newline and only then parses a message; without a cap a misbehaving (or
  // hostile) stdio MCP server can send an arbitrarily long unterminated line
  // and exhaust host memory. `maxBufferSize` is enforced by the SDK's
  // ReadBuffer itself (shared/stdio.js): it throws once the bytes buffered
  // since the last newline exceed the limit, which the transport's stdout
  // handler turns into an onerror + close() — the same path a normal
  // disconnect takes, so the existing onclose/backoff logic in ServerPool
  // handles it without any extra plumbing here. Passing the option through is
  // simpler and safer than wrapping stdout or subclassing the transport to
  // duplicate that buffering/parsing logic ourselves.
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: safeEnv,
    cwd: config.cwd || undefined,
    maxBufferSize: config.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
  })

  return {
    transport,
    dispose: async () => {
      await transport.close().catch(() => void 0)
    },
  }
}
