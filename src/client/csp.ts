function isPrivateOrLoopbackHost(host: string): boolean {
  const cleanHost = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (cleanHost === 'localhost' || cleanHost === '::1' || cleanHost === '0.0.0.0') return true
  if (cleanHost.startsWith('fe80:')) return true

  const ipv4Match = cleanHost.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4Match) {
    const [, o1, o2, o3, o4] = ipv4Match.map(Number)
    if (o1 > 255 || o2 > 255 || o3 > 255 || o4 > 255) return true
    if (o1 === 127) return true // Loopback 127.0.0.0/8
    if (o1 === 10) return true // Private 10.0.0.0/8
    if (o1 === 172 && o2 >= 16 && o2 <= 31) return true // Private 172.16.0.0/12
    if (o1 === 192 && o2 === 168) return true // Private 192.168.0.0/16
    if (o1 === 169 && o2 === 254) return true // Link-local 169.254.0.0/16
    if (o1 === 0) return true
  }
  return false
}

const DOMAIN_PATTERN = /^([a-zA-Z0-9][-a-zA-Z0-9]*\.)+[a-zA-Z]{2,}$/
const PUBLIC_IPV4_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

export function sanitizeDomains(rawDomains?: unknown): string[] {
  if (!Array.isArray(rawDomains)) return []
  return rawDomains
    .filter((d): d is string => typeof d === 'string')
    .map(d => d.trim())
    .filter(d => {
      if (d === '*' || d.includes(';') || d.includes(' ') || d.includes('<!--') || d.includes('-->')) return false
      if (/^http:\/\//i.test(d)) return false

      let hostWithPort = d.replace(/^(https|wss|ws):\/\//i, '')
      if (hostWithPort.includes('://')) return false

      const parts = hostWithPort.split(':')
      if (parts.length > 2) return false
      if (parts.length === 2 && !/^\d{1,5}$/.test(parts[1])) return false

      const host = parts[0]
      if (isPrivateOrLoopbackHost(host)) return false

      const hostToCheck = host.startsWith('*.') ? host.slice(2) : host
      return DOMAIN_PATTERN.test(hostToCheck) || PUBLIC_IPV4_PATTERN.test(hostToCheck)
    })
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
    `img-src data: blob:${resourceStr}`.trim(),
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

  if (typeof DOMParser !== 'undefined') {
    const parser = new DOMParser()
    const doc = parser.parseFromString(html, 'text/html')
    const meta = doc.createElement('meta')
    meta.httpEquiv = 'Content-Security-Policy'
    meta.content = policy
    if (doc.head.firstChild) {
      doc.head.insertBefore(meta, doc.head.firstChild)
    } else {
      doc.head.appendChild(meta)
    }
    return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML
  }

  // No DOMParser available (e.g. non-browser environment): don't attempt to
  // locate <head> with a regex, since it can be defeated by content that
  // merely looks like a head tag (comments, attribute values, etc). The
  // HTML parser hoists a leading <meta> into <head> before any script can
  // run, so prepending it at the very start of the document is sufficient
  // and cannot be bypassed by anything appearing later in the markup.
  const doctypeMatch = html.match(/^\s*<!doctype[^>]*>/i)
  if (doctypeMatch) {
    const [doctype] = doctypeMatch
    return html.slice(0, doctype.length) + metaTag + html.slice(doctype.length)
  }
  return metaTag + html
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
}
