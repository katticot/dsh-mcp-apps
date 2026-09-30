import { describe, it, expect } from 'vitest'
;(globalThis as any).__PKG_VERSION__ = '0.2.4'
import { ServerPool } from '../src/transports/server-pool'
import { ServerToolManager } from '../src/tool-manager'
import { AppSessionStore } from '../src/session-store'

describe('live powerhive connection', () => {
  it.skipIf(!process.env.LIVE_TEST)('connects to powerhive with existing stored token', async () => {
    const config = {
      externalUrl: 'http://localhost:3080',
      servers: {
        powerhive: {
          transport: 'streamable-http' as const,
          url: 'https://mcp.srv1156700.hstgr.cloud/mcp',
          oauth: true,
          allowAppToolCalls: 'allow' as const,
        }
      }
    }

    const registeredTools: any[] = []
    const toolsService = {
      register: (def: any) => {
        registeredTools.push(def)
        return () => {}
      }
    }

    const sessionStore = new AppSessionStore()
    const toolManager = new ServerToolManager(toolsService, sessionStore)
    const pool = new ServerPool({} as any, config as any, toolManager)

    console.log('Calling startServer...')
    await pool.startServer('powerhive', config.servers.powerhive as any)
    console.log('startServer finished! Server status:', pool.getStatusSnapshot())
    console.log('Registered tools count:', registeredTools.length)
    if (registeredTools.length > 0) {
      console.log('First registered tool:', registeredTools[0]?.name)
    }
    await pool.stopAll()
  }, 30000)
})
