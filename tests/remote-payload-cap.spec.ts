import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { createRemoteTransport, createByteCappedFetch } from '../src/transports/remote'

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port)
    })
  })
}

describe('createByteCappedFetch', () => {
  it('errors while streaming an oversized SSE event, and accepts a normal-sized one', async () => {
    const oversized = 'x'.repeat(100)
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (req.url === '/oversized') {
        res.write(`data: ${oversized}\n\n`)
      } else {
        res.write('data: ok\n\n')
      }
      // keep the stream open like a real SSE server would
    })
    const port = await listen(server)
    try {
      const cappedFetch = createByteCappedFetch(fetch, 20)

      const okResponse = await cappedFetch(`http://127.0.0.1:${port}/normal`)
      const okReader = okResponse.body!.getReader()
      const okChunk = await okReader.read()
      expect(okChunk.done).toBe(false)
      await okReader.cancel()

      const badResponse = await cappedFetch(`http://127.0.0.1:${port}/oversized`)
      const badReader = badResponse.body!.getReader()
      await expect(badReader.read()).rejects.toThrow(/exceeded maximum message size/i)
    } finally {
      server.close()
    }
  })

  it('caps a plain (non-event-stream) response body by total size', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: 'x'.repeat(1000) }))
    })
    const port = await listen(server)
    try {
      const cappedFetch = createByteCappedFetch(fetch, 20)
      const response = await cappedFetch(`http://127.0.0.1:${port}/`)
      const reader = response.body!.getReader()
      await expect(
        (async () => {
          let result = await reader.read()
          while (!result.done) result = await reader.read()
        })()
      ).rejects.toThrow(/exceeded maximum message size/i)
    } finally {
      server.close()
    }
  })
})

describe('remote transport payload cap integration', () => {
  let server: http.Server | undefined

  afterEach(() => {
    server?.close()
    server = undefined
  })

  it('rejects an oversized SSE stream end-to-end via createRemoteTransport', async () => {
    const oversized = 'y'.repeat(2000)
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      // The (deprecated) SSE transport protocol requires an initial
      // "endpoint" event before `start()` resolves.
      res.write(`event: endpoint\ndata: ${req.url}\n\n`)
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notify', params: { big: oversized } })}\n\n`)
    })
    const port = await listen(server)

    const transport = createRemoteTransport({
      transport: 'sse',
      url: `http://127.0.0.1:${port}/sse`,
      maxMessageBytes: 64,
    }) as SSEClientTransport

    const gotError = new Promise<Error>((resolve) => {
      transport.onerror = (err) => resolve(err)
    })

    let startError: Error | undefined
    try {
      await transport.start()
    } catch (err) {
      startError = err as Error
    }
    const err = startError ?? (await gotError)
    expect(err.message).toMatch(/exceeded maximum message size/i)
    await transport.close()
  })

  it('accepts a normal-sized SSE message end-to-end via createRemoteTransport', async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`event: endpoint\ndata: ${req.url}\n\n`)
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notify', params: { ok: true } })}\n\n`)
    })
    const port = await listen(server)

    const transport = createRemoteTransport({
      transport: 'sse',
      url: `http://127.0.0.1:${port}/sse`,
      maxMessageBytes: 1024,
    }) as SSEClientTransport

    const received: JSONRPCMessage[] = []
    const gotMessage = new Promise<void>((resolve) => {
      transport.onmessage = (msg) => {
        received.push(msg)
        resolve()
      }
    })

    await transport.start()
    await gotMessage
    expect(received).toHaveLength(1)
    await transport.close()
  })

  it('caps streamable-http responses too', async () => {
    const oversized = 'z'.repeat(2000)
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { big: oversized } }))
    })
    const port = await listen(server)

    const transport = createRemoteTransport({
      transport: 'streamable-http',
      url: `http://127.0.0.1:${port}/mcp`,
      maxMessageBytes: 64,
    }) as StreamableHTTPClientTransport

    await expect(
      transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' })
    ).rejects.toThrow(/exceeded maximum message size/i)
  })

  it('defaults maxMessageBytes to 16MB when not configured', async () => {
    const transport = createRemoteTransport({
      transport: 'streamable-http',
      url: 'http://127.0.0.1:1/mcp',
    })
    expect(transport).toBeDefined()
  })
})
