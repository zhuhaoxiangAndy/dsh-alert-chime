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
 *
 * Two popups exist, on purpose, and they are independent:
 *   - the Windows notification, raised by the HOST half (it reaches the user
 *     even when this page is not on screen), silent so the sound stays ours;
 *   - the in-page stack below, which is the one that can be styled and clicked.
 * Both are rendered from encoded data only. No model is involved anywhere.
 */

return {
  inject: ['timer'],
  apply(ctx) {
    const POLL_MS = 500
    const STALE_MS = 5000
    const COALESCE_MS = 250
    const LOG_MAX = 12
    const TOAST_MS = 12000
    const TOAST_MAX = 4

    /** Two-note chimes: sine tones, no audio assets to fetch or decode. */
    const TONES = {
      approval: [880, 1174.66],
      question: [659.25, 987.77],
      idle: [523.25, 783.99],
      test: [523.25, 783.99, 1046.5],
    }

    const LABELS = { approval: '审批', question: '提问', idle: '运行结束', test: '测试' }

    const doc = typeof document === 'undefined' ? undefined : document
    const realm = typeof globalThis === 'undefined' ? undefined : globalThis

    let audio
    let audioFailed = false
    let since = 0
    let inFlight = false
    let lastChimeAt = 0
    let logId = 0
    let toastId = 0

    const state = {
      muted: false,
      fallback: true,
      toast: true,
      shellAvailable: false,
      identityAvailable: false,
      systemSound: null,
      toastOk: null,
      audioAvailable: true,
      chime: null,
      volume: 0.6,
      error: '',
      log: [],
      toasts: [],
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

    function toText(value, fallback) {
      return typeof value === 'string' && value !== '' ? value : fallback
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

    // ---------------------------------------------------------------- toast ---

    /** '主会话' or '子代理 L1 #2' — every part comes from the Host's encoded fields. */
    function roleText(toast) {
      if (toast.role !== 'subagent') return '主会话'
      const parts = ['子代理']
      if (toast.depth > 0) parts.push('L' + toast.depth)
      if (toast.index > 0) parts.push('#' + toast.index)
      return parts.join(' ')
    }

    function dismissToast(id) {
      for (let i = 0; i < state.toasts.length; i += 1) {
        if (state.toasts[i].id !== id) continue
        const gone = state.toasts.splice(i, 1)[0]
        if (gone && typeof gone.dispose === 'function') gone.dispose()
        notify()
        return
      }
    }

    /**
     * Drop every visible popup at once. Used by the click-anywhere-else gesture:
     * a popup you cannot get rid of without hunting for a small x is worse than
     * no popup, and the stack can hold four of them.
     */
    function dismissAllToasts() {
      if (state.toasts.length === 0) return
      while (state.toasts.length > 0) {
        const gone = state.toasts.pop()
        if (gone && typeof gone.dispose === 'function') gone.dispose()
      }
      notify()
    }

    function showToast(signal, kind, detail) {
      toastId += 1
      const toast = {
        id: toastId,
        kind: kind,
        at: typeof signal.at === 'number' ? signal.at : Date.now(),
        app: toText(signal.app, 'DSH'),
        workspace: toText(signal.workspace, '未知工作区'),
        session: toText(signal.session, '未命名会话'),
        role: signal.role === 'subagent' ? 'subagent' : 'main',
        depth: typeof signal.depth === 'number' ? signal.depth : 0,
        index: typeof signal.index === 'number' ? signal.index : 0,
        detail: detail,
      }

      state.toasts.unshift(toast)
      while (state.toasts.length > TOAST_MAX) {
        const dropped = state.toasts.pop()
        if (dropped && typeof dropped.dispose === 'function') dropped.dispose()
      }
      toast.dispose = ctx.timeout(function () {
        dismissToast(toast.id)
      }, TOAST_MS)
      notify()
    }

    // -------------------------------------------------------------- signals ---

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

      // The in-page popup is shown for every fresh alert, not only when audio
      // succeeded: if autoplay policy blocks the chime, this visual is still
      // something the page can deliver.
      showToast(signal, kind, detail)

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
            toast: typeof result.toast === 'boolean' ? result.toast : state.toast,
            shellAvailable: result.shellAvailable === true,
            identityAvailable: result.identityAvailable === true,
            systemSound: typeof result.soundOk === 'boolean' ? result.soundOk : null,
            toastOk: typeof result.toastOk === 'boolean' ? result.toastOk : null,
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

    // Clicking anywhere other than a popup closes the whole stack.
    //
    // Capture phase on purpose: the app's own handlers run before this on the
    // bubble phase, and any of them stopping propagation would otherwise leave
    // the popups stuck on screen. A click that lands ON a card is skipped here
    // and left to that card's own handler, which closes just that one - so the
    // two gestures stay distinguishable.
    if (doc !== undefined && typeof doc.addEventListener === 'function') {
      const onPointerDownAnywhere = function (event) {
        if (state.toasts.length === 0) return
        const target = event === null || event === undefined ? undefined : event.target
        const insideCard = target && typeof target.closest === 'function' ? target.closest('.dac-toast') : null
        if (insideCard) return
        dismissAllToasts()
      }
      ctx.effect(function () {
        doc.addEventListener('pointerdown', onPointerDownAnywhere, true)
        return function () {
          doc.removeEventListener('pointerdown', onPointerDownAnywhere, true)
        }
      })
    }

    ctx.effect(function () {
      return styles.insert(
        [
          '.dac-root{font:12px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:inherit;',
          'border:1px solid rgba(127,127,127,.32);border-radius:10px;padding:10px 12px;margin:8px 0;',
          'background:rgba(127,127,127,.07);max-width:620px}',
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
          // The in-page popup stack. shell.overlay is click-through, so the
          // container stays pointer-events:none and each card opts back in.
          '@keyframes dac-toast-in{from{opacity:0;transform:translateY(16px) scale(.96)}to{opacity:1;transform:none}}',
          '@keyframes dac-toast-glow{0%,100%{box-shadow:0 14px 38px rgba(0,0,0,.46)}',
          '50%{box-shadow:0 14px 38px rgba(0,0,0,.46),0 0 0 5px rgba(46,204,113,.20)}}',
          '@keyframes dac-toast-blink{0%,100%{opacity:1}50%{opacity:.22}}',
          '.dac-toasts{position:fixed;right:18px;bottom:18px;z-index:45;display:flex;flex-direction:column;gap:10px;',
          'align-items:flex-end;pointer-events:none;max-width:min(400px,50vw)}',
          '.dac-toast{pointer-events:auto;cursor:pointer;min-width:340px;max-width:100%;box-sizing:border-box;',
          'font:13px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#f6f6f7;',
          'background:rgba(17,17,20,.97);border:1px solid rgba(255,255,255,.17);border-left:5px solid #2ecc71;',
          'border-radius:12px;padding:12px 14px;box-shadow:0 14px 38px rgba(0,0,0,.46);',
          'animation:dac-toast-in .2s ease-out,dac-toast-glow 1.7s ease-in-out 2}',
          '.dac-toast[data-kind="approval"]{border-left-color:#f1c40f}',
          '.dac-toast[data-kind="question"]{border-left-color:#3498db}',
          '.dac-toast-head{display:flex;align-items:center;gap:8px;margin-bottom:7px;padding-bottom:7px;',
          'border-bottom:1px solid rgba(255,255,255,.13)}',
          '.dac-toast-dot{width:9px;height:9px;border-radius:50%;background:#2ecc71;flex:0 0 auto;',
          'animation:dac-toast-blink 1.1s ease-in-out infinite}',
          '.dac-toast[data-kind="approval"] .dac-toast-dot{background:#f1c40f}',
          '.dac-toast[data-kind="question"] .dac-toast-dot{background:#3498db}',
          '.dac-toast-app{font-weight:700;letter-spacing:.06em;padding:1px 7px;border-radius:5px;',
          'background:rgba(255,255,255,.16)}',
          '.dac-toast-kind{font-weight:700;font-size:13px}',
          '.dac-toast-close{margin-left:auto;opacity:.5;font-size:15px;line-height:1}',
          '.dac-toast-row{opacity:.9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
          '.dac-toast-row b{font-weight:600;opacity:.62;font-weight:400}',
          '.dac-toast-detail{margin-top:5px;padding-top:5px;border-top:1px solid rgba(255,255,255,.13);opacity:.75;',
          'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
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

    function row(key, label, value) {
      return React.createElement(
        'div',
        { className: 'dac-toast-row', key: key },
        React.createElement('b', null, label + ' · '),
        value,
      )
    }

    function Toasts() {
      useVersion()
      if (state.toasts.length === 0) return null

      return React.createElement(
        'div',
        { className: 'dac-toasts' },
        state.toasts.map(function (toast) {
          return React.createElement(
            'div',
            {
              key: toast.id,
              className: 'dac-toast',
              'data-kind': toast.kind,
              title: '点击关闭',
              onClick: function () {
                dismissToast(toast.id)
              },
            },
            [
              React.createElement('div', { className: 'dac-toast-head', key: 'head' }, [
                React.createElement('span', { className: 'dac-toast-dot', key: 'dot' }),
                React.createElement('span', { className: 'dac-toast-app', key: 'app' }, toast.app),
                React.createElement('span', { className: 'dac-toast-kind', key: 'kind' }, LABELS[toast.kind] || toast.kind),
                React.createElement('span', { className: 'dac-toast-close', key: 'close' }, '×'),
              ]),
              row('workspace', '工作区', toast.workspace),
              row('session', '会话', toast.session),
              row('role', '身份', roleText(toast) + ' · ' + clock(toast.at)),
              toast.detail ? React.createElement('div', { className: 'dac-toast-detail', key: 'detail' }, toast.detail) : null,
            ],
          )
        }),
      )
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
          ? '页面隐藏/关闭或没响铃时，由 Host 播放系统提示音兜底'
          : '系统提示音兜底已关闭'
        : 'Host 未提供 shell 服务，系统提示音兜底不可用'

      const toastNote = state.shellAvailable
        ? state.toast
          ? '系统通知（消息中心）已开启，通知本身静音，声音仍用上面的铃声'
          : '系统通知已关闭'
        : 'Host 未提供 shell 服务，系统通知不可用'

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
            '测试通知',
            function () {
              callHost('test-toast', {}).then(function (result) {
                if (result && typeof result.ok === 'boolean') patch({ toastOk: result.ok })
              })
            },
            state.toastOk === true,
          ),
          button(
            state.toast ? '通知：开' : '通知：关',
            function () {
              callHost('set-toast', { enabled: !state.toast }).then(function (result) {
                if (result && typeof result.toast === 'boolean') patch({ toast: result.toast })
              })
            },
            state.toast,
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
        React.createElement('div', { className: 'dac-note', key: 'toast-note' }, toastNote),
        React.createElement('div', { className: 'dac-note', key: 'note' }, fallbackNote),
        React.createElement(
          'div',
          { className: 'dac-note', key: 'identity' },
          state.identityAvailable
            ? '两个弹窗内容一致：DSH + 工作区 + 会话名 + 主会话/子代理，均由 Host 编码计算'
            : 'Host 未提供会话/工作区服务，弹窗身份字段会退化为占位值',
        ),
        state.error ? React.createElement('div', { className: 'dac-note', key: 'err' }, '错误：' + state.error) : null,
        React.createElement('ul', { className: 'dac-log', key: 'log' }, entries),
      ])
    }

    const slots = ctx.get('slots')
    if (slots !== undefined) {
      slots.inject('tool.view.cordis', function () {
        return slots.register({ name: 'tool.view.cordis', key: 'self' }, Panel)
      })
      // shell.overlay is root-scoped and additive: a fresh id sits beside the
      // shipped entries instead of replacing one.
      slots.inject('shell.overlay', function () {
        return slots.register({ name: 'shell.overlay', id: 'dsh-alert-chime-toasts', order: 40 }, Toasts)
      })
    }

    // First poll immediately, so the panel shows Host state without waiting a tick.
    poll()
  },
}
