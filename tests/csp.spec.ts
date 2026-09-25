import { describe, it, expect } from 'vitest'
import { sanitizeDomains, buildDynamicCsp, withContentSecurityPolicy } from '../src/client/csp'

describe('Dynamic CSP Sanitization & Synthesis', () => {
  it('strips comment injection, private/loopback IPs, and bare http', () => {
    const raw = [
      '<!--comment-->https://evil.com',
      'http://insecure.com',
      '127.0.0.1:8080',
      'localhost',
      '192.168.1.1',
      '10.0.0.1',
      '169.254.1.1',
      'https://*.example.com',
      'wss://realtime.example.com',
      'api.example.com',
      'cdn.jsdelivr.net:443',
      '*', // Wildcard: MUST BE STRIPPED
      'evil.com; script-src *', // Semicolon injection: MUST BE STRIPPED
      'malicious space.com', // Spaces: MUST BE STRIPPED
    ]
    const sanitized = sanitizeDomains(raw)
    expect(sanitized).toEqual([
      'https://*.example.com',
      'wss://realtime.example.com',
      'api.example.com',
      'cdn.jsdelivr.net:443',
    ])
  })

  it('buildDynamicCsp does not contain bare https: in img-src', () => {
    const csp = buildDynamicCsp()
    expect(csp).not.toMatch(/img-src[^;]*\bhttps:\b/)
    expect(csp).toContain('img-src data: blob:')
  })

  it('injects meta tag as the very first element of head', () => {
    const html = '<html><head><script src="app.js"></script><title>App</title></head><body></body></html>'
    const result = withContentSecurityPolicy(html)
    const headContent = result.match(/<head[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? ''
    expect(headContent.trim().startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true)
  })

  it('builds restrictive CSP with fallback when domains are empty', () => {
    const policy = buildDynamicCsp()
    expect(policy).toContain("default-src 'none'")
    expect(policy).toContain("script-src 'unsafe-inline' 'unsafe-eval' blob: data:")
    expect(policy).toContain("form-action 'none'")
    expect(policy).toContain("base-uri 'none'")
  })

  it('incorporates valid resource and connect domains into CSP', () => {
    const policy = buildDynamicCsp(
      { resourceDomains: ['cdn.example.com'], connectDomains: ['api.example.com'] },
      { connectDomains: ['ws.example.com'] }
    )

    expect(policy).toContain('cdn.example.com')
    expect(policy).toContain("connect-src 'self' data: blob: api.example.com ws.example.com")
  })

  it('injects meta CSP tag into HTML document head', () => {
    const html = '<html><head><title>Test App</title></head><body>Hello</body></html>'
    const result = withContentSecurityPolicy(html, { resourceDomains: ['cdn.example.com'] })

    expect(result).toContain('<meta http-equiv="Content-Security-Policy" content="')
    expect(result).toContain('cdn.example.com')
    expect(result).toContain('<title>Test App</title>')
  })
})
