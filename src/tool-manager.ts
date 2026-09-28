import crypto from 'node:crypto'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { getToolUiResourceUri, isToolVisibilityModelOnly, isToolVisibilityAppOnly } from '@modelcontextprotocol/ext-apps/app-bridge'
import type { AppSessionStore, AgentSessionId, ToolCallIdentifier } from './session-store'
import { resolveToolCallTimeoutMs, type ServerConfig } from './config'

const MAX_PUBLIC_NAME_LENGTH = 64
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
const HASH_LENGTH = 12

export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) {
    return normalized
  }
  const hash = crypto.createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  const prefix = normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)
  return `${prefix}_${hash}`
}

export interface UiToolDescriptor {
  serverName: string
  rawName: string
  publicName: string
  resourceUri: string
}

/**
 * Minimal, name-only summary of one tool as of the last sync, for the
 * read-only status UI. Deliberately excludes `description` and
 * `inputSchema` — those can carry server-authored free text or schema
 * details we don't want surfacing over the unauthenticated status RPC.
 */
export interface ToolSummary {
  rawName: string
  publicName: string
  visibility: 'model' | 'app' | 'both'
  hasUi: boolean
}

export interface ToolsService {
  register(definition: unknown): () => void
}

export function computeToolFingerprint(tool: Tool, resourceUri?: string): string {
  const content = JSON.stringify({
    description: tool.description ?? '',
    parameters: tool.inputSchema ?? {},
    resourceUri: resourceUri ?? '',
  })
  return crypto.createHash('sha256').update(content).digest('hex')
}

export class ServerToolManager {
  private toolsService: ToolsService
  private sessionStore: AppSessionStore
  private disposers = new Map<string, Map<string, () => void>>()
  private fingerprints = new Map<string, Map<string, string>>()
  private uiTools = new Map<string, UiToolDescriptor>()
  /** Count of every tool seen for a server in its last sync (model + app-only), for `getToolCounts`. Cleared on eviction. */
  private toolCounts = new Map<string, number>()
  /** Name/visibility/hasUi summary of every tool seen for a server in its last sync, for `getToolSummaries`. Cleared on eviction, alongside `toolCounts`. */
  private toolSummaries = new Map<string, ToolSummary[]>()

  private onUiToolsChanged?: () => void
  private defaultTimeoutMs?: number

  constructor(
    toolsService: ToolsService,
    sessionStore: AppSessionStore,
    onUiToolsChanged?: () => void,
    defaultTimeoutMs?: number
  ) {
    this.toolsService = toolsService
    this.sessionStore = sessionStore
    this.onUiToolsChanged = onUiToolsChanged
    this.defaultTimeoutMs = defaultTimeoutMs
  }

