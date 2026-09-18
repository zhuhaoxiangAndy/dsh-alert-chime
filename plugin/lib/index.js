/**
 * dsh-alert-chime — a host-side Cordis plugin.
 *
 * Why a plugin package rather than a dynamic Package: a dynamic Package lives
 * only inside the current process, so every DSH update and restart erases it.
 * This file is the durable half — it is mounted from a composition row, so it
 * comes back by itself.
 *
 * It is deliberately HOST-ONLY. The browser half of the dynamic version gives a
 * styled popup and a Web Audio chime, but it needs a page to render into; when
 * the harness is driven from a terminal there is no page at all. Everything
 * here works without one: the alert is a Windows notification, and the sound is
 * played by the Host. That also means no round trip and no ack protocol — the
 * sound does not depend on a page confirming it played.
 *
 * What it watches
 *   approval/request   a permission prompt is now waiting for the user
 *   tools/pre-execute  the pending call is `ask_user_question`
 *   agent/status       the agent entered `idle` = the run ended and is waiting
 *                      for the user
 *
 * The notification and the sound go out in ONE PowerShell process, started with
 * `-EncodedCommand` (a UTF-16LE base64 script on the command line). That is not
 * stylistic: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI, so Chinese
 * text written into a script FILE arrives mangled — measured twice while this
 * was built. An encoded command never touches file encoding, so a workspace or
 * session name in any script survives. The base64 encoder is hand-rolled
 * because the sandbox's `btoa` equivalent (and Node's own, used naively) is
 * UTF-8 based and would re-encode every byte >= 0x80; scripts/check.mjs
 * round-trips this exact function against Node's Buffer encoder.
 *
 * The toast is sent under the AUMID of the built-in Windows PowerShell
 * shortcut, because Windows silently drops notifications for an unregistered
 * AppUserModelID and registering our own under HKCU is denied in a confined
 * process. `<text placement="attribution">` puts DSH on the card instead, and
 * `<audio silent="true"/>` keeps Windows' own toast sound out so an alert is
 * never doubled.
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
 *     sharing the same parentSession, ordered by header createdAt.
 *   - when no agent is available at all (a manual test), every field degrades to
 *     a placeholder instead of failing.
 *
 * Every listener and timer is owned by the Cordis fiber, so unmounting the row
 * removes all of them.
 */

export const name = 'dsh-alert-chime'

/** Cordis timers; the only hard dependency. */
export const inject = ['timer']

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

const MAX_SIGNALS = 40
const SPAWN_TIMEOUT_MS = 15000
const ALERT_GAP_MS = 1000

