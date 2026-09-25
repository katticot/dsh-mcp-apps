import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/app-bridge'
import type { Context } from '@deepseek-ai/cordis'
import type { Config, ServerConfig } from '../config'
import type { ServerToolManager, UiToolDescriptor } from '../tool-manager'
import { createStdioTransport, type ManagedStdio } from './subprocess'
import { createRemoteTransport } from './remote'
import { IpcClientTransport } from './ipc'

export interface ServerInstance {
  client: Client
  managedStdio?: ManagedStdio
  disposeTransport: () => Promise<void>
}

export interface ResourceResponse {
  uri: string
  html: string
  csp?: Record<string, string[]>
  permissions?: Record<string, string[]>
}

export class ServerPool {
  private ctx: Context
  private config: Config
  private toolManager: ServerToolManager
  private servers = new Map<string, ServerInstance>()
  private refreshSeq = new Map<string, number>()
  private lastAppliedSeq = new Map<string, number>()
  private lifecycleController = new AbortController()
  private startupTasks = new Map<string, Promise<void>>()

  constructor(ctx: Context, config: Config, toolManager: ServerToolManager) {
    this.ctx = ctx
    this.config = config
    this.toolManager = toolManager
  }

  private initialSyncPromise: Promise<void> | null = null

  startAll(): Promise<void> {
    if (!this.initialSyncPromise) {
      this.initialSyncPromise = (async () => {
        const tasks = Object.entries(this.config.servers).map(async ([name, serverConfig]) => {
          const task = (async () => {
            try {
              if (this.lifecycleController.signal.aborted) return
              await this.startServer(name, serverConfig, this.lifecycleController.signal)
            } catch (err) {
              if (!this.lifecycleController.signal.aborted) {
                console.error(`mcp-apps: failed to connect to server "${name}":`, err)
              }
            } finally {
              this.startupTasks.delete(name)
            }
          })()
          this.startupTasks.set(name, task)
          return task
        })
        await Promise.allSettled(tasks)
      })()
    }
    return this.initialSyncPromise
  }

  async waitForInitialSync(timeoutMs = 15000): Promise<void> {
    if (this.initialSyncPromise) {
      await Promise.race([
        this.initialSyncPromise,
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
      ])
    }
  }

  async startServer(serverName: string, serverConfig: ServerConfig, signal?: AbortSignal): Promise<void> {
    const isAborted = () => signal?.aborted || this.lifecycleController.signal.aborted
    if (isAborted()) return

    const client = new Client({
      name: 'dsh-mcp-apps',
      version: '0.1.0',
    }, {
      capabilities: {
        extensions: {
          'io.modelcontextprotocol/ui': {
            mimeTypes: [RESOURCE_MIME_TYPE],
          },
        },
      },
    })

    let managedStdio: ManagedStdio | undefined
    let disposeTransport: () => Promise<void>

    if (serverConfig.transport === 'stdio') {
      managedStdio = createStdioTransport(serverConfig)
      disposeTransport = managedStdio.dispose
      await client.connect(managedStdio.transport)
    } else if (serverConfig.transport === 'ipc') {
      const ipc = new IpcClientTransport(serverConfig)
      disposeTransport = () => ipc.close()
      await client.connect(ipc)
    } else {
      const remote = createRemoteTransport(serverConfig)
      disposeTransport = () => remote.close()
      await client.connect(remote)
    }

    if (isAborted()) {
      await client.close().catch(() => void 0)
      await disposeTransport().catch(() => void 0)
      return
    }

    const instance: ServerInstance = {
      client,
      managedStdio,
      disposeTransport,
    }
    this.servers.set(serverName, instance)

    // Dynamic tool change subscription (attached BEFORE initial sync)
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      try {
        await this.refreshTools(serverName, client)
      } catch (err) {
        console.error(`mcp-apps: failed to re-sync tools for server "${serverName}":`, err)
      }
    })

    // Initial tool sync
    await this.refreshTools(serverName, client)
  }

  private async refreshTools(serverName: string, client: Client): Promise<void> {
    const seq = (this.refreshSeq.get(serverName) ?? 0) + 1
    this.refreshSeq.set(serverName, seq)

    const toolsResult = await client.listTools()
    const lastSeq = this.lastAppliedSeq.get(serverName) ?? 0
    if (seq < lastSeq) {
      // Outdated response; discard
      return
    }
    this.lastAppliedSeq.set(serverName, seq)

    const serverConfig = this.config.servers[serverName]
    this.toolManager.syncServerTools(serverName, client, toolsResult.tools, serverConfig)
  }

  getUiToolsSnapshot(): UiToolDescriptor[] {
    return this.toolManager.getUiToolsSnapshot()
  }


  async listResources(serverName?: string): Promise<unknown> {
    if (serverName) {
      const instance = this.servers.get(serverName)
      if (!instance) throw new Error(`MCP server "${serverName}" is not connected`)
      return instance.client.listResources()
    }
    const allResources: unknown[] = []
    for (const [name, instance] of this.servers.entries()) {
      try {
        const res = await instance.client.listResources()
        allResources.push(...(res.resources ?? []))
      } catch {
        // ignore
      }
    }
    return { resources: allResources }
  }

  async readResource(serverName?: string, uri?: string, _signal?: AbortSignal): Promise<ResourceResponse> {
    if (!uri) throw new Error('Missing resource URI')

    // If serverName is omitted, look up server owning this resource
    let targetServer = serverName
    if (!targetServer) {
      const uiTool = this.getUiToolsSnapshot().find(t => t.resourceUri === uri)
      targetServer = uiTool?.serverName
    }

    if (!targetServer) {
      throw new Error(`Cannot locate MCP server for resource URI: ${uri}`)
    }

    const instance = this.servers.get(targetServer)
    if (!instance) {
      throw new Error(`MCP server "${targetServer}" is not connected`)
    }

    const response = await instance.client.readResource({ uri })
    if (!response.contents || response.contents.length !== 1) {
      throw new Error(`Resource ${uri} returned invalid content items`)
    }

    const item = response.contents[0]
    let html: string | undefined
    if ('text' in item && typeof item.text === 'string') {
      html = item.text
    } else if ('blob' in item && typeof item.blob === 'string') {
      html = Buffer.from(item.blob, 'base64').toString('utf8')
    }

    if (!html) {
      throw new Error(`Resource ${uri} returned neither text nor blob HTML`)
    }

    const meta = (item as { _meta?: unknown; meta?: unknown })._meta ?? (item as { meta?: unknown }).meta
    const ui = typeof meta === 'object' && meta !== null ? (meta as { ui?: { csp?: Record<string, string[]>; permissions?: Record<string, string[]> } }).ui : undefined

    return {
      uri,
      html,
      csp: ui?.csp,
      permissions: ui?.permissions,
    }
  }

  async callTool(
    serverName: string,
    name: string,
    args?: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const instance = this.servers.get(serverName)
    if (!instance) {
      throw new Error(`MCP server "${serverName}" is not connected`)
    }
    return instance.client.callTool(
      {
        name,
        arguments: args ?? {},
      },
      undefined,
      { signal }
    )
  }

  async stopAll(): Promise<void> {
    this.lifecycleController.abort()
    await Promise.allSettled(Array.from(this.startupTasks.values()))

    for (const [name, instance] of this.servers.entries()) {
      try {
        await instance.client.close().catch(() => void 0)
        await instance.disposeTransport().catch(() => void 0)
      } catch (err) {
        console.error(`mcp-apps: error stopping server "${name}":`, err)
      }
      this.toolManager.evictServer(name)
    }
    this.servers.clear()
  }
}
