/**
 * watch.mjs — play an alert sound when the harness asks for the user or a run
 * finishes, by following the session log.
 *
 * Why this exists: the plugin route kept dying with each DSH upgrade, and the
 * dynamic-plugin tooling is not even present in the version running now. The
 * session log, however, is a durable contract that is already on disk.
 *
 * Measured facts this is built on (see probe-events.mjs / frame-probe.mjs):
 *   - the log is `session.v4.jsonl.zstd` under
 *     $DSH_HOME/sessions/<workspace-slug>/<session-id>/
 *   - it is appended ONE zstd FRAME AT A TIME: a one-shot or streaming
 *     decompression yields only the first frame (1.3 MB -> 233 chars), so the
 *     frames must be split on the magic 28 B5 2F FD and decoded individually
 *   - the events include `approval/asked` and `turn/end`, which is exactly what
 *     an alert needs
 *
 * Only NEW frames are decoded, tracked by the byte offset of the last consumed
 * frame, so a steady state re-reads a few bytes rather than the whole file. The
 * first poll skips history on purpose: starting the watcher must not replay
 * every alert the session ever produced.
 *
 * Usage:
 *   node tools/watch.mjs                          # newest session, plays audio/approval.wav
 *   node tools/watch.mjs --wav audio/idle.wav --interval 500
 *   node tools/watch.mjs --self-test              # report what it WOULD alert on
 *   node tools/watch.mjs --once                   # one poll, then exit
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')

/** zstd frame magic. */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Which event means which alert, for the types confirmed in a real log. */
const RULES = [
  { type: 'approval/asked', kind: 'approval' },
  { type: 'turn/end', kind: 'idle' },
]

// ------------------------------------------------------------- log access ---

/**
 * Byte offsets of every zstd frame in a buffer.
 * @param {Buffer} buffer
 * @returns {number[]} ascending offsets.
 */
function frameOffsets(buffer) {
  const offsets = []
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
    if (buffer[i] === MAGIC[0] && buffer[i + 1] === MAGIC[1] && buffer[i + 2] === MAGIC[2] && buffer[i + 3] === MAGIC[3]) {
      offsets.push(i)
    }
  }
  return offsets
}

/**
 * Decode one frame. Returns null for a frame that is still being written, which
 * is the normal state of the last frame in a live log.
 * @param {Buffer} buffer
 * @param {number} start
 * @param {number} end
 * @returns {string|null}
 */
function decodeFrame(buffer, start, end) {
  try {
    return zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')
  } catch (error) {
    return null
  }
}

/** Newest session log under $DSH_HOME/sessions. */
function newestSessionLog(dshHome) {
  const root = join(dshHome, 'sessions')
  if (!existsSync(root)) throw new Error(`no sessions directory at ${root}`)

  let best = null
  for (const slug of readdirSync(root, { withFileTypes: true })) {
    if (!slug.isDirectory()) continue
    const slugDir = join(root, slug.name)
    for (const session of readdirSync(slugDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      const dir = join(slugDir, session.name)
      for (const name of readdirSync(dir)) {
        if (!/^session.*\.jsonl\.zstd$/.test(name)) continue
        const file = join(dir, name)
        const info = statSync(file)
        if (best === null || info.mtimeMs > best.mtimeMs) best = { file, mtimeMs: info.mtimeMs }
      }
    }
  }

  if (best === null) throw new Error(`no session log found under ${root}`)
  return best.file
}

// ---------------------------------------------------------------- follower ---

/**
 * Follow one log file and hand back only the events it has not seen before.
 */
class Follower {
  /**
   * @param {string} file
   * @param {{skipHistory:boolean}} options
   */
  constructor(file, options) {
    this.file = file
    this.lastFrameOffset = -1
    this.skipHistory = options.skipHistory
    this.started = false
  }

  /**
   * @returns {{events: object[], skippedFrames: number, pending: boolean}} new events.
   */
  poll() {
    const buffer = readFileSync(this.file)
    const offsets = frameOffsets(buffer)
    if (offsets.length === 0) return { events: [], skippedFrames: 0, pending: false }

    if (!this.started) {
      this.started = true
      // Starting the watcher must not replay the session's whole history.
      if (this.skipHistory) {
        this.lastFrameOffset = offsets[offsets.length - 1]
        return { events: [], skippedFrames: offsets.length, pending: false }
      }
    }

    const events = []
    let skippedFrames = 0
    let pending = false

    for (let i = 0; i < offsets.length; i += 1) {
      const start = offsets[i]
      if (start <= this.lastFrameOffset) continue

      const end = i + 1 < offsets.length ? offsets[i + 1] : buffer.length
      const text = decodeFrame(buffer, start, end)

      if (text === null) {
        // The frame is not complete yet; leave it for the next poll.
        pending = true
        skippedFrames += 1
        continue
      }

      this.lastFrameOffset = start
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        try {
          events.push(JSON.parse(line))
        } catch (error) {
          // A malformed line is not worth aborting the tail for.
        }
      }
    }

    return { events, skippedFrames, pending }
  }
}