export function apply(ctx, config = {}) {
  const soundEnabled = config.sound !== false
  const toastEnabled = config.toast !== false
  const logEnabled = config.log !== false

  const shell = ctx.get('shell')
  const sessionTitle = ctx.get('sessionTitle')
  const workspaceRegistry = ctx.get('workspaceRegistry')
  const agents = ctx.get('agents')

  const signals = []
  let seq = 0
  let lastAlertAt = 0

  function isObject(value) {
    return value !== null && typeof value === 'object'
  }

  // ------------------------------------------------------------- spawning ---

  // #region utf16le-base64
  /**
   * PowerShell's -EncodedCommand wants the script as UTF-16LE base64.
   *
   * Hand-rolled on purpose: Node's `Buffer.from(s, 'utf8')` and the dynamic
   * sandbox's `btoa` are both UTF-8 based, so either one re-encodes every byte
   * >= 0x80 and corrupts the stream. A pure-ASCII script would survive by luck
   * and any non-Latin workspace or session name would decode to garbage.
   * scripts/check.mjs round-trips this function against Node's own encoder.
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

  /**
   * A statement that appends one line to the alert log.
   *
   * This exists because a host row's activation is otherwise unobservable from
   * outside the process: the loader's own console is not reachable, and the
   * dynamic-plugin inspector only lists dynamic Packages. A file that says
   * "mounted at ..." turns "did it load?" into a question with an answer.
   *
   * `$env:TEMP` is resolved by PowerShell rather than guessed here: DSH hands
   * its children a private temp directory, so the path is not a constant.
   */
  function logStatement(line) {
    const safe = String(line).replace(/'/g, "''").replace(/[\r\n]+/g, ' ')
    return "Add-Content -Path (Join-Path $env:TEMP 'dsh-alert-chime.log') -Value ('" + safe + "') -Encoding UTF8"
  }

  function spawnPowerShell(script, label) {
    if (shell === undefined) return { ok: false, reason: 'shell service unavailable' }
    const command = 'powershell -NoProfile -NonInteractive -EncodedCommand ' + utf16leBase64(script)
    try {
      const spec = shell.resolve({ command: command, timeoutMs: SPAWN_TIMEOUT_MS })
      const proc = shell.start(spec)
      if (proc && proc.done && typeof proc.done.then === 'function') proc.done.then(null, function () {})
      return { ok: true, reason: 'started' }
    } catch (error) {
      console.error('[dsh-alert-chime] ' + label + ' failed:', error && error.message ? error.message : String(error))
      return { ok: false, reason: 'spawn failed' }
    }
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
      console.error('[dsh-alert-chime] identity:', error && error.message ? error.message : String(error))
    }

    return identity
  }

  // --------------------------------------------------------------- alert ---

  /**
   * One combined script: raise the toast, then play the sound. Doing both in a
   * single process halves the process churn per alert and fixes their order,
   * so the card is on screen before the sound starts.
   */
  function alertScript(kind, identity, detail, at) {
    const title = 'DSH · ' + (KIND_LABELS[kind] || kind)
    const lines = [
      '工作区 · ' + (identity.workspace || '未知'),
      '会话 · ' + (identity.session || '未命名'),
      '身份 · ' + roleLabel(identity) + ' · ' + clockText(at),
    ]
    if (detail) lines.push(detail)

    const parts = []

    // Travelling inside the SAME process as the alert: one extra statement, no
    // extra spawn, and it leaves behind evidence that this alert really ran.
    if (logEnabled) {
      parts.push(
        logStatement(
          kind + ' ' + new Date(at).toISOString() + ' ' + (identity.workspace || '-') + ' / ' + (identity.session || '-'),
        ),
      )
    }

    if (toastEnabled) {
      let xml = '<toast><visual><binding template="ToastGeneric">'
      xml += '<text>' + xmlEscape(title) + '</text>'
      for (let i = 0; i < lines.length; i += 1) xml += '<text>' + xmlEscape(lines[i]) + '</text>'
      // Attribution puts DSH on the card even though the AUMID must be a
      // registered identity we do not own.
      xml += '<text placement="attribution">DSH</text>'
      // Silent: Windows' own toast sound would double ours.
      xml += '</binding></visual><audio silent="true"/></toast>'

      const literal = "'" + xml.replace(/'/g, "''") + "'"
      parts.push(
        '[void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]',
        '[void][Windows.UI.Notifications.ToastNotification,Windows.UI.Notifications,ContentType=WindowsRuntime]',
        '[void][Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime]',
        '$x=New-Object Windows.Data.Xml.Dom.XmlDocument',
        '$x.LoadXml(' + literal + ')',
        '$t=New-Object Windows.UI.Notifications.ToastNotification $x',
        "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('" + TOAST_AUMID + "').Show($t)",
      )
    }

    if (soundEnabled) {
      const file = SOUND_FILES[kind] || SOUND_FILES.test
      // PlaySync, not Play: the process must outlive the sound, and it must not
      // hold anything up while it does.
      parts.push("(New-Object System.Media.SoundPlayer 'C:\\Windows\\Media\\" + file + "').PlaySync()")
    }

    return parts.join(';')
  }

  function raiseAlert(kind, identity, detail, at) {
    if (!toastEnabled && !soundEnabled) return { ok: false, reason: 'disabled' }

    const now = Date.now()
    if (now - lastAlertAt < ALERT_GAP_MS) return { ok: false, reason: 'throttled' }
    lastAlertAt = now

    return spawnPowerShell(alertScript(kind, identity, detail, at), 'alert')
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

    raiseAlert(kind, identity, entry.detail, at)
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
      console.error('[dsh-alert-chime] approval listener:', error && error.message ? error.message : String(error))
    }
    return typeof next === 'function' ? next() : undefined
  })

  // Waterfall as well, and it runs for every tool call: keep it trivial and
  // always delegate.
  ctx.on('tools/pre-execute', function (exec, next) {
    try {
      if (isObject(exec) && exec.name === 'ask_user_question') pushSignal('question', '', exec.agent)
    } catch (error) {
      console.error('[dsh-alert-chime] pre-execute listener:', error && error.message ? error.message : String(error))
    }
    return typeof next === 'function' ? next() : undefined
  })

  ctx.on('agent/status', function (payload) {
    try {
      if (isObject(payload) && payload.status === 'idle') pushSignal('idle', '', payload.agent)
    } catch (error) {
      console.error('[dsh-alert-chime] status listener:', error && error.message ? error.message : String(error))
    }
  })

  ctx.logger?.info?.('dsh-alert-chime mounted (toast=%s sound=%s)', toastEnabled, soundEnabled)

  // The mount marker: proof, readable from outside, that this row activated.
  if (logEnabled) {
    spawnPowerShell(logStatement('mounted ' + new Date().toISOString()), 'mount marker')
  }
}
