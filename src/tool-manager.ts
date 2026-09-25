import crypto from 'node:crypto'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { getToolUiResourceUri, isToolVisibilityModelOnly } from '@modelcontextprotocol/ext-apps/app-bridge'
import type { AppSessionStore } from './session-store'
import type { ServerConfig } from './config'

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

export interface ToolsService {
  register(definition: unknown): () => void
}

export class ServerToolManager {
  private toolsService: ToolsService
  private sessionStore: AppSessionStore
  private disposers = new Map<string, Map<string, () => void>>()
  private uiTools = new Map<string, UiToolDescriptor>()

  constructor(toolsService: ToolsService, sessionStore: AppSessionStore) {
    this.toolsService = toolsService
    this.sessionStore = sessionStore
  }

  syncServerTools(serverName: string, client: Client, tools: Tool[], serverConfig?: ServerConfig): void {
    const existingServerDisposers = this.disposers.get(serverName) ?? new Map<string, () => void>()
    const nextServerDisposers = new Map<string, () => void>()
    const allowedReverseTools = serverConfig?.allowAppToolCalls === true
      ? new Set(tools.filter(t => !isToolVisibilityModelOnly(t)).map(t => t.name))
      : new Set<string>()

    for (const tool of tools) {
      const publicName = publicToolName(serverName, tool.name)
      const resourceUri = getToolUiResourceUri(tool) ?? (tool._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri

      if (resourceUri) {
        this.uiTools.set(publicName, {
          serverName,
          rawName: tool.name,
          publicName,
          resourceUri,
        })
      } else {
        this.uiTools.delete(publicName)
      }

      // If tool was already registered, retain its existing disposer unless updated
      const existingDisposer = existingServerDisposers.get(publicName)
      if (existingDisposer) {
        nextServerDisposers.set(publicName, existingDisposer)
        existingServerDisposers.delete(publicName)
        continue
      }

      // Create DSH ToolDefinition
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
        execute: async (args: unknown, exec?: { agent?: { id?: string }; rootCallId?: string; callId?: string }) => {
          const argumentsValue = typeof args === 'object' && args !== null && !Array.isArray(args) ? args : {}
          const result = await client.callTool({
            name: tool.name,
            arguments: argumentsValue as Record<string, unknown>,
          })
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
    }

    // Clean up any tools that were removed from the server
    for (const [removedPublicName, dispose] of existingServerDisposers.entries()) {
      try {
        dispose()
      } catch {
        // Ignored
      }
      this.uiTools.delete(removedPublicName)
    }

    this.disposers.set(serverName, nextServerDisposers)
  }

  evictServer(serverName: string): void {
    const serverDisposers = this.disposers.get(serverName)
    if (serverDisposers) {
      for (const [publicName, dispose] of serverDisposers.entries()) {
        try {
          dispose()
        } catch {
          // Ignored
        }
        this.uiTools.delete(publicName)
      }
      this.disposers.delete(serverName)
    }
  }

  disposeAll(): void {
    for (const [serverName] of this.disposers.entries()) {
      this.evictServer(serverName)
    }
    this.uiTools.clear()
  }

  getUiToolsSnapshot(): UiToolDescriptor[] {
    return Array.from(this.uiTools.values())
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