// ------------------------------------------------------------------ alert ---

/**
 * Play a WAV with the system player.
 *
 * `stdio: 'ignore'` is required, not cosmetic: capturing a child's output needs
 * a pipe, and a sandboxed process cannot open one.
 */
function play(file) {
  const script = `(New-Object System.Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`
  try {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    })
    child.unref()
    return true
  } catch (error) {
    console.error(`play failed: ${error.message}`)
    return false
  }
}

/**
 * Map one event to an alert kind, or null.
 *
 * The tool name lives at `event.data.name` (measured on a real log:
 * `{type, seq, time, data:{turn, step, callId, name, arguments}}`). An earlier
 * version scanned the serialized event for the literal string instead and
 * reported 19 questions in a log that contains 6, because any tool call that
 * merely mentioned the name - reading a file about it - matched.
 *
 * @param {object} event
 * @returns {'approval'|'idle'|'question'|null}
 */
function classify(event) {
  const type = typeof event.type === 'string' ? event.type : ''

  for (const rule of RULES) {
    if (type === rule.type) return rule.kind
  }

  // A question is an ordinary tool call, so it has no event type of its own.
  if (type === 'tool/call') {
    const data = event.data
    if (data !== null && typeof data === 'object' && data.name === 'ask_user_question') return 'question'
  }

  return null
}

// -------------------------------------------------------------------- CLI ---

function parseArgs(argv) {
  const options = {
    dshHome: process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh'),
    wav: join(repoRoot, 'audio', 'approval.wav'),
    interval: 700,
    once: false,
    selfTest: false,
    skipHistory: true,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) throw new Error(`missing value for ${arg}`)
      return argv[i]
    }
    if (arg === '--wav') options.wav = next()
    else if (arg === '--interval') options.interval = Number(next())
    else if (arg === '--dsh-home') options.dshHome = next()
    else if (arg === '--session-log') options.sessionLog = next()
    else if (arg === '--once') options.once = true
    else if (arg === '--self-test') options.selfTest = true
    else if (arg === '--replay') options.skipHistory = false
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`unknown option: ${arg}`)
  }

  return options
}

const HELP = `watch.mjs — chime when the harness asks for the user or a run ends.

Follows the newest DSH session log and plays a WAV on:
  approval/asked            a permission prompt is waiting
  turn/end                  a run finished
  tool/call ask_user_question   (best effort) a question was asked

Options:
  --wav <path>         sound to play            (default audio/approval.wav)
  --interval <ms>      poll interval            (default 700)
  --dsh-home <path>    DSH home                 (default %DSH_HOME% or ~/.dsh)
  --session-log <path> follow one specific log instead of the newest
  --once               poll once and exit
  --self-test          report what it would alert on, play nothing
  --replay             process the existing history instead of skipping it
  --help               this text

Leave it running in a terminal. It is a plain process: no plugin, no profile, and
a DSH upgrade cannot uninstall it — only a change to the log format can break it.
`

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`error: ${error.message}`)
    return 2
  }

  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }

  const file = options.sessionLog || newestSessionLog(options.dshHome)
  console.log(`following : ${file}`)
  console.log(`wav       : ${options.wav}`)
  console.log(`exists    : ${existsSync(options.wav)}`)

  if (options.selfTest) {
    // Replay everything and report, so the detector can be checked without
    // waiting for a real approval.
    const follower = new Follower(file, { skipHistory: false })
    const { events } = follower.poll()
    const counts = new Map()
    for (const event of events) {
      const kind = classify(event)
      if (kind === null) continue
      counts.set(kind, (counts.get(kind) || 0) + 1)
    }
    console.log(`events    : ${events.length}`)
    console.log('would alert on:')
    if (counts.size === 0) console.log('  (nothing)')
    for (const [kind, count] of counts) console.log(`  ${kind}  x${count}`)
    return 0
  }

  const follower = new Follower(file, { skipHistory: options.skipHistory })
  console.log(`interval  : ${options.interval} ms`)
  console.log('watching… (Ctrl+C to stop)')

  const tick = () => {
    let result
    try {
      result = follower.poll()
    } catch (error) {
      console.error(`poll failed: ${error.message}`)
      return
    }

    for (const event of result.events) {
      const kind = classify(event)
      if (kind === null) continue
      const at = new Date().toLocaleTimeString()
      console.log(`${at}  ${kind}`)
      if (kind === 'approval' || kind === 'question') play(options.wav)
      else play(options.wav)
    }
  }

  tick()
  if (options.once) return 0

  // setInterval would keep the process alive on its own; a loop with a sleep
  // makes --once and Ctrl+C behave predictably.
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, options.interval))
    tick()
  }
}

main().then(
  (code) => {
    if (typeof code === 'number') process.exit(code)
  },
  (error) => {
    console.error(`fatal: ${error.message}`)
    process.exit(1)
  },
)