  syncServerTools(serverName: string, client: Client, tools: Tool[], serverConfig?: ServerConfig): void {
    const existingServerDisposers = new Map(this.disposers.get(serverName) ?? [])
    const existingServerFingerprints = this.fingerprints.get(serverName) ?? new Map<string, string>()
    const nextServerDisposers = new Map<string, () => void>()
    const nextServerFingerprints = new Map<string, string>()
    const nextServerUiTools = new Map<string, UiToolDescriptor>()

    const otherRegisteredPublicNames = new Set<string>()
    for (const [srv, serverDisposers] of this.disposers.entries()) {
      if (srv !== serverName) {
        for (const name of serverDisposers.keys()) {
          otherRegisteredPublicNames.add(name)
        }
      }
    }
    const assignedPublicNames = new Set<string>()
    let nextServerToolCount = 0
    const nextServerToolSummaries: ToolSummary[] = []

    const isAllowed = serverConfig?.allowAppToolCalls === true || serverConfig?.allowAppToolCalls === 'allow' || serverConfig?.allowAppToolCalls === 'approve'
    const allowedReverseTools = isAllowed
      ? new Set(tools.filter(t => !isToolVisibilityModelOnly(t)).map(t => t.name))
      : new Set<string>()

    try {
      for (const tool of tools) {
        try {
          let resourceUri: string | undefined
          try {
            resourceUri = getToolUiResourceUri(tool) ?? (tool._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri
          } catch (err) {
            console.error(`mcp-apps: invalid UI metadata for tool "${tool.name}", skipping:`, err)
            continue
          }

          if (resourceUri && !resourceUri.startsWith('ui://')) {
            console.error(`mcp-apps: invalid UI resource URI scheme "${resourceUri}" for tool "${tool.name}", skipping`)
            continue
          }

          let publicName = publicToolName(serverName, tool.name)
          if (assignedPublicNames.has(publicName) || otherRegisteredPublicNames.has(publicName)) {
            const disambigHash = crypto.createHash('sha256').update(`${serverName}\0${tool.name}\0${assignedPublicNames.size}`).digest('hex').slice(0, 8)
            publicName = `${publicName.slice(0, 55)}_${disambigHash}`
          }
          assignedPublicNames.add(publicName)
          // Every tool that reaches here is exposed by this plugin in some
          // form (model-visible registration and/or a ui:// app resource),
          // so it counts toward toolCount even if it's app-only below.
          nextServerToolCount++

          if (resourceUri) {
            nextServerUiTools.set(publicName, {
              serverName,
              rawName: tool.name,
              publicName,
              resourceUri,
            })
          }

          const isAppOnly = isToolVisibilityAppOnly(tool)
          const visibility: ToolSummary['visibility'] = isAppOnly
            ? 'app'
            : isToolVisibilityModelOnly(tool)
              ? 'model'
              : 'both'
          nextServerToolSummaries.push({
            rawName: tool.name,
            publicName,
            visibility,
            hasUi: Boolean(resourceUri),
          })

          // App-only tools must not be registered with the LLM in ctx.tools
          if (isAppOnly) {
            continue
          }

          const fingerprint = computeToolFingerprint(tool, resourceUri)
          const existingFingerprint = existingServerFingerprints.get(publicName)
          const existingDisposer = existingServerDisposers.get(publicName)

          if (existingDisposer && existingFingerprint === fingerprint) {
            nextServerDisposers.set(publicName, existingDisposer)
            nextServerFingerprints.set(publicName, fingerprint)
            existingServerDisposers.delete(publicName)
            continue
          }

          if (existingDisposer) {
            try {
              existingDisposer()
            } catch {
              // Ignored
            }
            existingServerDisposers.delete(publicName)
          }

          const definition = {
            name: publicName,
            description: tool.description ?? '',
            parameters: tool.inputSchema,
            output: {
              schema: {
                type: 'object',
                properties: {
                  content: { type: 'array', items: {} },
                  structuredContent: {},
                  _sessionToken: { type: 'string' },
                },
                required: ['content'],
                additionalProperties: false,
              },
              render: (_args: unknown, value: { content: unknown }) => [{
                type: 'text',
                text: extractText(value.content, tool.name),
              }],
              presentationMeta: (_args: unknown, value: unknown) => {
                if (!resourceUri) return {}
                let sessionToken: string | undefined
                let cleanResult = value
                if (typeof value === 'object' && value !== null) {
                  const { _sessionToken, ...rest } = value as Record<string, unknown>
                  sessionToken = typeof _sessionToken === 'string' ? _sessionToken : undefined
                  cleanResult = rest
                }
                return {
                  mcpApp: {
                    serverName,
                    rawToolName: tool.name,
                    resourceUri,
                    sessionToken,
                    result: cleanResult,
                  },
                }
              },
            },
            execute: async (args: unknown, exec?: { agent?: { id?: AgentSessionId }; rootCallId?: ToolCallIdentifier; callId?: ToolCallIdentifier; signal?: AbortSignal }) => {
              const argumentsValue = typeof args === 'object' && args !== null && !Array.isArray(args) ? args : {}
              const timeout = resolveToolCallTimeoutMs(serverConfig, this.defaultTimeoutMs)
              const result = await client.callTool({
                name: tool.name,
                arguments: argumentsValue as Record<string, unknown>,
              }, undefined, { signal: exec?.signal, timeout })
              if (result.isError) {
                throw new Error(extractText(result.content, tool.name) || `Tool "${tool.name}" failed`)
              }
              let sessionToken: string | undefined
              if (resourceUri) {
                const session = this.sessionStore.createSession(
                  serverName,
                  tool.name,
                  resourceUri,
                  allowedReverseTools,
                  {
                    agentId: exec?.agent?.id,
                    callId: exec?.rootCallId ?? exec?.callId,
                  }
                )
                sessionToken = session.sessionToken
              }
              return {
                content: result.content,
                ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
                ...(sessionToken ? { _sessionToken: sessionToken } : {}),
              }
            },
          }

          const disposer = this.toolsService.register(definition)
          nextServerDisposers.set(publicName, disposer)
          nextServerFingerprints.set(publicName, fingerprint)
        } catch (toolErr) {
          console.error(`mcp-apps: failed to register tool "${tool.name}":`, toolErr)
        }
      }
    } finally {
      // Clean up any tools that were removed from the server
      for (const [removedPublicName, dispose] of existingServerDisposers.entries()) {
        try {
          dispose()
        } catch {
          // Ignored
        }
        this.uiTools.delete(removedPublicName)
      }

      // Update UI tools snapshot atomically for this server
      for (const [pubName, descriptor] of this.uiTools.entries()) {
        if (descriptor.serverName === serverName && !nextServerUiTools.has(pubName)) {
          this.uiTools.delete(pubName)
        }
      }
      for (const [pubName, descriptor] of nextServerUiTools.entries()) {
        this.uiTools.set(pubName, descriptor)
      }

      this.disposers.set(serverName, nextServerDisposers)
      this.fingerprints.set(serverName, nextServerFingerprints)
      this.toolCounts.set(serverName, nextServerToolCount)
      this.toolSummaries.set(serverName, nextServerToolSummaries)
      this.onUiToolsChanged?.()
    }
  }

  evictServer(serverName: string): void {
    const serverDisposers = this.disposers.get(serverName)
    if (serverDisposers) {
      for (const [, dispose] of serverDisposers.entries()) {
        try {
          dispose()
        } catch {
          // Ignored
        }
      }
      this.disposers.delete(serverName)
      this.fingerprints.delete(serverName)
    }
    this.toolCounts.delete(serverName)
    this.toolSummaries.delete(serverName)
    for (const [pubName, descriptor] of this.uiTools.entries()) {
      if (descriptor.serverName === serverName) {
        this.uiTools.delete(pubName)
      }
    }
    this.onUiToolsChanged?.()
  }

  disposeAll(): void {
    for (const [serverName] of this.disposers.entries()) {
      this.evictServer(serverName)
    }
    this.uiTools.clear()
    this.fingerprints.clear()
    this.toolCounts.clear()
    this.toolSummaries.clear()
  }

  getUiToolsSnapshot(): UiToolDescriptor[] {
    return Array.from(this.uiTools.values())
  }

  /**
   * Tool counts for one server: `toolCount` is every tool this plugin
   * exposes in some form as of the last sync (model-visible tools
   * registered with the host, plus app-only tools that are never
   * registered with the host but are still reachable via a `ui://`
   * resource), `uiToolCount` is the subset backed by a `ui://` resource.
   * `uiToolCount` is always <= `toolCount`. Note `toolCount` can exceed
   * `this.disposers.get(serverName)?.size`, since app-only tools have no
   * disposer. Used by the read-only status endpoint; never exposes tool
   * names, arguments, or server config.
   */
  getToolCounts(serverName: string): { toolCount: number; uiToolCount: number } {
    const toolCount = this.toolCounts.get(serverName) ?? 0
    let uiToolCount = 0
    for (const descriptor of this.uiTools.values()) {
      if (descriptor.serverName === serverName) uiToolCount++
    }
    return { toolCount, uiToolCount }
  }

  /**
   * Name/visibility/`hasUi` summary of every tool seen for a server in its
   * last sync (empty array if the server has never synced or was evicted).
   * Used by the read-only status endpoint; never includes `description` or
   * `inputSchema`.
   */
  getToolSummaries(serverName: string): ToolSummary[] {
    return this.toolSummaries.get(serverName) ?? []
  }
}

function extractText(content: unknown, toolName: string): string {
  if (!Array.isArray(content)) return `(tool ${toolName} executed)`
  const textBlocks = content
    .filter((item): item is { type: 'text'; text: string } => (
      typeof item === 'object' && item !== null && item.type === 'text' && typeof item.text === 'string'
    ))
    .map(item => item.text)
  return textBlocks.join('\n') || `(tool ${toolName} executed)`
}
