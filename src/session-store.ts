import crypto from 'node:crypto'

export interface AppSession {
  sessionToken: string
  serverName: string
  rawToolName: string
  resourceUri?: string
  allowedReverseTools: Set<string>
  agentId?: string
  callId?: string
  createdAt: number
  expiresAt: number
}

export interface CreateSessionOptions {
  agentId?: string
  callId?: string
}

export class AppSessionStore {
  private sessions = new Map<string, AppSession>()
  private ttlMs: number
  private maxSessions: number
  private pruneTimer?: NodeJS.Timeout | ReturnType<typeof setInterval>

  constructor(
    ttlMs: number = 3600 * 1000,
    maxSessions: number = 1000,
    pruneIntervalMs: number = 60 * 1000
  ) {
    this.ttlMs = ttlMs
    this.maxSessions = maxSessions
    if (pruneIntervalMs > 0) {
      this.pruneTimer = setInterval(() => this.prune(), pruneIntervalMs)
      this.pruneTimer.unref?.()
    }
  }

  createSession(
    serverName: string,
    rawToolName: string,
    resourceUri?: string,
    allowedReverseTools: Iterable<string> = [],
    options?: CreateSessionOptions
  ): AppSession {
    this.prune()
    while (this.sessions.size >= this.maxSessions) {
      const oldestKey = this.sessions.keys().next().value
      if (oldestKey === undefined) break
      this.sessions.delete(oldestKey)
    }

    const sessionToken = crypto.randomBytes(32).toString('hex')
    const now = Date.now()
    const session: AppSession = {
      sessionToken,
      serverName,
      rawToolName,
      resourceUri,
      allowedReverseTools: new Set(allowedReverseTools),
      agentId: options?.agentId,
      callId: options?.callId,
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
    this.sessions.delete(token)
    this.sessions.set(token, session)
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

  dispose(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer)
      this.pruneTimer = undefined
    }
    this.sessions.clear()
  }

  get size(): number {
    return this.sessions.size
  }
}
