/**
 * smoke.mjs — generate the example alert sounds and prove each one is valid.
 *
 * In-process on purpose: it imports the same functions the CLI uses and parses
 * the produced bytes back, so no child process is involved. That matters twice
 * over here - a sandboxed Node cannot capture a child's piped output, and
 * Windows blocks unsigned .ps1 files, which is why a PowerShell version of this
 * check could not run at all.
 *
 * It asserts the things that actually go wrong: a wrong RIFF size, an empty or
 * silent file, clipping, and a duration that does not match the spec.
 *
 * Usage: node tools/smoke.mjs
 */

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { parseSpec, render, scale, encodeWav } from './synth.mjs'
import { parseWav, analyse } from './verify-wav.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const audioDir = join(root, 'audio')

const OPTIONS = {
  rate: 44100,
  tempo: 120,
  wave: 'sine',
  gain: 0.8,
  attack: 8,
  release: 60,
  tail: 120,
  normalize: true,
}

/** The example sounds, one per alert kind. */
const EXAMPLES = [
  { name: 'approval', spec: 'A5:e D6:q', wave: 'sine' },
  { name: 'question', spec: 'E5:e B5:q', wave: 'triangle' },
  { name: 'idle', spec: 'C5:e G5:h', wave: 'sine' },
  { name: 'chord', spec: '[C5+E5+G5]:h', wave: 'saw' },
]

let failed = 0

function check(condition, message) {
  if (condition) return true
  failed += 1
  console.error(`FAIL  ${message}`)
  return false
}

mkdirSync(audioDir, { recursive: true })

console.log('=== synth + verify (in process) ===')

for (const example of EXAMPLES) {
  const options = { ...OPTIONS, wave: example.wave }
  const events = parseSpec(example.spec, options)

  // The expected length follows from the parsed events, so this checks the
  // pipeline against itself rather than against a hard-coded number.
  let end = 0
  for (const event of events) end = Math.max(end, event.at + event.duration)
  const expectedSeconds = end + options.tail / 1000 + 0.05

  const raw = render(events, options)
  const { samples } = scale(raw, options)
  const wav = encodeWav(samples, options.rate)

  const outPath = join(audioDir, `${example.name}.wav`)
  writeFileSync(outPath, wav)

  // Read the bytes back from disk: this is what a player will see.
  const buffer = readFileSync(outPath)
  let parsed
  try {
    parsed = parseWav(buffer)
  } catch (error) {
    check(false, `${example.name}: the written file does not parse -> ${error.message}`)
    continue
  }

  const stats = analyse(parsed.samples)
  const duration = parsed.samples.length / parsed.rate

  const okDuration = check(
    Math.abs(duration - expectedSeconds) < 0.01,
    `${example.name}: duration ${duration.toFixed(3)}s != expected ${expectedSeconds.toFixed(3)}s`,
  )
  const okSignal = check(
    stats.peak > 1000 && stats.peak < 32767 && stats.clipped === 0,
    `${example.name}: bad peak ${stats.peak} / clipped ${stats.clipped}`,
  )

  if (okDuration && okSignal) {
    console.log(
      `ok    ${example.name.padEnd(9)} ${String(wav.length).padStart(7)} bytes` +
        `  ${duration.toFixed(3)}s  peak ${((stats.peak / 32767) * 100).toFixed(0)}%` +
        `  rms ${Math.round(stats.rms).toString().padStart(5)}  ${example.spec}`,
    )
  }
}

console.log('')
console.log('=== negative checks (these must throw) ===')

const badSpecs = [
  { spec: 'H9:q', why: 'an unreadable pitch' },
  { spec: 'C5:zzz', why: 'an unreadable duration' },
  { spec: '', why: 'an empty spec' },
]

for (const bad of badSpecs) {
  let threw = false
  try {
    parseSpec(bad.spec, OPTIONS)
  } catch (error) {
    threw = true
  }
  check(threw, `accepted a spec with ${bad.why} ("${bad.spec}")`)
  if (threw) console.log(`ok    rejects ${bad.why}`)
}

// A file that is not a WAV must be refused rather than misread.
let rejectedGarbage = false
try {
  parseWav(Buffer.from('this is not a wave file at all, not even close'))
} catch (error) {
  rejectedGarbage = true
}
check(rejectedGarbage, 'accepted a non-WAV buffer')
if (rejectedGarbage) console.log('ok    rejects a non-WAV buffer')

console.log('')
if (failed === 0) {
  console.log('ALL CHECKS PASSED')
  process.exit(0)
} else {
  console.log(`${failed} CHECK(S) FAILED`)
  process.exit(1)
}
