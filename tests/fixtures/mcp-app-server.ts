import { appendFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const delayMs = Number(process.argv.find(value => value.startsWith('--delay-ms='))?.split('=')[1] ?? 0)
const serverName = process.argv.find(value => value.startsWith('--server='))?.split('=')[1] ?? 'demo'
const uri = `ui://${serverName}/app`
const eventFile = process.env.MCP_SMOKE_EVENT_FILE
const bundlePath = new URL('../../node_modules/@modelcontextprotocol/ext-apps/dist/src/app-with-deps.js', import.meta.url)
const appSdkBundle = await readFile(bundlePath, 'utf8')
let refreshCount = 0

if (delayMs > 0) await delay(delayMs)

function record(event: Record<string, unknown>) {
  if (!eventFile) return
  // stdio is the MCP transport, so the fixture records evidence to a file.
  appendFileSync(eventFile, `${JSON.stringify(event)}\n`)
}

function htmlForApp(name: string) {
  const bundleData = `data:text/javascript;base64,${Buffer.from(appSdkBundle).toString('base64')}`
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>DSH MCP App fixture</title></head>
<body>
  <main>
    <h1>DSH MCP APP FIXTURE</h1>
    <p id="input">Waiting for tool input</p>
    <p id="result">Waiting for tool result</p>
    <p id="refresh-result">Refresh not called</p>
    <button id="refresh" type="button">Refresh</button>
  </main>
  <script type="module">
    import { App } from '${bundleData}';
    const app = new App({ name: 'dsh-mcp-apps-smoke', version: '1.0.0' });
    const input = document.querySelector('#input');
    const result = document.querySelector('#result');
    const refreshed = document.querySelector('#refresh-result');
    app.ontoolinput = ({ arguments: args }) => {
      input.textContent = 'Input city: ' + (args?.city ?? 'missing');
    };
    app.ontoolresult = ({ structuredContent, content }) => {
      result.textContent = 'Result: ' + (structuredContent?.forecast ?? content?.[0]?.text ?? 'missing');
    };
    document.querySelector('#refresh').addEventListener('click', async event => {
      window.__smokeTrustedClick = event.isTrusted;
      refreshed.textContent = 'Calling refresh';
      console.log('Smoke Refresh clicked; trusted:', event.isTrusted, 'host capabilities:', app.getHostCapabilities());
      try {
        const response = await app.callServerTool({ name: 'refresh', arguments: { city: 'Nairobi' } });
        refreshed.textContent = 'Refreshed: ' + response.structuredContent?.refreshCount + ' / ' + response.structuredContent?.forecast;
      } catch (error) {
        refreshed.textContent = 'Refresh rejected: ' + (error?.message ?? String(error));
        console.error('Smoke Refresh failed:', error);
      }
    });
    await app.connect();
  </script>
</body></html>`
}

const server = new McpServer({ name: `dsh-smoke-${serverName}`, version: '1.0.0' })
server.registerTool('weather', {
  description: 'Return the fixture weather card for a city.',
  inputSchema: { city: z.string() },
  _meta: { ui: { resourceUri: uri } },
}, async ({ city }) => {
  record({ type: 'weather', server: serverName, city })
  return {
    content: [{ type: 'text', text: `Fixture weather for ${city}: clear` }],
    structuredContent: { city, forecast: `clear in ${city}`, marker: 'MCP_APP_INPUT_RESULT_42' },
  }
})
server.registerTool('refresh', {
  description: 'Refresh the fixture weather result.',
  inputSchema: { city: z.string() },
}, async ({ city }) => {
  refreshCount += 1
  record({ type: 'refresh', server: serverName, city, refreshCount })
  return {
    content: [{ type: 'text', text: `Fixture refresh ${refreshCount}: clear in ${city}` }],
    structuredContent: { city, forecast: `clear in ${city}`, refreshCount },
  }
})
server.registerResource('app', new ResourceTemplate(uri, { list: undefined }), {
  mimeType: 'text/html;profile=mcp-app',
  _meta: { ui: { resourceUri: uri } },
}, async resourceUri => ({
  // The hostile test request must be stopped by the host's session/server check.
  contents: [{ uri: resourceUri.href, mimeType: 'text/html;profile=mcp-app', text: htmlForApp(serverName) }],
}))
server.registerResource('private', 'ui://other/private', {
  mimeType: 'text/html;profile=mcp-app',
}, async resourceUri => {
  record({ type: 'privateResourceRead', server: serverName, uri: resourceUri.href })
  return { contents: [{ uri: resourceUri.href, mimeType: 'text/html;profile=mcp-app', text: 'PRIVATE_RESOURCE_MARKER' }] }
})

const transport = new StdioServerTransport()
await server.connect(transport)
record({ type: 'ready', server: serverName, pid: process.pid })

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    record({ type: 'shutdown', server: serverName, pid: process.pid })
    void server.close().finally(() => process.exit(0))
  })
}
