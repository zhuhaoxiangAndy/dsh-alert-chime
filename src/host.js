/**
 * dsh-alert-chime — Host half.
 *
 * Plain-JavaScript function body that must `return` a Cordis Plugin. DSH
 * evaluates this exact file content as the body of an async function inside a
 * node:vm sandbox, so: no TypeScript, no import/require, and no ambient
 * setTimeout/process/fetch — use `ctx` services and Cordis timers instead.
 *
 * What it watches
 *   approval/request   a permission prompt is now waiting for the user
 *   tools/pre-execute  the pending call is `ask_user_question`
 *   agent/status       the agent entered `idle` = the run ended and is waiting
 *                      for the user
 *
 * What it does with them
 *   Keeps a bounded log, answers the browser half's poll RPC, and plays a
 *   Windows system sound as a fallback whenever the page did not acknowledge
 *   its own chime in time (hidden and throttled tab, closed tab, blocked audio,
 *   or no page at all).
 *
 * Nothing is persisted, and every listener, timer and RPC handler below is
 * owned by this Plugin's Fiber: stop, update or undefine removes all of them.
 */

return {
  inject: ['timer'],
  apply(ctx) {
    const MAX_SIGNALS = 40
    const ACK_WAIT_MS = 1500
    const SOUND_GAP_MS = 1200

    /** Files verified present under C:\Windows\Media on this machine. */
    const SOUND_FILES = {
      approval: 'Windows Notify System Generic.wav',
      question: 'ding.wav',
      idle: 'chimes.wav',
      test: 'Windows Notify System Generic.wav',
    }

    const signals = []
    const chimedSeqs = new Set()
    let seq = 0
    let muted = false
    let fallback = true
    let lastVisible = null
    let lastPollAt = 0
    let lastSoundAt = 0
    let soundOk = null

    const shell = ctx.get('shell')

    /**
     * Fire and forget one short PowerShell that plays a file shipped with
     * Windows. `shell.start` returns immediately, so a ~1s sound never blocks
     * an approval decision that is waiting on this very turn.
     */
    function playSystemSound(kind) {
      if (shell === undefined) {
        soundOk = false
        return { ok: false, reason: 'shell service unavailable' }
      }
      const now = Date.now()
      if (now - lastSoundAt < SOUND_GAP_MS) return { ok: false, reason: 'throttled' }
      lastSoundAt = now

      const file = SOUND_FILES[kind] || SOUND_FILES.test
      const command = "$p = New-Object System.Media.SoundPlayer 'C:\\Windows\\Media\\" + file + "'; $p.PlaySync()"
      try {
        const spec = shell.resolve({ command: command, timeoutMs: 15000 })
        const proc = shell.start(spec)
        if (proc && proc.done && typeof proc.done.then === 'function') proc.done.then(null, function () {})
        soundOk = true
        return { ok: true, reason: 'started' }
      } catch (error) {
        soundOk = false
        console.error('alert-chime: system sound failed:', error && error.message ? error.message : String(error))
        return { ok: false, reason: 'spawn failed' }
      }
    }

    function pushSignal(kind, detail) {
      seq += 1
      const entry = {
        seq: seq,
        kind: kind,
        at: Date.now(),
        detail: typeof detail === 'string' ? detail.slice(0, 120) : '',
      }
      signals.push(entry)
      if (signals.length > MAX_SIGNALS) signals.splice(0, signals.length - MAX_SIGNALS)
      if (chimedSeqs.size > 400) chimedSeqs.clear()

      if (muted || !fallback) return entry

      // A live page chimes on its next poll and then acks. No ack in time means
      // the page never made a sound, so the Host covers it.
      const target = entry.seq
      ctx.timeout(function () {
        if (muted || !fallback || chimedSeqs.has(target)) return
        playSystemSound(kind)
      }, ACK_WAIT_MS)

      return entry
    }

    // Waterfall: this listener must forward to the next answerer, or it claims
    // the decision. It also must not throw, or the prompt fails closed.
    ctx.on('approval/request', function (req, next) {
      try {
        const tool = req && typeof req === 'object' && typeof req.toolName === 'string' ? req.toolName : ''
        const reason = req && typeof req === 'object' && typeof req.reason === 'string' ? req.reason : ''
        pushSignal('approval', reason ? tool + ' — ' + reason : tool)
      } catch (error) {
        console.error('alert-chime: approval listener:', error && error.message ? error.message : String(error))
      }
      return typeof next === 'function' ? next() : undefined
    })

    // Waterfall as well, and it runs for every tool call: keep it trivial and
    // always delegate.
    ctx.on('tools/pre-execute', function (exec, next) {
      try {
        if (exec && typeof exec === 'object' && exec.name === 'ask_user_question') pushSignal('question', '')
      } catch (error) {
        console.error('alert-chime: pre-execute listener:', error && error.message ? error.message : String(error))
      }
      return typeof next === 'function' ? next() : undefined
    })

    ctx.on('agent/status', function (payload) {
      try {
        if (payload && typeof payload === 'object' && payload.status === 'idle') pushSignal('idle', '')
      } catch (error) {
        console.error('alert-chime: status listener:', error && error.message ? error.message : String(error))
      }
    })

    /** RPC handlers belong to the Fiber through ctx.effect, like every effect. */
    function handle(method, handler) {
      ctx.effect(function () {
        return harness.handle(method, handler)
      })
    }

    handle('poll', function (args) {
      lastPollAt = Date.now()
      if (args && typeof args === 'object' && typeof args.visible === 'boolean') lastVisible = args.visible

      const since =
        args && typeof args === 'object' && typeof args.since === 'number' && isFinite(args.since) ? args.since : 0
      const pending = []
      for (let i = 0; i < signals.length; i += 1) {
        const entry = signals[i]
        if (entry.seq > since) pending.push({ seq: entry.seq, kind: entry.kind, detail: entry.detail, at: entry.at })
      }

      // Owned JSON only: no live Host object ever crosses this wire.
      return {
        seq: seq,
        muted: muted,
        fallback: fallback,
        soundOk: soundOk,
        shellAvailable: shell !== undefined,
        lastVisible: lastVisible,
        clientSeenAt: lastPollAt,
        signals: pending,
      }
    })

    handle('chimed', function (args) {
      if (args && typeof args === 'object' && typeof args.seq === 'number') chimedSeqs.add(args.seq)
      return null
    })

    handle('set-muted', function (args) {
      if (args && typeof args === 'object' && typeof args.muted === 'boolean') muted = args.muted
      return { muted: muted }
    })

    handle('set-fallback', function (args) {
      if (args && typeof args === 'object' && typeof args.enabled === 'boolean') fallback = args.enabled
      return { fallback: fallback }
    })

    handle('test-system', function () {
      lastSoundAt = 0
      return playSystemSound('test')
    })
  },
}
