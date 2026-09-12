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
 *   subagent), keeps a bounded log, answers the browser half's poll RPC, raises
 *   a Windows notification, and plays a Windows system sound as a fallback
 *   whenever the page did not acknowledge its own chime in time.
 *
 * The Windows notification is sent through `powershell -EncodedCommand`, i.e. a
 * UTF-16LE base64 script on the command line. That is deliberate and load
 * bearing: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI, so Chinese
 * text written into a script FILE comes out mangled (measured, twice). An
 * encoded command never touches file encoding, so arbitrary user text — a
 * workspace or session name in any script — survives intact.
 *
 * The toast is sent under the AUMID of the built-in Windows PowerShell
 * shortcut. Windows silently drops notifications for an unregistered
 * AppUserModelID (measured: registering our own under HKCU is denied here, and
 * an unregistered id produced no visible notification), so a registered
 * identity is the only thing that actually shows up. `<text
 * placement="attribution">` then puts DSH on the card, and `<audio
 * silent="true"/>` keeps Windows' own toast sound out of the way: the sound
 * stays ours, so an alert is never doubled.
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
    const TOAST_GAP_MS = 800
    const SPAWN_TIMEOUT_MS = 15000

    /** Files verified present under C:\Windows\Media on this machine. */
    const SOUND_FILES = {
      approval: 'Windows Notify System Generic.wav',
      question: 'ding.wav',
      idle: 'chimes.wav',
      test: 'Windows Notify System Generic.wav',
    }

    const KIND_LABELS = {
      approval: '审批',
      question: '提问',
      idle: '运行结束',
      test: '测试',
    }

    /**
     * AUMID of the built-in Windows PowerShell shortcut. Registered on a stock
     * Windows install, which is the whole point: an unregistered id is dropped
     * without an error.
     */
    const TOAST_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

    const signals = []
    const chimedSeqs = new Set()
    let seq = 0
    let muted = false
    let fallback = true
    let toastEnabled = true
    let lastVisible = null
    let lastPollAt = 0
    let lastSoundAt = 0
    let lastToastAt = 0
    let soundOk = null
    let toastOk = null

    const shell = ctx.get('shell')
    const sessionTitle = ctx.get('sessionTitle')
    const workspaceRegistry = ctx.get('workspaceRegistry')
    const agents = ctx.get('agents')

    function isObject(value) {
      return value !== null && typeof value === 'object'
    }

    // ------------------------------------------------------------- spawning ---

    /**
     * Spawn one detached PowerShell and report whether it started. The caller
     * never waits: a permission prompt may be blocked on this very turn.
     */
    function spawnPowerShell(script, label) {
      if (shell === undefined) return { ok: false, reason: 'shell service unavailable' }
      const command = 'powershell -NoProfile -NonInteractive -EncodedCommand ' + utf16leBase64(script)
      try {
        const spec = shell.resolve({ command: command, timeoutMs: SPAWN_TIMEOUT_MS })
        const proc = shell.start(spec)
        if (proc && proc.done && typeof proc.done.then === 'function') proc.done.then(null, function () {})
        return { ok: true, reason: 'started' }
      } catch (error) {
        console.error('alert-chime: ' + label + ' failed:', error && error.message ? error.message : String(error))
        return { ok: false, reason: 'spawn failed' }
      }
    }

    // #region utf16le-base64
    /**
     * PowerShell's -EncodedCommand wants the script as UTF-16LE base64.
     *
     * Hand-rolled on purpose, and NOT via the sandbox's `btoa`: that helper is
     * `Buffer.from(s, 'utf-8').toString('base64')`, so handing it a byte string
     * re-encodes every byte >= 0x80 and corrupts the stream. Pure-ASCII scripts
     * would survive by luck, and anything with a workspace or session name in a
     * non-Latin script would decode to garbage. scripts/check.mjs round-trips
     * this function against Node's own encoder so the risk stays measured.
     */
    function utf16leBase64(value) {
      const text = String(value)
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
      let out = ''
      let buffer = 0
      let bits = 0

      for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i)
        // UTF-16LE: low byte first, then high byte.
        for (let half = 0; half < 2; half += 1) {
          buffer = (buffer << 8) | (half === 0 ? code & 0xff : (code >> 8) & 0xff)
          bits += 8
          if (bits === 24) {
            out +=
              alphabet[(buffer >> 18) & 63] +
              alphabet[(buffer >> 12) & 63] +
              alphabet[(buffer >> 6) & 63] +
              alphabet[buffer & 63]
            buffer = 0
            bits = 0
          }
        }
      }

      if (bits === 8) {
        out += alphabet[(buffer >> 2) & 63] + alphabet[(buffer << 4) & 63] + '=='
      } else if (bits === 16) {
        out +=
          alphabet[(buffer >> 10) & 63] +
          alphabet[(buffer >> 4) & 63] +
          alphabet[(buffer << 2) & 63] +
          '='
      }
      return out
    }
    // #endregion utf16le-base64

    function xmlEscape(value) {
      return String(value === null || value === undefined ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;')
    }

    // ------------------------------------------------------------- identity ---

    function baseName(value) {
      const text = String(value === null || value === undefined ? '' : value).replace(/[\\/]+$/, '')
      const cut = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'))
      return cut >= 0 ? text.slice(cut + 1) : text
    }

    function roleLabel(identity) {
      if (identity.role !== 'subagent') return '主会话'
      let text = '子代理'
      if (identity.depth > 0) text += ' L' + identity.depth
      if (identity.index > 0) text += ' #' + identity.index
      return text
    }

    function clockText(at) {
      try {
        const date = new Date(at)
        const pad = function (value) {
          return value < 10 ? '0' + value : String(value)
        }
        return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
      } catch (error) {
        return ''
      }
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

    // ---------------------------------------------------------------- toast ---

    function toastScript(title, lines) {
      let xml = '<toast><visual><binding template="ToastGeneric">'
      xml += '<text>' + xmlEscape(title) + '</text>'
      for (let i = 0; i < lines.length; i += 1) xml += '<text>' + xmlEscape(lines[i]) + '</text>'
      // Attribution is what puts DSH on the card even though the AUMID has to
      // be a registered one we do not own.
      xml += '<text placement="attribution">DSH</text>'
      // Silent: Windows' own toast sound would double our chime.
      xml += '</binding></visual><audio silent="true"/></toast>'

      const literal = "'" + xml.replace(/'/g, "''") + "'"
      return [
        '[void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]',
        '[void][Windows.UI.Notifications.ToastNotification,Windows.UI.Notifications,ContentType=WindowsRuntime]',
        '[void][Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime]',
        '$x=New-Object Windows.Data.Xml.Dom.XmlDocument',
        '$x.LoadXml(' + literal + ')',
        '$t=New-Object Windows.UI.Notifications.ToastNotification $x',
        "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('" + TOAST_AUMID + "').Show($t)",
      ].join(';')
    }

    function toastLines(kind, identity, detail, at) {
      const lines = [
        '工作区 · ' + (identity.workspace || '未知'),
        '会话 · ' + (identity.session || '未命名'),
        '身份 · ' + roleLabel(identity) + ' · ' + clockText(at),
      ]
      if (detail) lines.push(detail)
      return lines
    }

    function showWindowsToast(kind, identity, detail, at) {
      const now = Date.now()
      if (now - lastToastAt < TOAST_GAP_MS) return { ok: false, reason: 'throttled' }
      lastToastAt = now

      const result = spawnPowerShell(
        toastScript('DSH · ' + (KIND_LABELS[kind] || kind), toastLines(kind, identity, detail, at)),
        'toast',
      )
      toastOk = result.ok
      return result
    }

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
      const script = "$p = New-Object System.Media.SoundPlayer 'C:\\Windows\\Media\\" + file + "'; $p.PlaySync()"
      const result = spawnPowerShell(script, 'system sound')
      soundOk = result.ok
      return result
    }

    // -------------------------------------------------------------- signals ---

    function pushSignal(kind, detail, agent) {
      const identity = identityOf(agent)
      const at = Date.now()

      seq += 1
      const entry = {
        seq: seq,
        kind: kind,
        at: at,
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

      if (muted) return entry

      // The Windows notification is unconditional: it is the popup that reaches
      // the user whether or not the page is on screen.
      if (toastEnabled) showWindowsToast(kind, identity, entry.detail, at)

      if (!fallback) return entry

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
        toast: toastEnabled,
        soundOk: soundOk,
        toastOk: toastOk,
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

    handle('set-toast', function (args) {
      if (isObject(args) && typeof args.enabled === 'boolean') toastEnabled = args.enabled
      return { toast: toastEnabled }
    })

    handle('test-system', function () {
      lastSoundAt = 0
      return playSystemSound('test')
    })

    // The test toast skips the mute gate on purpose: pressing the button is an
    // explicit request, and its whole job is to prove the notification path.
    handle('test-toast', function () {
      lastToastAt = 0
      const identity = identityOf(undefined)
      return showWindowsToast('test', identity, '来自控制面板的测试通知', Date.now())
    })
  },
}
