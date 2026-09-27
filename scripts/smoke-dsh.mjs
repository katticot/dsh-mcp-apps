#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { chromium } from '@playwright/test'

const repo = path.resolve(import.meta.dirname, '..')
const tarball = process.argv[2] && path.resolve(process.argv[2])
if (!tarball) {
  console.error('Usage: node scripts/smoke-dsh.mjs <packed-plugin.tgz> [--policy=allow|deny|approve]')
  process.exit(2)
}
const policy = process.argv.find(arg => arg.startsWith('--policy='))?.split('=')[1] ?? 'allow'
if (!['allow', 'deny', 'approve'].includes(policy)) throw new Error(`Unsupported policy: ${policy}`)

const work = await mkdtemp(path.join(tmpdir(), 'dsh-mcp-apps-smoke-'))
const dshHome = path.join(work, 'dsh-home')
const profile = path.join(dshHome, 'profiles', 'web')
const workspaceDirectory = path.join(work, 'workspace')
const seedPluginDirectory = path.join(work, 'workspace-seed')
const eventFile = path.join(work, 'fixture-events.jsonl')
const dshLogs = path.join(work, 'dsh.log')
const evidencePath = path.join(tmpdir(), `dsh-mcp-apps-smoke-${process.pid}-${policy}.png`)
const fixturePath = path.join(repo, 'tests/fixtures/mcp-app-server.ts')
const fixturePids = new Set()
let dsh
let mock
let browser
let page
let authenticatedUrl
let cleanupComplete = false
const appSessionTokens = new Set()

