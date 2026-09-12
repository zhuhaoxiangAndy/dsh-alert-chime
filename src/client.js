/**
 * dsh-alert-chime — Client half.
 *
 * Plain-JavaScript function body that must `return` a Cordis Plugin. It runs in
 * the page, so: no TS/JSX, React only through React.createElement, and no
 * setTimeout/fetch (the runner shadows those on purpose). Timers come from the
 * Cordis `timer` service.
 *
 * Why a poll: the dynamic-Plugin link is Client -> Host only, so the Host cannot
 * push a signal into this page. The loop below therefore asks the Host half for
 * signals newer than the last one it saw.
 *
 * Why it acks: the Host treats a missing ack as "this page made no sound" and
 * plays a system sound instead. That is what keeps the feature working when the
 * tab is hidden for a long time (browsers throttle a background tab's timers to
 * roughly once a minute), closed, or its audio is blocked by autoplay policy.
 *
 * Why stale signals are dropped: after a throttle gap the poll can deliver a
 * batch minutes late; chiming then would be noise, and the Host already covered
 * it. Those entries still land in the panel log.
 */

return {
  inject: ['timer'],
  apply(ctx) {
    const POLL_MS = 500
    const STALE_MS = 5000
    const COALESCE_MS = 250
    const LOG_MAX = 12

    /** Two-note chimes: sine tones, no audio assets to fetch or decode. */
    const TONES = {
      approval: [880, 1174.66],
      question: [659.25, 987.77],
      idle: [523.25, 783.99],
      test: [523.25, 783.99, 1046.5],
    }

    const LABELS = { approval: '审批', question: '提问', idle: '运行结束' }

    const doc = typeof document === 'undefined' ? undefined : document
    const realm = typeof globalThis === 'undefined' ? undefined : globalThis

    let audio
    let audioFailed = false
    let since = 0
    let inFlight = false
    let lastChimeAt = 0
    let logId = 0

    const state = {
      muted: false,
      fallback: true,
      shellAvailable: false,
      systemSound: null,
      audioAvailable: true,
      chime: null,
      volume: 0.6,
      error: '',
      log: [],
    }

    const subscribers = new Set()

    function notify() {
      subscribers.forEach(function (subscriber) {
        try {
          subscriber()
        } catch (error) {
          // One dead subscriber must not stop the others.
        }
      })
    }

    function patch(fields) {
      Object.assign(state, fields)
      notify()
    }

    function text(error) {
      return error && typeof error.message === 'string' ? error.message : String(error)
    }

    // ---------------------------------------------------------------- audio ---

    function acquireAudio() {
      if (audio !== undefined) return audio
      if (audioFailed) return undefined
      const Ctor = realm === undefined ? undefined : realm.AudioContext || realm.webkitAudioContext
      if (Ctor === undefined) {
        audioFailed = true
        patch({ audioAvailable: false })
        return undefined
      }
      try {
        audio = new Ctor()
      } catch (error) {
        audioFailed = true
        patch({ audioAvailable: false, error: text(error) })
        return undefined
      }
      return audio
    }

    function resumeAudio(context) {
      if (context.state !== 'suspended' || typeof context.resume !== 'function') return
      try {
        const resumed = context.resume()
        if (resumed && typeof resumed.then === 'function') resumed.then(null, function () {})
      } catch (error) {
        // A blocked resume simply surfaces as a missing chime, and then as the
        // Host's system-sound fallback.
      }
    }

    function chime(kind) {
      const context = acquireAudio()
      if (context === undefined) return false
      resumeAudio(context)

      const notes = TONES[kind] || TONES.idle
      const peak = Math.max(0.02, Math.min(1, state.volume)) * 0.3
      const start = typeof context.currentTime === 'number' ? context.currentTime : 0

      try {
        for (let i = 0; i < notes.length; i += 1) {
          const at = start + 0.02 + i * 0.15
          const osc = context.createOscillator()
          const gain = context.createGain()
          osc.type = 'sine'
          osc.frequency.setValueAtTime(notes[i], at)
          gain.gain.setValueAtTime(0.0001, at)
          gain.gain.exponentialRampToValueAtTime(peak, at + 0.02)
          gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.42)
          osc.connect(gain)
          gain.connect(context.destination)
          osc.start(at)
          osc.stop(at + 0.45)
        }
      } catch (error) {
        patch({ chime: false, error: text(error) })
        return false
      }

      patch({ chime: true, error: '' })
      return true
    }

    // ----------------------------------------------------------------- host ---

    function callHost(method, args) {
      try {
        const result = host.call(method, args)
        if (result && typeof result.then === 'function') {
          return result.then(
            function (value) {
              return value
            },
            function (error) {
              patch({ error: text(error) })
              return null
            },
          )
        }
        return Promise.resolve(result)
      } catch (error) {
        patch({ error: text(error) })
        return Promise.resolve(null)
      }
    }

    function applySignal(signal) {
      if (!signal || typeof signal !== 'object') return
      const kind = typeof signal.kind === 'string' ? signal.kind : 'idle'
      const at = typeof signal.at === 'number' ? signal.at : 0
      const detail = typeof signal.detail === 'string' ? signal.detail : ''

      logId += 1
      const entry = { id: logId, kind: kind, detail: detail, at: at }
      state.log.unshift(entry)
      if (state.log.length > LOG_MAX) state.log.length = LOG_MAX

      if (state.muted) return
      if (at > 0 && Date.now() - at > STALE_MS) return

      const now = Date.now()
      if (now - lastChimeAt < COALESCE_MS) return
      if (!chime(kind)) return

      lastChimeAt = now
      if (typeof signal.seq === 'number') callHost('chimed', { seq: signal.seq })
    }

    function poll() {
      if (inFlight) return
      inFlight = true

      const visible = doc === undefined ? null : doc.visibilityState !== 'hidden'
      const request = callHost('poll', { since: since, visible: visible })

      request.then(
        function (result) {
          inFlight = false
          if (!result || typeof result !== 'object') return

          const list = Array.isArray(result.signals) ? result.signals : []
          for (let i = 0; i < list.length; i += 1) applySignal(list[i])

          if (typeof result.seq === 'number' && result.seq > since) since = result.seq
          patch({
            muted: typeof result.muted === 'boolean' ? result.muted : state.muted,
            fallback: typeof result.fallback === 'boolean' ? result.fallback : state.fallback,
            shellAvailable: result.shellAvailable === true,
            systemSound: typeof result.soundOk === 'boolean' ? result.soundOk : null,
          })
        },
        function () {
          inFlight = false
        },
      )
    }

    // --------------------------------------------------------------- effects ---

    ctx.effect(function () {
      return ctx.interval(poll, POLL_MS)
    })

    // Browsers only allow audio after a real gesture; a click anywhere in the
    // page is enough, and listening once is all that is needed.
    if (doc !== undefined && typeof doc.addEventListener === 'function') {
      const unlock = function () {
        const context = acquireAudio()
        if (context !== undefined) resumeAudio(context)
      }
      ctx.effect(function () {
        doc.addEventListener('pointerdown', unlock, { once: true })
        return function () {
          doc.removeEventListener('pointerdown', unlock)
        }
      })
    }

    ctx.effect(function () {
      return styles.insert(
        [
          '.dac-root{font:12px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:inherit;',
          'border:1px solid rgba(127,127,127,.32);border-radius:10px;padding:10px 12px;margin:8px 0;',
          'background:rgba(127,127,127,.07);max-width:560px}',
          '.dac-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}',
          '.dac-dot{width:8px;height:8px;border-radius:50%;background:rgba(127,127,127,.45);flex:0 0 auto}',
          '.dac-dot[data-on="true"]{background:#2ecc71;box-shadow:0 0 0 3px rgba(46,204,113,.18)}',
          '.dac-sub{margin-left:auto;opacity:.6;font-size:11px}',
          '.dac-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:6px}',
          '.dac-btn{font:inherit;padding:3px 9px;border-radius:6px;cursor:pointer;color:inherit;',
          'border:1px solid rgba(127,127,127,.4);background:rgba(127,127,127,.1)}',
          '.dac-btn:hover{background:rgba(127,127,127,.2)}',
          '.dac-btn[data-active="true"]{border-color:#2ecc71;background:rgba(46,204,113,.16)}',
          '.dac-range{width:110px;accent-color:#2ecc71}',
          '.dac-note{opacity:.62;font-size:11px;margin:2px 0 6px}',
          '.dac-log{list-style:none;margin:0;padding:0;max-height:132px;overflow:auto}',
          '.dac-log li{display:flex;gap:8px;align-items:baseline;padding:2px 0;border-top:1px solid rgba(127,127,127,.16)}',
          '.dac-kind{flex:0 0 auto;padding:0 6px;border-radius:999px;background:rgba(127,127,127,.18);font-size:11px}',
          '.dac-kind[data-kind="approval"]{background:rgba(241,196,15,.22)}',
          '.dac-kind[data-kind="question"]{background:rgba(52,152,219,.22)}',
          '.dac-kind[data-kind="idle"]{background:rgba(46,204,113,.22)}',
          '.dac-when{flex:0 0 auto;opacity:.55;font-variant-numeric:tabular-nums;font-size:11px}',
          '.dac-detail{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.8}',
          '.dac-empty{opacity:.55;border-top:none}',
        ].join(''),
      )
    })

    // ------------------------------------------------------------------- UI ---

    function useVersion() {
      const pair = React.useState(0)
      const bump = pair[1]
      React.useEffect(function () {
        const listener = function () {
          bump(function (n) {
            return n + 1
          })
        }
        subscribers.add(listener)
        return function () {
          subscribers.delete(listener)
        }
      }, [])
    }

    function button(label, onClick, active) {
      return React.createElement(
        'button',
        {
          type: 'button',
          className: 'dac-btn',
          'data-active': active === undefined ? undefined : String(active),
          onClick: onClick,
        },
        label,
      )
    }

    function clock(at) {
      if (at <= 0) return '--:--:--'
      return new Date(at).toLocaleTimeString()
    }

    function Panel() {
      useVersion()

      const audio = state.audioAvailable
        ? state.chime === null
          ? '浏览器音效待触发'
          : state.chime
            ? '浏览器音效正常'
            : '浏览器音效失败'
        : '浏览器不支持 Web Audio'

      const fallbackNote = state.shellAvailable
        ? state.fallback
          ? '页面隐藏/关闭或没响铃时，由 Host 调用 PowerShell 播放系统提示音'
          : '系统提示音兜底已关闭'
        : 'Host 未提供 shell 服务，系统提示音兜底不可用'

      const entries =
        state.log.length === 0
          ? [React.createElement('li', { className: 'dac-empty', key: 'none' }, '还没有触发过提示音')]
          : state.log.map(function (entry) {
              return React.createElement(
                'li',
                { key: entry.id },
                React.createElement('span', { className: 'dac-kind', 'data-kind': entry.kind }, LABELS[entry.kind] || entry.kind),
                React.createElement('span', { className: 'dac-when' }, clock(entry.at)),
                entry.detail ? React.createElement('span', { className: 'dac-detail' }, entry.detail) : null,
              )
            })

      return React.createElement('div', { className: 'dac-root' }, [
        React.createElement('div', { className: 'dac-head', key: 'head' }, [
          React.createElement('span', { className: 'dac-dot', key: 'dot', 'data-on': String(!state.muted) }),
          React.createElement('strong', { key: 'title' }, '提示音 · Alert chime'),
          React.createElement('span', { className: 'dac-sub', key: 'sub' }, state.muted ? '已静音' : audio),
        ]),
        React.createElement('div', { className: 'dac-row', key: 'actions' }, [
          button('试听', function () {
            chime('test')
          }),
          button(
            '系统音',
            function () {
              callHost('test-system', {}).then(function (result) {
                if (result && typeof result.ok === 'boolean') patch({ systemSound: result.ok })
              })
            },
            state.systemSound === true,
          ),
          button(
            state.muted ? '取消静音' : '静音',
            function () {
              callHost('set-muted', { muted: !state.muted }).then(function (result) {
                if (result && typeof result.muted === 'boolean') patch({ muted: result.muted })
              })
            },
            state.muted,
          ),
          button(
            state.fallback ? '兜底：开' : '兜底：关',
            function () {
              callHost('set-fallback', { enabled: !state.fallback }).then(function (result) {
                if (result && typeof result.fallback === 'boolean') patch({ fallback: result.fallback })
              })
            },
            state.fallback,
          ),
          React.createElement('input', {
            key: 'volume',
            className: 'dac-range',
            type: 'range',
            min: 0,
            max: 100,
            value: Math.round(state.volume * 100),
            title: '音量',
            onChange: function (event) {
              patch({ volume: Number(event.target.value) / 100 })
            },
          }),
        ]),
        React.createElement('div', { className: 'dac-note', key: 'note' }, fallbackNote),
        state.error ? React.createElement('div', { className: 'dac-note', key: 'err' }, '错误：' + state.error) : null,
        React.createElement('ul', { className: 'dac-log', key: 'log' }, entries),
      ])
    }

    const slots = ctx.get('slots')
    if (slots !== undefined) {
      slots.inject('tool.view.cordis', function () {
        return slots.register({ name: 'tool.view.cordis', key: 'self' }, Panel)
      })
    }

    // First poll immediately, so the panel shows Host state without waiting a tick.
    poll()
  },
}
