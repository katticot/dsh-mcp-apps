import { describe, it, expect } from 'vitest'
import { sanitizeDomains, buildDynamicCsp, withContentSecurityPolicy } from '../src/client/csp'

describe('Dynamic CSP Sanitization & Synthesis', () => {
  it('sanitizes valid domains and strips dangerous injection attempts', () => {
    const rawDomains = [
      'api.example.com',
      'cdn.jsdelivr.net:443',
      '*', // Wildcard: MUST BE STRIPPED
      'evil.com; script-src *', // Semicolon injection: MUST BE STRIPPED
      'malicious space.com', // Spaces: MUST BE STRIPPED
      '127.0.0.1:8080',
    ]

    const sanitized = sanitizeDomains(rawDomains)
    expect(sanitized).toEqual([
      'api.example.com',
      'cdn.jsdelivr.net:443',
      '127.0.0.1:8080',
    ])
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