function log(message) { console.log(`[smoke:${policy}] ${message}`) }
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(error => error ? reject(error) : resolve(address.port))
    })
  })
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repo, encoding: 'utf8', stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}`)
}
async function waitFor(predicate, description, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs
  let lastError
  while (Date.now() < end) {
    if (dsh && dsh.exitCode !== null) throw new Error(`DSH exited (${dsh.exitCode}); see ${dshLogs}`)
    try { if (await predicate()) return } catch (error) { lastError = error }
    await delay(250)
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError}` : ''}`)
}
async function appendPluginConfig(defaultTimeoutMs = 30_000) {
  const command = process.execPath
  const args = ['--experimental-strip-types', fixturePath, '--delay-ms=25000']
  const content = `- id: session-title-llm\n  disabled: true\n- insert:\n    - id: smoke-workspace\n      name: dsh-mcp-apps-smoke-workspace\n    - id: mcp-apps\n      name: dsh-mcp-apps\n      config:\n        defaultTimeoutMs: ${defaultTimeoutMs}\n        servers:\n          demo:\n            transport: stdio\n            command: ${JSON.stringify(command)}\n            args: ${JSON.stringify(args)}\n            env:\n              MCP_SMOKE_EVENT_FILE: ${JSON.stringify(eventFile)}\n              DSH_MCP_APPS_SMOKE_POLICY: ${policy}\n            allowAppToolCalls: ${policy}\n`
  await writeFile(path.join(profile, 'cordis.patch.yml'), content)
}
function startDsh(port) {
  const output = createWriteStream(dshLogs, { flags: 'a' })
  dsh = spawn('pnpm', ['dlx', '@deepseek-ai/dsh@0.1.5-rc.3', 'web', '--no-open', '--port', String(port)], {
    cwd: work,
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      DEEPSEEK_BASE_URL: `${mock.baseURL}/v1`,
      DEEPSEEK_API_KEY: 'mock-key',
      MCP_SMOKE_EVENT_FILE: eventFile,
      DSH_TELEMETRY_DISABLED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  for (const stream of [dsh.stdout, dsh.stderr]) {
    stream.on('data', chunk => {
      output.write(chunk)
      const match = String(chunk).match(/https?:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/)
      if (match) authenticatedUrl = match[0]
    })
  }
  dsh.once('exit', (code, signal) => log(`DSH exited (${code ?? signal})`))
}
async function readEvents() {
  try { return (await readFile(eventFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
  catch { return [] }
}
function observePage(targetPage) {
  targetPage.on('console', message => log(`browser console ${message.type()}: ${message.text().slice(0, 500)}`))
  targetPage.on('pageerror', error => log(`browser page error: ${error.message}`))
  targetPage.on('requestfailed', request => log(`browser request failed: ${request.method()} ${request.url()} (${request.failure()?.errorText})`))
  targetPage.on('request', request => {
    if (request.url().includes('/api/mcp-apps/tools/call')) {
      try {
        const envelope = JSON.parse(request.postData() ?? '{}')
        log(`browser posted app tool RPC: method=${envelope.method}, tool=${envelope.payload?.name}`)
      } catch { log('browser posted a malformed app tool RPC envelope') }
    }
    if (!request.url().includes('/api/mcp-apps/') || !request.postData()) return
    try {
      const payload = JSON.parse(request.postData()).payload
      if (typeof payload?.sessionToken === 'string') appSessionTokens.add(payload.sessionToken)
    } catch { /* unrelated or non-JSON request */ }
  })
  targetPage.on('response', response => {
    if (response.url().includes('/api/mcp-apps/tools/call')) log(`app tool RPC response: HTTP ${response.status()}`)
  })
}

async function cleanup() {
  if (cleanupComplete) return
  cleanupComplete = true
  await browser?.close().catch(() => {})
  if (dsh && dsh.exitCode === null) {
    dsh.kill('SIGTERM')
    await Promise.race([new Promise(resolve => dsh.once('exit', resolve)), delay(8_000)])
    if (dsh.exitCode === null) dsh.kill('SIGKILL')
  }
  await mock?.close().catch(() => {})
  for (const event of await readEvents()) if (event.type === 'ready' && Number.isInteger(event.pid)) fixturePids.add(event.pid)
  for (const pid of fixturePids) await stopFixture(pid)
  await rm(work, { recursive: true, force: true })
}
async function stopFixture(pid) {
  const ownedProcess = () => {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
    return result.status === 0 && result.stdout.includes(fixturePath)
  }
  if (!ownedProcess()) return
  try { process.kill(pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline && ownedProcess()) await delay(100)
  if (ownedProcess()) process.kill(pid, 'SIGKILL')
  const killDeadline = Date.now() + 2_000
  while (Date.now() < killDeadline && ownedProcess()) await delay(100)
  if (ownedProcess()) throw new Error(`Fixture process ${pid} remained alive after cleanup`)
}
async function stopDsh() {
  if (!dsh || dsh.exitCode !== null) return
  const pid = (await readEvents()).find(event => event.type === 'ready')?.pid
  dsh.kill('SIGTERM')
  await Promise.race([new Promise(resolve => dsh.once('exit', resolve)), delay(8_000)])
  if (dsh.exitCode === null) dsh.kill('SIGKILL')
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const events = await readEvents()
    if (pid === undefined || events.some(event => event.type === 'shutdown' && event.pid === pid)) {
      if (pid !== undefined) await stopFixture(pid)
      return
    }
    await delay(100)
  }
  throw new Error(`Fixture process ${pid} did not record shutdown with DSH`)
}

try {
  log(`using temporary profile ${profile}`)
  await mkdir(workspaceDirectory, { recursive: true })
  await mkdir(seedPluginDirectory, { recursive: true })
  await writeFile(path.join(seedPluginDirectory, 'package.json'), JSON.stringify({ name: 'dsh-mcp-apps-smoke-workspace', version: '1.0.0', type: 'module', main: 'index.js' }, null, 2))
  await writeFile(path.join(seedPluginDirectory, 'index.js'), `export const name = 'dsh-mcp-apps-smoke-workspace';\nexport const inject = ['workspaceRegistry'];\nexport async function apply(ctx) { await ctx.workspaceRegistry.create(${JSON.stringify(workspaceDirectory)}, 'MCP Apps Smoke Workspace'); }\n`)
  mock = await startMockLlmServer({
    host: '127.0.0.1',
    port: await freePort(),
    apiKey: 'mock-key',
    sequence: ['tool_call_success', 'slow_success', 'tool_call_success', 'slow_success'],
    repeatLast: true,
    toolName: 'mcp__demo__weather',
    toolArguments: '{"city":"Nairobi"}',
    successText: 'Fixture tool call complete.',
    chunkDelayMs: 1_000,
  })

  const installEnv = { ...process.env, DSH_HOME: dshHome }
  run('pnpm', ['dlx', '@deepseek-ai/dsh@0.1.5-rc.3', 'plugin', '--profile', 'web', 'add', tarball], { env: installEnv })
  run('pnpm', ['dlx', '@deepseek-ai/dsh@0.1.5-rc.3', 'plugin', '--profile', 'web', 'add', seedPluginDirectory], { env: installEnv })
  await appendPluginConfig()
  const configDump = spawnSync('pnpm', ['dlx', '@deepseek-ai/dsh@0.1.5-rc.3', '--profile', 'web', '--dump-config'], {
    cwd: work, env: installEnv, encoding: 'utf8',
  })
  if (configDump.status !== 0) throw new Error(`DSH --dump-config failed: ${configDump.stderr}`)
  const titleRowStart = configDump.stdout.indexOf('- id: session-title-llm')
  const titleRowEnd = configDump.stdout.indexOf('\n- id:', titleRowStart + 1)
  const titleRow = configDump.stdout.slice(titleRowStart, titleRowEnd === -1 ? undefined : titleRowEnd)
  if (titleRowStart === -1 || !/^  disabled: true$/m.test(titleRow)) {
    throw new Error(`Isolated DSH config dump did not preserve disabled session-title-llm loader metadata: ${titleRow}`)
  }
  log('verified session-title-llm disabled in DSH-composed profile config')

  const profilePackage = JSON.parse(await readFile(path.join(profile, 'package.json'), 'utf8'))
  if (profilePackage.dependencies?.['dsh-mcp-apps'] !== `file:${tarball}`) {
    throw new Error(`Profile did not record the packed artifact dependency: ${profilePackage.dependencies?.['dsh-mcp-apps']}`)
  }
  const require = createRequire(path.join(profile, 'package.json'))
  const installedPackageJson = require.resolve('dsh-mcp-apps/package.json')
  const installedPackagePath = await realpath(installedPackageJson)
  const relativeInstallPath = path.relative(await realpath(profile), installedPackagePath)
  if (relativeInstallPath.startsWith(`..${path.sep}`) || path.isAbsolute(relativeInstallPath) || installedPackagePath.startsWith(`${repo}${path.sep}`)) {
    throw new Error(`Plugin did not resolve from the isolated packed install: ${installedPackagePath}`)
  }
  for (const file of ['package.json', 'lib/index.js', 'lib/client.js']) {
    const packed = spawnSync('tar', ['-xOf', tarball, `package/${file}`], { encoding: 'buffer' })
    if (packed.status !== 0) throw new Error(`Could not read ${file} from packed plugin artifact`)
    const installed = await readFile(path.join(path.dirname(installedPackageJson), file))
    const hash = bytes => createHash('sha256').update(bytes).digest('hex')
    if (hash(installed) !== hash(packed.stdout)) throw new Error(`Installed ${file} bytes differ from packed artifact`)
  }
  log(`installed package resolves from ${installedPackagePath}`)

  const port = await freePort()
  startDsh(port)
  await waitFor(async () => {
    if (!authenticatedUrl) return false
    try { const response = await fetch(authenticatedUrl, { redirect: 'manual' }); return response.status === 303 || response.ok }
    catch { return false }
  }, 'DSH web server readiness', 60_000)

  const systemChrome = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const browserOptions = { headless: true }
  if (!existsSync(chromium.executablePath()) && existsSync(systemChrome)) browserOptions.executablePath = systemChrome
  browser = await chromium.launch(browserOptions)
  page = await browser.newPage()
  observePage(page)
  await page.goto(authenticatedUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(750)
  const continueButton = page.getByRole('button', { name: 'Continue' })
  if (await continueButton.count()) await continueButton.click()
  await page.waitForTimeout(500)
  const workspaceButton = page.getByRole('button', { name: 'Choose workspace' })
  if (await workspaceButton.count()) {
    await workspaceButton.click()
    const workspaceOption = page.getByRole('menuitem', { name: 'MCP Apps Smoke Workspace' })
    await workspaceOption.waitFor({ timeout: 10_000 })
    await workspaceOption.click()
  }
  const uiTools = async () => page.evaluate(async () => {
    const response = await fetch('/api/mcp-apps/tools/list-ui', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'smoke-discovery', method: 'mcp-apps/tools/list-ui', payload: {} }),
    })
    if (!response.ok) throw new Error(`tools/list-ui returned HTTP ${response.status}`)
    const envelope = await response.json()
    if (envelope.type !== 'server-response' || envelope.rpcId !== 'smoke-discovery' || !envelope.result?.ok) {
      throw new Error(`tools/list-ui returned an invalid result: ${JSON.stringify(envelope)}`)
    }
    return envelope.result.value
  })
  const readinessCheckStarted = Date.now()
  const initialUiTools = await uiTools()
  if (!initialUiTools.some(tool => tool.publicName === 'mcp__demo__weather')) {
    log(`fixture tool remains unadvertised after ${Date.now() - readinessCheckStarted}ms; waiting for its delayed stdio readiness`)
    await waitFor(async () => (await uiTools()).some(tool => tool.publicName === 'mcp__demo__weather'), 'delayed fixture tool registration', 45_000)
  }
  if (!(await readEvents()).some(event => event.type === 'ready')) throw new Error('UI tool was advertised before the fixture reported stdio readiness')
  log('fixture tool was advertised after delayed server readiness')
  const inputSummary = await page.locator('textarea,[contenteditable="true"],[role="textbox"]').evaluateAll(elements => elements.map(element => ({
    tag: element.tagName, placeholder: element.getAttribute('placeholder'), aria: element.getAttribute('aria-label'), text: element.textContent,
    contenteditable: element.getAttribute('contenteditable'),
  })))
  log(`initial DSH prompt controls: ${JSON.stringify(inputSummary)}; buttons=${JSON.stringify(await page.getByRole('button').allTextContents())}; body=${(await page.locator('body').innerText()).slice(0, 1800)}`)
  if (inputSummary.length === 0) throw new Error(`Could not find DSH chat input; controls=${JSON.stringify(inputSummary)} log=${dshLogs}`)
  const textbox = page.locator('textarea,[contenteditable="true"],[role="textbox"]').first()
  await textbox.fill('Show the weather for Nairobi.')
  await textbox.press('Enter')

  const frame = page.frameLocator('iframe').first()
  await frame.locator('text=DSH MCP APP FIXTURE').waitFor({ timeout: 60_000 })
  const appFrame = page.frames().find(candidate => candidate !== page.mainFrame())
  if (!appFrame) throw new Error('Could not find the mounted MCP app frame')
  await frame.locator('text=Input city: Nairobi').waitFor({ timeout: 30_000 })
  await frame.locator('text=clear in Nairobi').waitFor({ timeout: 30_000 })
  log('real iframe rendered the fixture tool input and result through DSH')

  const sessionToken = [...appSessionTokens][0]
  if (!sessionToken) throw new Error('Could not capture the actual app session token from resource RPC traffic')
  const isolationResult = await page.evaluate(async sessionToken => {
    const response = await fetch('/api/mcp-apps/resources/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'smoke-cross-server', method: 'mcp-apps/resources/read',
        payload: { sessionToken, server: 'other', uri: 'ui://other/private' },
      }),
    })
    if (!response.ok) throw new Error(`cross-server resource RPC returned HTTP ${response.status}`)
    return (await response.json()).result
  }, sessionToken)
  if (isolationResult?.ok !== false || isolationResult.error?.code !== 'forbidden') {
    throw new Error(`Cross-server resource request was not rejected: ${JSON.stringify(isolationResult)}`)
  }
  log('cross-server resource request using the real demo session token was rejected as forbidden')

  const refreshButton = frame.getByRole('button', { name: 'Refresh' })
  await refreshButton.scrollIntoViewIfNeeded()
  const buttonRect = await refreshButton.evaluate(element => {
    const rect = element.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })
  const iframeBox = await page.locator('iframe').first().boundingBox()
  if (!iframeBox) throw new Error('Could not measure the visible app iframe in the top-level viewport')
  const frameViewport = await appFrame.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight, scrollX, scrollY }))
  const clickPoint = {
    x: iframeBox.x + (buttonRect.x + buttonRect.width / 2) * iframeBox.width / frameViewport.width,
    y: iframeBox.y + (buttonRect.y + buttonRect.height / 2) * iframeBox.height / frameViewport.height,
  }
  const innerHit = await appFrame.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y)
    return { tag: element?.tagName, id: element?.id, text: element?.textContent?.trim() }
  }, { x: buttonRect.x + buttonRect.width / 2, y: buttonRect.y + buttonRect.height / 2 })
  await refreshButton.evaluate(element => element.addEventListener('click', event => { window.__smokeObservedTrusted = event.isTrusted }, { capture: true }))
  const hitTarget = await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y)
    return { tag: element?.tagName, id: element?.id, className: typeof element?.className === 'string' ? element.className : '' }
  }, clickPoint)
  log(`trusted Refresh click at ${JSON.stringify(clickPoint)}; iframe=${JSON.stringify(iframeBox)} localButton=${JSON.stringify(buttonRect)} viewport=${JSON.stringify(frameViewport)} hit=${JSON.stringify(hitTarget)} innerHit=${JSON.stringify(innerHit)}`)
  await page.mouse.click(clickPoint.x, clickPoint.y)
  await page.waitForTimeout(250)
  if (!(await refreshButton.evaluate(() => window.__smokeObservedTrusted === true))) {
    log('page mouse click did not reach the iframe button; retrying with Playwright frame locator')
    await refreshButton.click()
  }
  if (!(await refreshButton.evaluate(() => window.__smokeObservedTrusted === true))) throw new Error('Refresh button did not receive the trusted browser click')
  if (!(await refreshButton.evaluate(() => window.__smokeTrustedClick === true))) throw new Error('Refresh callback did not receive a trusted user click')
  if (policy === 'allow') {
    await frame.locator('text=Refreshed: 1 / clear in Nairobi').waitFor({ timeout: 20_000 })
    log('allow policy completed the second MCP tool call')
  } else if (policy === 'approve') {
    const approvalButton = page.getByRole('button', { name: /allow|approve/i }).first()
    await approvalButton.waitFor({ timeout: 20_000 })
    log(`approval prompt visible; buttons=${JSON.stringify(await page.getByRole('button').allTextContents())}`)
    await approvalButton.click()
    await frame.locator('text=Refreshed: 1 / clear in Nairobi').waitFor({ timeout: 20_000 })
    log('approve policy executed after accepting the actual DSH approval prompt')
  } else {
    const expected = 'Refresh rejected:'
    await frame.locator(`text=${expected}`).waitFor({ timeout: 20_000 })
    const denied = await frame.locator('#refresh-result').textContent()
    if (!denied?.includes(expected)) throw new Error(`${policy} policy did not reject the callback: ${denied}`)
    log(`${policy} policy rejected the app callback (${denied})`)
  }

  const events = await readEvents()
  await page.screenshot({ path: evidencePath, fullPage: true })
  if (!events.some(event => event.type === 'weather' && event.city === 'Nairobi')) throw new Error(`Fixture did not receive the model-delivered input: ${JSON.stringify(events)}`)
  if (events.some(event => event.type === 'privateResourceRead')) throw new Error(`Cross-server resource reached the fixture: ${JSON.stringify(events)}`)
  if (policy === 'allow' && !events.some(event => event.type === 'refresh' && event.refreshCount === 1)) throw new Error(`Allowed refresh did not reach the fixture: ${JSON.stringify(events)}`)

  await appendPluginConfig(31_000)
  const previousReady = (await readEvents()).filter(event => event.type === 'ready')
  await page.close()
  await stopDsh()
  if (!(await readEvents()).some(event => event.type === 'shutdown' && event.pid === previousReady.at(-1)?.pid)) {
    throw new Error('Fixture did not shut down cleanly before profile reload')
  }
  dsh = undefined
  authenticatedUrl = undefined
  startDsh(await freePort())
  await waitFor(async () => {
    if (!authenticatedUrl) return false
    try { const response = await fetch(authenticatedUrl, { redirect: 'manual' }); return response.status === 303 || response.ok }
    catch { return false }
  }, 'restarted DSH web server readiness', 60_000)
  page = await browser.newPage()
  observePage(page)
  await page.goto(authenticatedUrl, { waitUntil: 'domcontentloaded' })
  const restartContinue = page.getByRole('button', { name: 'Continue' })
  if (await restartContinue.count()) await restartContinue.click()
  const restartWorkspace = page.getByRole('button', { name: 'Choose workspace' })
  if (await restartWorkspace.count()) {
    await restartWorkspace.click()
    await page.getByRole('menuitem', { name: 'MCP Apps Smoke Workspace' }).click()
  }
  let restartedUiTools = []
  await waitFor(async () => {
    restartedUiTools = await uiTools()
    return restartedUiTools.some(tool => tool.publicName === 'mcp__demo__weather')
  }, 'fixture tool after profile restart', 45_000)
  if (restartedUiTools.filter(tool => tool.publicName === 'mcp__demo__weather').length !== 1) {
    throw new Error(`Profile restart duplicated the weather tool route: ${JSON.stringify(restartedUiTools)}`)
  }
  if (await page.locator('iframe').count() !== 0) throw new Error('A fresh browser context unexpectedly retained an old app iframe')
  if (policy === 'approve') {
    const restartTextbox = page.locator('textarea,[contenteditable="true"],[role="textbox"]').first()
    await restartTextbox.fill('Show the weather for Nairobi again after reload.')
    await restartTextbox.press('Enter')
    await page.frameLocator('iframe').first().locator('text=DSH MCP APP FIXTURE').waitFor({ timeout: 60_000 })
    const reloadedFrame = page.frameLocator('iframe').first()
    await reloadedFrame.locator('text=Input city: Nairobi').waitFor({ timeout: 30_000 })
    await reloadedFrame.locator('text=clear in Nairobi').waitFor({ timeout: 30_000 })
    if (await page.locator('iframe').count() !== 1) throw new Error('Profile restart duplicated or lost the app iframe')
  }
  const eventsAfterReload = await readEvents()
  const readyEvents = eventsAfterReload.filter(event => event.type === 'ready')
  const weatherEvents = eventsAfterReload.filter(event => event.type === 'weather' && event.city === 'Nairobi')
  const expectedWeatherCalls = policy === 'approve' ? 2 : 1
  if (readyEvents.length !== 2 || readyEvents[0]?.pid === readyEvents[1]?.pid || weatherEvents.length !== expectedWeatherCalls) {
    throw new Error(`Profile restart did not create a fresh fixture execution: ${JSON.stringify(eventsAfterReload)}`)
  }
  log(`profile restart created a fresh stdio server and one weather route${policy === 'approve' ? ' plus a fresh model-selected tool call and one app iframe' : ''}`)
  await page.screenshot({ path: evidencePath, fullPage: true })

  console.log(JSON.stringify({
    result: 'passed',
    dshVersion: '0.1.5-rc.3',
    policy,
    installedPackagePath,
    fixtureEvents: await readEvents(),
    mockRequests: mock.requests.map(request => ({ scriptBehavior: request.scriptBehavior, toolChoice: request.body?.tool_choice })),
    evidencePath,
  }, null, 2))
} catch (error) {
  console.error(error)
  try {
    const dshLog = (await readFile(dshLogs, 'utf8')).replace(/(\?token=)[^&\s]+/g, '$1[redacted]')
    console.error(`DSH log (${dshLogs}):\n${dshLog}`)
  } catch { /* no log yet */ }
  try {
    console.error(`Fixture events: ${JSON.stringify(await readEvents())}`)
    console.error(`Mock LLM requests: ${JSON.stringify(mock?.requests.map(request => ({
      scriptBehavior: request.scriptBehavior,
      toolChoice: request.body?.tool_choice,
      tools: request.body?.tools?.map(tool => tool.function?.name),
      messageRoles: request.body?.messages?.map(message => message.role),
      lastMessageRole: request.body?.messages?.at(-1)?.role,
    })) ?? [])}`)
    if (page) {
      console.error(`Browser body: ${(await page.locator('body').innerText()).slice(0, 8000)}`)
      console.error(`Browser frames: ${JSON.stringify(await Promise.all(page.frames().map(async frame => ({ url: frame.url(), name: frame.name(), body: await frame.locator('body').innerText().catch(() => '') }))))}`)
      await page.screenshot({ path: evidencePath, fullPage: true }).catch(() => {})
      console.error(`Failure screenshot: ${evidencePath}`)
    }
  } catch (diagnosticError) { console.error(`Failure diagnostics error: ${diagnosticError}`) }
  process.exitCode = 1
} finally {
  try { await cleanup() } catch (error) { console.error(`Cleanup failed: ${error}`); process.exitCode = 1 }
}
