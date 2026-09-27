import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { act } from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const artifactPath = path.join(root, 'lib/client.js')
const documentedModules = new Set([
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-ui-tool',
  'react',
  'react/jsx-runtime',
])

describe('browser client artifact', () => {
  it('loads and renders a registered tool view in a browser realm without Node globals', async () => {
    const source = readFileSync(artifactPath, 'utf8')
    const loaded = new Map<string, unknown>()
    const requestedModules = new Set<string>()
    const moduleLoader = {
      load(module: { id: string; factory: (require: (id: string) => unknown) => unknown }) {
        loaded.set(module.id, module.factory((id) => {
          requestedModules.add(id)
          if (!documentedModules.has(id)) throw new Error(`Unexpected browser module: ${id}`)
          if (id === 'react') return React
          if (id === 'react/jsx-runtime') return jsxRuntime
          throw new Error(`DSH module is provided by the host loader: ${id}`)
        }))
      },
    }
    const browser = new Proxy({ __ModuleLoader__: moduleLoader }, {
      get(target, property, receiver) {
        if (property === 'process') throw new Error('Browser artifact accessed window.process')
        return Reflect.get(target, property, receiver)
      },
    })

    vm.runInNewContext(source, {
      window: browser,
      console,
      setInterval: () => 1,
      clearInterval: () => undefined,
      setTimeout,
      clearTimeout,
      AbortController,
    }, { filename: artifactPath })

    expect(loaded.has('dsh-mcp-apps')).toBe(true)
    expect([...requestedModules].sort()).toEqual(['react', 'react/jsx-runtime'])
    const plugin = loaded.get('dsh-mcp-apps') as {
      apply?: (ctx: any) => () => void
      inject?: string[]
    }
    expect(plugin.inject).toEqual(['connection', 'slots'])
    expect(typeof plugin.apply).toBe('function')

    let component: ((props: any) => React.ReactElement) | undefined
    const pluginContext = {
      connection: {
        rpc: {
          call: async (_channel: string, endpoint: string) => endpoint === 'mcp-apps/tools/list-ui'
            ? { ok: true, value: [{
                publicName: 'charts_render',
                rawName: 'render',
                resourceUri: 'ui://charts/app',
                serverName: 'charts',
              }] }
            : new Promise(() => undefined),
        },
        generation: { subscribe: () => () => undefined },
      },
      slots: {
        inject: (_name: string, effect: () => () => void) => effect(),
        register: (_descriptor: unknown, view: (props: any) => React.ReactElement) => {
          component = view
          return () => { component = undefined }
        },
      },
      effect: (effect: () => () => void) => effect(),
    }
    const dispose = plugin.apply!(pluginContext)
    await viWaitFor(() => expect(component).toBeDefined())

    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>')
    const container = dom.window.document.querySelector('#root')!
    const root = createRoot(container)
    vi.stubGlobal('window', dom.window)
    vi.stubGlobal('document', dom.window.document)
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    await act(async () => root.render(React.createElement(component!, {
      block: {
        call: { argsRaw: '{}' },
        meta: { mcpApp: {
          serverName: 'charts',
          rawToolName: 'render',
          resourceUri: 'ui://charts/app',
          sessionToken: 'session-1',
          result: { content: [] },
        } },
      },
      toolName: 'charts_render',
      callId: 'call-1',
      openFile: () => undefined,
      loadImage: () => undefined,
    })))
    expect(container.textContent).toContain('Loading MCP App…')
    expect(container.querySelector('[data-mcp-app-tool="render"]')).not.toBeNull()
    await act(async () => root.unmount())
    vi.unstubAllGlobals()
    dom.window.close()
    dispose()
  })

  it('packs every public export and every client chunk referenced by the artifact', () => {
    const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      main: string
      types: string
      exports: Record<string, string | Record<string, string>>
    }
    const artifact = readFileSync(artifactPath, 'utf8')
    const packageFiles = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: root,
      encoding: 'utf8',
    }))[0].files.map((file: { path: string }) => file.path) as string[]
    const publicTargets = [packageJson.main, packageJson.types]
    for (const entry of Object.values(packageJson.exports)) {
      if (typeof entry === 'string') publicTargets.push(entry.replace(/^\.\//, ''))
      else for (const target of Object.values(entry)) publicTargets.push(target.replace(/^\.\//, ''))
    }
    const chunks = [...artifact.matchAll(/(?:require\(|import\s*\(|from\s*)['"](\.\/[^'"]+)['"]/g)]
      .map(match => path.posix.normalize(path.posix.join('lib', match[1]!)))
    const included = new Set(packageFiles)

    for (const target of new Set([...publicTargets, ...chunks])) {
      expect(existsSync(path.join(root, target)), `${target} exists in the build`).toBe(true)
      expect(included.has(target), `${target} is included in npm pack`).toBe(true)
    }
  })
})

async function viWaitFor(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1_000
  while (Date.now() < deadline) {
    try {
      assertion()
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  }
  assertion()
}
