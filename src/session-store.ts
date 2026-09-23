import crypto from 'node:crypto'

export interface AppSession {
  sessionToken: string
  serverName: string
  rawToolName: string
  resourceUri?: string
  allowedReverseTools: Set<string>
  createdAt: number
  expiresAt: number
}

export class AppSessionStore {
  private sessions = new Map<string, AppSession>()
  private ttlMs: number

  constructor(ttlMs: number = 3600 * 1000) {
    this.ttlMs = ttlMs
  }

  createSession(
    serverName: string,
    rawToolName: string,
    resourceUri?: string,
    allowedReverseTools: Iterable<string> = []
  ): AppSession {
    const sessionToken = crypto.randomBytes(32).toString('hex')
    const now = Date.now()
    const session: AppSession = {
      sessionToken,
      serverName,
      rawToolName,
      resourceUri,
      allowedReverseTools: new Set(allowedReverseTools),
      createdAt: now,
      expiresAt: now + this.ttlMs,
    }
    this.sessions.set(sessionToken, session)
    return session
  }

  get(token?: string): AppSession | undefined {
    if (!token) return undefined
    const session = this.sessions.get(token)
    if (!session) return undefined
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(token)
      return undefined
    }
    return session
  }

  delete(token: string): boolean {
    return this.sessions.delete(token)
  }

  prune(): void {
    const now = Date.now()
    for (const [token, session] of this.sessions.entries()) {
      if (now > session.expiresAt) {
        this.sessions.delete(token)
      }
    }
  }

  clear(): void {
    this.sessions.clear()
  }
}
