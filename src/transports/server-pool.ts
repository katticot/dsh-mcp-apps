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

  constructor(ctx: Context, config: Config, toolManager: ServerToolManager) {
    this.ctx = ctx
    this.config = config
    this.toolManager = toolManager
  }

  private initialSyncPromise: Promise<void> | null = null

  startAll(): Promise<void> {
    if (!this.initialSyncPromise) {
      this.initialSyncPromise = (async () => {
        for (const [name, serverConfig] of Object.entries(this.config.servers)) {
          try {
            await this.startServer(name, serverConfig)
          } catch (err) {
            console.error(`mcp-apps: failed to connect to server "${name}":`, err)
          }
        }
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

  async startServer(serverName: string, serverConfig: ServerConfig): Promise<void> {
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

    const instance: ServerInstance = {
      client,
      managedStdio,
      disposeTransport,
    }
    this.servers.set(serverName, instance)

    // Initial tool sync
    await this.refreshTools(serverName, client)

    // Dynamic tool change subscription
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      try {
        await this.refreshTools(serverName, client)
      } catch (err) {
        console.error(`mcp-apps: failed to re-sync tools for server "${serverName}":`, err)
      }
    })
  }

  private async refreshTools(serverName: string, client: Client): Promise<void> {
    const toolsResult = await client.listTools()
    this.toolManager.syncServerTools(serverName, client, toolsResult.tools)
  }

  getUiToolsSnapshot(): UiToolDescriptor[] {
    return this.toolManager.getUiToolsSnapshot()
  }

  findServerForTool(toolName: string): string | undefined {
    const snapshot = this.getUiToolsSnapshot()
    const foundUi = snapshot.find(t => t.tool.name === toolName || t.publicName === toolName)
    if (foundUi?.serverName) return foundUi.serverName

    for (const [name] of this.servers.entries()) {
      return name
    }
    return undefined
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
    _signal?: AbortSignal
  ): Promise<unknown> {
    const instance = this.servers.get(serverName)
    if (!instance) {
      throw new Error(`MCP server "${serverName}" is not connected`)
    }
    return instance.client.callTool({
      name,
      arguments: args ?? {},
    })
  }

  async stopAll(): Promise<void> {
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
