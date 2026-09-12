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
 *   Resolves who the signal belongs to (app / workspace / session / main-or-
 *   subagent), keeps a bounded log, answers the browser half's poll RPC, and
 *   plays a Windows system sound as a fallback whenever the page did not
 *   acknowledge its own chime in time (hidden and throttled tab, closed tab,
 *   blocked audio, or no page at all).
 *
 * Identity is derived from data that already exists, never from a model:
 *   - sessionTitle.get() is the log-backed title fold. The only path that could
 *     generate a title through a provider is sessionTitle.refresh(), which this
 *     file deliberately never calls.
 *   - workspaceRegistry.list() maps the session to its workspace through the
 *     registry's own sessionIds account (a header-validated membership), with a
 *     cwd/registry-path match and then the cwd basename as fallbacks.
 *   - a subagent is a session whose header says so: origin === 'subagent' or
 *     delegationDepth > 0. Its ordinal is its position among the live siblings
 *     that share the same parentSession, ordered by header createdAt.
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
    const sessionTitle = ctx.get('sessionTitle')
    const workspaceRegistry = ctx.get('workspaceRegistry')
    const agents = ctx.get('agents')

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

    // ------------------------------------------------------------- identity ---

    function baseName(value) {
      const text = String(value === null || value === undefined ? '' : value).replace(/[\\/]+$/, '')
      const cut = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'))
      return cut >= 0 ? text.slice(cut + 1) : text
    }

    function isObject(value) {
      return value !== null && typeof value === 'object'
    }

    /**
     * Describe one agent without calling a model and without touching anything
     * outside its own header, title fold and workspace account.
     * @param agent - the live agent a signal came from, when the event carried one.
     * @returns owned scalars only; every field degrades to a safe empty value.
     */
    function identityOf(agent) {
      const identity = {
        app: 'DSH',
        sessionId: '',
        session: '',
        workspace: '',
        role: 'main',
        depth: 0,
        index: 0,
      }

      try {
        if (!isObject(agent)) return identity
        if (typeof agent.id === 'string') identity.sessionId = agent.id

        const session = agent.session
        const header = isObject(session) ? session.header : undefined
        let cwd = ''
        let parent = ''

        if (isObject(header)) {
          if (typeof header.cwd === 'string') cwd = header.cwd
          if (typeof header.parentSession === 'string') parent = header.parentSession
          if (header.origin === 'subagent') identity.role = 'subagent'
          if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) {
            identity.role = 'subagent'
            identity.depth = header.delegationDepth
          }
        }

        // The durable title fold. Never refresh(): that is the provider path.
        if (sessionTitle !== undefined && session !== undefined) {
          const snapshot = sessionTitle.get(session)
          if (isObject(snapshot) && typeof snapshot.title === 'string') identity.session = snapshot.title
        }
        if (identity.session === '' && identity.sessionId !== '') identity.session = identity.sessionId.slice(0, 8)

        if (workspaceRegistry !== undefined) {
          const list = workspaceRegistry.list()
          if (Array.isArray(list)) {
            for (let i = 0; i < list.length; i += 1) {
              const workspace = list[i]
              if (!isObject(workspace)) continue
              const title = typeof workspace.title === 'string' ? workspace.title : ''
              const ids = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
              // Membership is exact; the path match is only a fallback.
              if (identity.sessionId !== '' && ids.indexOf(identity.sessionId) >= 0) {
                identity.workspace = title
                break
              }
              if (identity.workspace === '' && cwd !== '' && workspace.path === cwd) identity.workspace = title
            }
          }
        }
        if (identity.workspace === '' && cwd !== '') identity.workspace = baseName(cwd)

        if (identity.role === 'subagent' && parent !== '' && agents !== undefined) {
          const siblings = []
          const list = agents.list()
          if (Array.isArray(list)) {
            for (let i = 0; i < list.length; i += 1) {
              const other = list[i]
              const otherSession = isObject(other) ? other.session : undefined
              const otherHeader = isObject(otherSession) ? otherSession.header : undefined
              if (!isObject(otherHeader) || otherHeader.parentSession !== parent) continue
              siblings.push({
                id: typeof other.id === 'string' ? other.id : '',
                at: typeof otherHeader.createdAt === 'number' ? otherHeader.createdAt : 0,
              })
            }
          }
          siblings.sort(function (left, right) {
            return left.at - right.at
          })
          for (let i = 0; i < siblings.length; i += 1) {
            if (siblings[i].id === identity.sessionId) {
              identity.index = i + 1
              break
            }
          }
        }
      } catch (error) {
        console.error('alert-chime: identity:', error && error.message ? error.message : String(error))
      }

      return identity
    }

    // -------------------------------------------------------------- signals ---

    function pushSignal(kind, detail, agent) {
      const identity = identityOf(agent)

      seq += 1
      const entry = {
        seq: seq,
        kind: kind,
        at: Date.now(),
        detail: typeof detail === 'string' ? detail.slice(0, 120) : '',
        app: identity.app,
        workspace: identity.workspace.slice(0, 80),
        session: identity.session.slice(0, 120),
        role: identity.role,
        depth: identity.depth,
        index: identity.index,
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
        const tool = isObject(req) && typeof req.toolName === 'string' ? req.toolName : ''
        const reason = isObject(req) && typeof req.reason === 'string' ? req.reason : ''
        pushSignal('approval', reason ? tool + ' — ' + reason : tool, isObject(req) ? req.agent : undefined)
      } catch (error) {
        console.error('alert-chime: approval listener:', error && error.message ? error.message : String(error))
      }
      return typeof next === 'function' ? next() : undefined
    })

    // Waterfall as well, and it runs for every tool call: keep it trivial and
    // always delegate.
    ctx.on('tools/pre-execute', function (exec, next) {
      try {
        if (isObject(exec) && exec.name === 'ask_user_question') pushSignal('question', '', exec.agent)
      } catch (error) {
        console.error('alert-chime: pre-execute listener:', error && error.message ? error.message : String(error))
      }
      return typeof next === 'function' ? next() : undefined
    })

    ctx.on('agent/status', function (payload) {
      try {
        if (isObject(payload) && payload.status === 'idle') pushSignal('idle', '', payload.agent)
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
      if (isObject(args) && typeof args.visible === 'boolean') lastVisible = args.visible

      const since = isObject(args) && typeof args.since === 'number' && isFinite(args.since) ? args.since : 0
      const pending = []
      for (let i = 0; i < signals.length; i += 1) {
        const entry = signals[i]
        if (entry.seq > since) pending.push(Object.assign({}, entry))
      }

      // Owned JSON only: no live Host object ever crosses this wire.
      return {
        seq: seq,
        muted: muted,
        fallback: fallback,
        soundOk: soundOk,
        shellAvailable: shell !== undefined,
        identityAvailable: sessionTitle !== undefined || workspaceRegistry !== undefined,
        lastVisible: lastVisible,
        clientSeenAt: lastPollAt,
        signals: pending,
      }
    })

    handle('chimed', function (args) {
      if (isObject(args) && typeof args.seq === 'number') chimedSeqs.add(args.seq)
      return null
    })

    handle('set-muted', function (args) {
      if (isObject(args) && typeof args.muted === 'boolean') muted = args.muted
      return { muted: muted }
    })

    handle('set-fallback', function (args) {
      if (isObject(args) && typeof args.enabled === 'boolean') fallback = args.enabled
      return { fallback: fallback }
    })

    handle('test-system', function () {
      lastSoundAt = 0
      return playSystemSound('test')
    })
  },
}
