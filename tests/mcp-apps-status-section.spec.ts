// @vitest-environment jsdom
import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpAppsStatusSection } from '../src/client/McpAppsStatusSection'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

function makeStatus(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: 'analytics',
    transport: 'stdio',
    connected: true,
    toolCount: 4,
    uiToolCount: 1,
    tools: [
      { rawName: 'model_tool', publicName: 'mcp__analytics__model_tool', visibility: 'model', hasUi: false },
      { rawName: 'app_secret_button', publicName: 'mcp__analytics__app_secret_button', visibility: 'app', hasUi: false },
      { rawName: 'render_chart', publicName: 'mcp__analytics__render_chart', visibility: 'both', hasUi: true },
      { rawName: 'query_db', publicName: 'mcp__analytics__query_db', visibility: 'both', hasUi: false },
    ],
    ...overrides,
  }
}

describe('McpAppsStatusSection', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  afterEach(() => {
    if (root) act(() => root!.unmount())
    container?.remove()
    container = undefined
    root = undefined
    vi.restoreAllMocks()
  })

  async function renderSection(call: ReturnType<typeof vi.fn>) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(React.createElement(McpAppsStatusSection, {
        connection: { rpc: { call } } as any,
      }))
      await Promise.resolve()
    })
  }

  function getRowButton(name: string) {
    return container!.querySelector(`[data-mcp-apps-status-row="${name}"] button`) as HTMLButtonElement
  }

  it('is collapsed by default and does not render tool names', async () => {
    const call = vi.fn(async () => ({ ok: true as const, value: [makeStatus()] }))
    await renderSection(call)

    expect(container!.textContent).toContain('analytics')
    expect(container!.textContent).not.toContain('render_chart')
    const detail = container!.querySelector('[data-mcp-apps-status-detail="analytics"]')
    expect(detail).toBeNull()
  })

  it('expanding a row reveals tool names grouped by visibility', async () => {
    const call = vi.fn(async () => ({ ok: true as const, value: [makeStatus()] }))
    await renderSection(call)

    const row = getRowButton('analytics')
    await act(async () => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const detail = container!.querySelector('[data-mcp-apps-status-detail="analytics"]')
    expect(detail).not.toBeNull()
    expect(detail!.textContent).toContain('Model')
    expect(detail!.textContent).toContain('App-only')
    expect(detail!.textContent).toContain('Both')
    expect(detail!.textContent).toContain('model_tool')
    expect(detail!.textContent).toContain('app_secret_button')
    expect(detail!.textContent).toContain('render_chart')
    expect(detail!.textContent).toContain('query_db')
    // hasUi indicator
    expect(detail!.textContent).toContain('(UI)')
  })

  it('filter input narrows the visible tool names case-insensitively', async () => {
    const call = vi.fn(async () => ({ ok: true as const, value: [makeStatus()] }))
    await renderSection(call)

    const row = getRowButton('analytics')
    await act(async () => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const input = container!.querySelector('[data-mcp-apps-status-detail="analytics"] input') as HTMLInputElement
    expect(input).not.toBeNull()

    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(input, 'CHART')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const detail = container!.querySelector('[data-mcp-apps-status-detail="analytics"]')!
    expect(detail.textContent).toContain('render_chart')
    expect(detail.textContent).not.toContain('query_db')
    expect(detail.textContent).not.toContain('model_tool')
    expect(detail.textContent).not.toContain('app_secret_button')
  })

  it('ignores malformed tool entries without dropping the whole server', async () => {
    const call = vi.fn(async () => ({
      ok: true as const,
      value: [makeStatus({
        tools: [
          { rawName: 'good_tool', publicName: 'mcp__analytics__good_tool', visibility: 'both', hasUi: false },
          { rawName: 'bad_tool', publicName: 'mcp__analytics__bad_tool', visibility: 'not-a-visibility', hasUi: false },
          { rawName: 42, publicName: 'mcp__analytics__oops', visibility: 'model', hasUi: false },
        ],
      })],
    }))
    await renderSection(call)

    const row = getRowButton('analytics')
    await act(async () => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const detail = container!.querySelector('[data-mcp-apps-status-detail="analytics"]')!
    expect(detail.textContent).toContain('good_tool')
    expect(detail.textContent).not.toContain('bad_tool')
  })

  it('is a real button and toggles expansion via keyboard (Enter and Space)', async () => {
    const call = vi.fn(async () => ({ ok: true as const, value: [makeStatus()] }))
    await renderSection(call)

    const row = getRowButton('analytics')
    expect(row.tagName).toBe('BUTTON')
    expect(row.getAttribute('aria-expanded')).toBe('false')

    await act(async () => {
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(container!.querySelector('[data-mcp-apps-status-detail="analytics"]')).not.toBeNull()

    await act(async () => {
      row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
    })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(container!.querySelector('[data-mcp-apps-status-detail="analytics"]')).toBeNull()
  })

  it('shows a readable connection state, not just a color', async () => {
    const call = vi.fn(async () => ({
      ok: true as const,
      value: [makeStatus({ name: 'connected-server', connected: true }), makeStatus({ name: 'down-server', connected: false })],
    }))
    await renderSection(call)

    const connectedRow = container!.querySelector('[data-mcp-apps-status-row="connected-server"]')!
    const downRow = container!.querySelector('[data-mcp-apps-status-row="down-server"]')!
    expect(connectedRow.textContent).toContain('Connected')
    expect(downRow.textContent).toContain('Disconnected')
  })

  it('group headers include a tool count', async () => {
    const call = vi.fn(async () => ({ ok: true as const, value: [makeStatus()] }))
    await renderSection(call)

    const row = getRowButton('analytics')
    await act(async () => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const detail = container!.querySelector('[data-mcp-apps-status-detail="analytics"]')!
    expect(detail.textContent).toContain('Model (1)')
    expect(detail.textContent).toContain('App-only (1)')
    expect(detail.textContent).toContain('Both (2)')
  })

  it('highlights the matched substring in filtered tool names', async () => {
    const call = vi.fn(async () => ({ ok: true as const, value: [makeStatus()] }))
    await renderSection(call)

    const row = getRowButton('analytics')
    await act(async () => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const input = container!.querySelector('[data-mcp-apps-status-detail="analytics"] input') as HTMLInputElement
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(input, 'chart')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const detail = container!.querySelector('[data-mcp-apps-status-detail="analytics"]')!
    // Still shows the right filtered set.
    expect(detail.textContent).toContain('render_chart')
    expect(detail.textContent).not.toContain('query_db')
    // The matched substring is wrapped for emphasis.
    const mark = detail.querySelector('mark')
    expect(mark).not.toBeNull()
    expect(mark!.textContent!.toLowerCase()).toBe('chart')
  })

  it('renders a Disconnect button for authenticated OAuth servers and dispatches disconnect RPC on click', async () => {
    const call = vi.fn(async (_path: string, endpoint: string) => {
      if (endpoint === 'mcp-apps/servers/status') {
        return {
          ok: true as const,
          value: [makeStatus({ name: 'powerhive', oauth: { state: 'authenticated' } })],
        }
      }
      if (endpoint === 'mcp-apps/oauth/disconnect') {
        return { ok: true as const, value: { disconnected: true } }
      }
      return { ok: true as const, value: [] }
    })
    await renderSection(call)

    const disconnectBtn = container!.querySelector('[title="Disconnect powerhive"]') as HTMLSpanElement
    expect(disconnectBtn).not.toBeNull()
    expect(disconnectBtn.textContent).toBe('Disconnect')

    await act(async () => {
      disconnectBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(call).toHaveBeenCalledWith('/api', 'mcp-apps/oauth/disconnect', { server: 'powerhive' })
    // Ensure clicking Disconnect did NOT expand the row accordion
    expect(container!.querySelector('[data-mcp-apps-status-detail="powerhive"]')).toBeNull()
  })

  it('renders a Retry button for disconnected servers and dispatches retry RPC on click', async () => {
    const call = vi.fn(async (_path: string, endpoint: string) => {
      if (endpoint === 'mcp-apps/servers/status') {
        return {
          ok: true as const,
          value: [makeStatus({ name: 'powerhive', connected: false, oauth: { state: 'authenticated' }, lastError: 'fetch failed' })],
        }
      }
      if (endpoint === 'mcp-apps/servers/retry') {
        return { ok: true as const, value: { retried: true } }
      }
      return { ok: true as const, value: [] }
    })
    await renderSection(call)

    const retryBtn = container!.querySelector('[title="Retry connecting to powerhive"]') as HTMLSpanElement
    expect(retryBtn).not.toBeNull()
    expect(retryBtn.textContent).toBe('Retry')

    await act(async () => {
      retryBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(call).toHaveBeenCalledWith('/api', 'mcp-apps/servers/retry', { server: 'powerhive' })
    expect(container!.querySelector('[data-mcp-apps-status-detail="powerhive"]')).toBeNull()
  })
})
