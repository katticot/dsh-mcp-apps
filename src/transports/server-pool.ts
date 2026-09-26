import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/app-bridge'
import type { Context } from '@deepseek-ai/cordis'
import { resolveToolCallTimeoutMs, type Config, type ServerConfig } from '../config'
import type { ServerToolManager, UiToolDescriptor } from '../tool-manager'
import { createStdioTransport, type ManagedStdio } from './subprocess'
import { createRemoteTransport } from './remote'

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

export const MAX_TOOLS_PER_SERVER = 256
export const MAX_RESOURCE_SIZE_BYTES = 10 * 1024 * 1024 // 10MB

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
      version: __PKG_VERSION__,
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

    client.onclose = () => this.handleServerClose(serverName)

    // Dynamic tool change subscription (attached BEFORE initial sync)
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      try {
        await this.refreshTools(serverName, client)
      } catch (err) {
        console.error(`mcp-apps: failed to re-sync tools for server "${serverName}":`, err)
      }
    })

    await this.refreshTools(serverName, client)
  }

  private async refreshTools(serverName: string, client: Client): Promise<void> {
    const seq = (this.refreshSeq.get(serverName) ?? 0) + 1
    this.refreshSeq.set(serverName, seq)

    const toolsResult = await client.listTools()

    // Guard against a zombie refresh: listTools() may resolve after this
    // server was stopped, evicted, or replaced by a reconnect while the
    // request was in flight. Only apply the result if this client instance
    // is still the active one for this server and the lifecycle is alive.
    if (this.lifecycleController.signal.aborted) return
    if (this.servers.get(serverName)?.client !== client) return

    if (toolsResult.tools.length > MAX_TOOLS_PER_SERVER) {
      throw new Error(`Server "${serverName}" exceeded maximum tool limit (${MAX_TOOLS_PER_SERVER})`)
    }
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

  async readResourceRaw(serverName?: string, uri?: string, signal?: AbortSignal): Promise<unknown> {
    if (!uri) throw new Error('Missing resource URI')

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

    const serverConfig = this.config.servers[targetServer]
    const timeout = resolveToolCallTimeoutMs(serverConfig, this.config.defaultTimeoutMs)
    return instance.client.readResource({ uri }, { timeout, signal })
  }

  async readResource(serverName?: string, uri?: string, signal?: AbortSignal): Promise<ResourceResponse> {
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

    const serverConfig = this.config.servers[targetServer]
    const timeout = resolveToolCallTimeoutMs(serverConfig, this.config.defaultTimeoutMs)
    const response = await instance.client.readResource({ uri }, { timeout, signal })
    if (!response.contents || response.contents.length === 0) {
      throw new Error(`Resource ${uri} returned invalid content items`)
    }

    // Find HTML text or blob item, or fallback to first item
    const item = response.contents.find(c => {
      const mime = 'mimeType' in c ? (c as { mimeType?: string }).mimeType : undefined
      if (mime?.includes('html')) return true
      return ('text' in c && typeof c.text === 'string' && (c.text.includes('<html') || c.text.includes('<!DOCTYPE'))) ||
             ('blob' in c && typeof c.blob === 'string')
    }) ?? response.contents[0]

    let html: string | undefined
    if ('text' in item && typeof item.text === 'string') {
      html = item.text
    } else if ('blob' in item && typeof item.blob === 'string') {
      html = Buffer.from(item.blob, 'base64').toString('utf8')
    }

    if (!html) {
      throw new Error(`Resource ${uri} returned neither text nor blob HTML`)
    }

    if (html.length > MAX_RESOURCE_SIZE_BYTES) {
      throw new Error(`Resource ${uri} exceeded maximum allowed size of 10MB`)
    }

    const meta = (item as { _meta?: unknown; meta?: unknown })._meta ?? (item as { meta?: unknown }).meta
    const ui = typeof meta === 'object' && meta !== null ? (meta as { ui?: { csp?: Record<string, string[]>; permissions?: Record<string, string[]> } }).ui : undefined

    let permissions = ui?.permissions
    if (permissions) {
      const allowed = new Set(serverConfig?.allowedPermissions ?? [])
      permissions = Object.fromEntries(
        Object.entries(permissions).filter(([key]) => {
          if (['camera', 'microphone', 'geolocation'].includes(key)) {
            return allowed.has(key)
          }
          return true
        })
      )
    }

    return {
      uri,
      html,
      csp: ui?.csp,
      permissions,
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
    const serverConfig = this.config.servers[serverName]
    const timeout = resolveToolCallTimeoutMs(serverConfig, this.config.defaultTimeoutMs)
    return instance.client.callTool(
      {
        name,
        arguments: args ?? {},
      },
      undefined,
      { timeout, signal }
    )
  }

  private reconnectAttempts = new Map<string, number>()
  private reconnectTimers = new Map<string, NodeJS.Timeout>()

  handleServerClose(serverName: string): void {
    this.toolManager.evictServer(serverName)
    this.servers.delete(serverName)

    if (this.lifecycleController.signal.aborted) return

    const serverConfig = this.config.servers[serverName]
    const opts = serverConfig?.reconnectOptions
    if (!opts) return

    const attempts = this.reconnectAttempts.get(serverName) ?? 0
    const maxRetries = opts.maxRetries ?? 5
    if (attempts >= maxRetries) {
      console.warn(`mcp-apps: max reconnect attempts reached for "${serverName}"`)
      return
    }

    const factor = opts.backoffFactor ?? 1.5
    const initial = opts.initialDelayMs ?? 1000
    const maxDelay = opts.maxDelayMs ?? 30000
    const delay = Math.min(initial * Math.pow(factor, attempts), maxDelay)

    this.reconnectAttempts.set(serverName, attempts + 1)

    // Avoid double reconnects: drop any timer already pending for this
    // server before scheduling the new one.
    const existingTimer = this.reconnectTimers.get(serverName)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }

    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(serverName)

      if (this.lifecycleController.signal.aborted) return
      // A startServer() for this name is already running (e.g. from a
      // prior reconnect or the initial startAll); don't start a second one.
      if (this.startupTasks.has(serverName)) return

      const task = (async () => {
        try {
          await this.startServer(serverName, serverConfig, this.lifecycleController.signal)
          this.reconnectAttempts.delete(serverName)
        } catch (err) {
          console.error(`mcp-apps: reconnect attempt failed for "${serverName}":`, err)
        } finally {
          this.startupTasks.delete(serverName)
        }
      })()
      this.startupTasks.set(serverName, task)
      await task
    }, delay)
    this.reconnectTimers.set(serverName, timer)
  }

  async stopAll(): Promise<void> {
    this.lifecycleController.abort()
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer)
    }
    this.reconnectTimers.clear()
    this.reconnectAttempts.clear()

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
