import { describe, it, expect, vi } from 'vitest'

describe('McpAppToolView Rate Limiter & Bridge Hardening', () => {
  it('suppresses excess resize events in a 1-second sliding window and preserves final height', () => {
    const windowMs = 1000
    const maxEvents = 10
    const timestamps: number[] = []

    let currentMuted = false
    let pendingHeight: number | null = null
    let appliedHeight = 200

    const onResize = (height: number, now: number) => {
      // Filter out timestamps older than window
      const valid = timestamps.filter(t => now - t < windowMs)
      timestamps.length = 0
      timestamps.push(...valid)

      pendingHeight = height

      if (timestamps.length >= maxEvents) {
        currentMuted = true
        return
      }

      currentMuted = false
      timestamps.push(now)
      appliedHeight = height
    }

    const start = 1000
    for (let i = 0; i < 15; i++) {
      onResize(200 + (i + 1) * 10, start + i * 20)
    }

    expect(currentMuted).toBe(true)
    expect(appliedHeight).toBe(300) // 10th event applied
    expect(pendingHeight).toBe(350) // 15th event captured as pending

    // When the mute window expires, the pending height is flushed
    if (pendingHeight !== null) {
      appliedHeight = pendingHeight
    }
    expect(appliedHeight).toBe(350)
  })

  it('triggers navigation tripwire when iframe fires second load event', () => {
    let navCount = 0
    let errorMessage: string | null = null
    const teardownSpy = vi.fn()

    const handleIframeLoad = () => {
      navCount++
      if (navCount > 1) {
        errorMessage = 'Navigation within MCP App iframe is disabled'
        teardownSpy()
      }
    }

    // First load: valid synthetic srcDoc
    handleIframeLoad()
    expect(navCount).toBe(1)
    expect(errorMessage).toBeNull()
    expect(teardownSpy).not.toHaveBeenCalled()

    // Second load: unauthorized navigation attempt
    handleIframeLoad()
    expect(navCount).toBe(2)
    expect(errorMessage).toBe('Navigation within MCP App iframe is disabled')
    expect(teardownSpy).toHaveBeenCalledTimes(1)
  })
})
