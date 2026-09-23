const DOMAIN_REGEX = /^(https?:\/\/)?((([a-zA-Z0-9][-a-zA-Z0-9]*\.)+[a-zA-Z0-9]{2,})|localhost|(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}))(:\d{1,5})?$/

export function sanitizeDomains(rawDomains?: unknown): string[] {
  if (!Array.isArray(rawDomains)) return []
  return rawDomains
    .filter((d): d is string => typeof d === 'string')
    .map(d => d.trim())
    .filter(d => d !== '*' && !d.includes(';') && !d.includes(' ') && DOMAIN_REGEX.test(d))
}

export function buildDynamicCsp(
  csp?: Record<string, string[]>,
  permissions?: Record<string, string[]>
): string {
  const resourceDomains = [
    ...sanitizeDomains(csp?.resourceDomains),
    ...sanitizeDomains(permissions?.resourceDomains),
  ]

  const connectDomains = [
    ...sanitizeDomains(csp?.connectDomains),
    ...sanitizeDomains(permissions?.connectDomains),
  ]

  const frameDomains = [
    ...sanitizeDomains(csp?.frameDomains),
    ...sanitizeDomains(permissions?.frameDomains),
  ]

  const resourceStr = resourceDomains.length > 0 ? ` ${resourceDomains.join(' ')}` : ''
  const connectStr = connectDomains.length > 0 ? ` 'self' data: blob: ${connectDomains.join(' ')}` : " 'self' data: blob:"
  const frameStr = frameDomains.length > 0 ? ` ${frameDomains.join(' ')}` : " 'none'"

  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' blob: data:${resourceStr}`.trim(),
    `style-src 'unsafe-inline' blob: data:${resourceStr}`.trim(),
    `img-src data: blob: https:${resourceStr}`.trim(),
    `font-src data: blob:${resourceStr}`.trim(),
    `media-src data: blob:${resourceStr}`.trim(),
    `connect-src${connectStr}`.trim(),
    `frame-src${frameStr}`.trim(),
    `worker-src blob: data:`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
}

export function withContentSecurityPolicy(
  html: string,
  csp?: Record<string, string[]>,
  permissions?: Record<string, string[]>
): string {
  const policy = buildDynamicCsp(csp, permissions)
  const metaTag = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}">`

  if (/<head(?:\s[^>]*)?>/i.test(html)) {
    return html.replace(/<head(?:\s[^>]*)?>/i, match => `${match}${metaTag}`)
  }
  return `${metaTag}${html}`
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
}
