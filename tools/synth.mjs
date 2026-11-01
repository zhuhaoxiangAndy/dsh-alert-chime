/**
 * synth.mjs — turn a description of notes and pitches into a WAV file.
 *
 * No dependencies, no plugin system, no profile: this runs anywhere Node runs,
 * which is deliberate. It exists because "play a custom alert sound" kept
 * depending on machinery that a DSH upgrade could take away; generating the
 * audio itself is a plain computation and cannot be broken that way.
 *
 * Spec grammar (write it the way you would hum it):
 *
 *   C5:q E5:q G5:h         notes with durations
 *   A4:h                   one note
 *   880Hz:0.3s             an explicit frequency, in Hz
 *   -:q                    a rest
 *   [C4+E4+G4]:h           a chord (notes started together)
 *   C5:q.                  a dotted quarter
 *   C5:200ms               explicit milliseconds
 *
 * Durations: w whole, h half, q quarter, e eighth, s sixteenth, t thirty-second;
 * a trailing '.' adds half again; a bare number is beats; 'NNNms' and 'N.Ns'
 * are absolute.
 *
 * Octaves follow scientific pitch notation, so A4 = 440 Hz and C4 = middle C.
 * Accidentals are '#' (also 's') and 'b'.
 *
 * Waveforms are built additively and every harmonic above Nyquist is dropped, so
 * square and sawtooth do not alias into the audible band. Each note gets a short
 * attack and release ramp, because a hard start and stop is an audible click.
 *
 * Usage:
 *   node tools/synth.mjs "C5:q E5:q G5:h" --out chime.wav
 *   node tools/synth.mjs --spec-file spec.json --out chime.wav
 *   node tools/synth.mjs --help
 */

import { writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'

const DEFAULTS = {
  rate: 44100,
  tempo: 120,
  wave: 'sine',
  gain: 0.8,
  attack: 8,
  release: 60,
  tail: 120,
  normalize: false,
}

/** Semitone offset of each natural note inside an octave. */
const SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

/** Beat length in beats, before dots. */
const DURATIONS = { w: 4, h: 2, q: 1, e: 0.5, s: 0.25, t: 0.125 }

class SpecError extends Error {}

// ------------------------------------------------------------------ parsing ---

/**
 * Split a spec on whitespace and commas, but never inside a chord's brackets.
 * @param {string} text
 * @returns {string[]} one token per note, chord or rest.
 */
function tokenize(text) {
  const tokens = []
  let depth = 0
  let current = ''

  for (const char of text) {
    if (char === '[') depth += 1
    if (char === ']') depth = Math.max(0, depth - 1)

    const separator = depth === 0 && (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',')
    if (separator) {
      if (current !== '') tokens.push(current)
      current = ''
    } else {
      current += char
    }
  }
  if (current !== '') tokens.push(current)
  return tokens
}

/**
 * Convert one pitch spelling to Hz.
 * @param {string} text - 'C5', 'C#5', 'Db5', '880', '880Hz', or a rest marker.
 * @returns {number|null} frequency, or null for a rest.
 */
function pitchToHz(text) {
  const value = String(text).trim()
  if (value === '' || value === '-' || value.toLowerCase() === 'r') return null

  const frequencyMatch = /^(\d+(?:\.\d+)?)\s*(?:hz)?$/i.exec(value)
  if (frequencyMatch) {
    const hz = Number(frequencyMatch[1])
    if (!(hz > 0)) throw new SpecError(`frequency must be positive: "${value}"`)
    return hz
  }

  const noteMatch = /^([A-Ga-g])([#sb]?)(-?\d)$/.exec(value)
  if (!noteMatch) throw new SpecError(`cannot read pitch: "${value}"`)

  const letter = noteMatch[1].toUpperCase()
  const accidental = noteMatch[2]
  const octave = Number(noteMatch[3])

  let semitone = SEMITONES[letter]
  if (accidental === '#' || accidental === 's') semitone += 1
  if (accidental === 'b') semitone -= 1

  const midi = (octave + 1) * 12 + semitone
  return 440 * Math.pow(2, (midi - 69) / 12)
}

/**
 * Convert one duration spelling to seconds.
 * @param {string} text - 'q', 'q.', '1.5', '200ms', '0.3s'.
 * @param {number} tempo - beats per minute.
 * @returns {number} seconds.
 */
function durationToSeconds(text, tempo) {
  const value = String(text).trim()
  if (value === '') throw new SpecError('missing duration')

  const absoluteMs = /^(\d+(?:\.\d+)?)ms$/i.exec(value)
  if (absoluteMs) return Number(absoluteMs[1]) / 1000

  const absoluteSeconds = /^(\d+(?:\.\d+)?)s$/i.exec(value)
  if (absoluteSeconds) return Number(absoluteSeconds[1])

  const beats = /^(\d+(?:\.\d+)?)$/.exec(value)
  if (beats) return (Number(beats[1]) * 60) / tempo

  const lettered = /^([whqest])(\.*)$/i.exec(value)
  if (!lettered) throw new SpecError(`cannot read duration: "${value}"`)

  let beatLength = DURATIONS[lettered[1].toLowerCase()]
  // Each dot adds half of the previous value.
  for (const _dot of lettered[2]) beatLength += beatLength / 2

  return (beatLength * 60) / tempo
}

/**
 * Parse a spec into a flat list of timed notes.
 * @param {string} text - the whole spec.
 * @param {object} options - resolved options (tempo is required).
 * @returns {{at:number, duration:number, frequency:number|null}[]} events.
 */
export function parseSpec(text, options) {
  const tokens = tokenize(text)
  if (tokens.length === 0) throw new SpecError('the spec is empty')

  const events = []
  let cursor = 0

  for (const token of tokens) {
    const separator = token.lastIndexOf(':')
    const pitchPart = separator >= 0 ? token.slice(0, separator) : token
    const durationPart = separator >= 0 ? token.slice(separator + 1) : 'q'

    if (pitchPart === '') throw new SpecError(`missing pitch in "${token}"`)
    const duration = durationToSeconds(durationPart, options.tempo)

    if (pitchPart.startsWith('[') && pitchPart.endsWith(']')) {
      const inner = pitchPart.slice(1, -1)
      const members = inner.split('+').map((member) => member.trim()).filter((member) => member !== '')
      if (members.length === 0) throw new SpecError(`empty chord in "${token}"`)
      for (const member of members) {
        const frequency = pitchToHz(member)
        if (frequency !== null) events.push({ at: cursor, duration, frequency })
      }
    } else {
      const frequency = pitchToHz(pitchPart)
      if (frequency !== null) events.push({ at: cursor, duration, frequency })
    }

    cursor += duration
  }

  return events
}

// -------------------------------------------------------------- synthesis ---

/**
 * Harmonic amplitudes for one waveform, cut off before Nyquist.
 * @param {string} wave - sine | square | saw | triangle.
 * @param {number} frequency - fundamental in Hz.
 * @param {number} rate - sample rate.
 * @returns {{n:number, amplitude:number}[]} harmonics to sum.
 */
function harmonics(wave, frequency, rate) {
  const nyquist = rate / 2
  const limit = Math.max(1, Math.floor(nyquist / frequency))
  // A generous harmonic count is still cheap here; the limit is aliasing, not cost.
  const count = Math.min(limit, 64)
  const result = []

  for (let n = 1; n <= count; n += 1) {
    if (wave === 'sine') {
      if (n === 1) result.push({ n, amplitude: 1 })
      break
    }
    if (wave === 'square') {
      if (n % 2 === 1) result.push({ n, amplitude: 1 / n })
      continue
    }
    if (wave === 'saw') {
      result.push({ n, amplitude: 1 / n })
      continue
    }
    if (wave === 'triangle') {
      if (n % 2 === 1) result.push({ n, amplitude: (n % 4 === 1 ? 1 : -1) / (n * n) })
      continue
    }
    throw new SpecError(`unknown waveform: "${wave}"`)
  }

  return result
}

/**
 * Render events to mono samples in [-1, 1].
 * @param {{at:number, duration:number, frequency:number|null}[]} events
 * @param {object} options - resolved options.
 * @returns {Float32Array} samples.
 */
export function render(events, options) {
  const rate = options.rate
  let end = 0
  for (const event of events) end = Math.max(end, event.at + event.duration)
  const seconds = end + options.tail / 1000 + 0.05

  const samples = new Float32Array(Math.ceil(seconds * rate))
  const attack = Math.max(0, options.attack) / 1000
  const release = Math.max(0, options.release) / 1000

  for (const event of events) {
    const start = Math.floor(event.at * rate)
    // The note keeps ringing while it fades, so the release does not eat the note.
    const body = Math.floor(event.duration * rate)
    const fade = Math.min(Math.floor((attack + release) * rate), body)
    const total = body + Math.floor(release * rate)

    const table = harmonics(options.wave, event.frequency, rate)
    const twoPiF = (2 * Math.PI * event.frequency) / rate

    for (let i = 0; i < total; i += 1) {
      const index = start + i
      if (index >= samples.length) break

      // Envelope: linear attack, then flat, then a linear release that starts
      // before the nominal end so the note decays instead of stopping dead.
      let envelope = 1
      const attackSamples = Math.max(1, Math.floor(attack * rate))
      const releaseSamples = Math.max(1, fade > 0 ? Math.floor(release * rate) : 1)
      if (i < attackSamples) envelope = i / attackSamples
      else if (i > body - 1) envelope = Math.max(0, 1 - (i - body + 1) / releaseSamples)

      if (envelope <= 0) continue

      let value = 0
      for (const harmonic of table) value += harmonic.amplitude * Math.sin(twoPiF * harmonic.n * i)
      samples[index] += value * envelope
    }
  }

  return samples
}

/**
 * Apply gain, optional normalisation, and a final limiter.
 *
 * Normalisation targets 0.98 of full scale rather than 1.0 on purpose. Exactly
 * 1.0 quantises to 32767, the largest int16, which leaves no headroom for
 * anything downstream that applies gain and is indistinguishable from a clipped
 * sample when the file is inspected. The first version did normalise to 1.0 and
 * the smoke test caught every example landing on the rail.
 *
 * @param {Float32Array} samples
 * @param {object} options
 * @returns {{samples:Float32Array, peak:number, clipped:boolean}} scaled samples.
 */
export function scale(samples, options) {
  const HEADROOM = 0.98

  let peak = 0
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample))

  let factor = options.gain
  if (options.normalize && peak > 0) factor = HEADROOM / peak
  else if (peak * factor > HEADROOM) factor = HEADROOM / peak

  const scaled = new Float32Array(samples.length)
  let clipped = false
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i] * factor
    if (value > 1 || value < -1) clipped = true
    scaled[i] = Math.max(-1, Math.min(1, value))
  }

  return { samples: scaled, peak, clipped }
}

/**
 * Encode mono float samples as a 16-bit PCM WAV.
 * @param {Float32Array} samples - in [-1, 1].
 * @param {number} rate - sample rate.
 * @returns {Buffer} a complete RIFF/WAVE file.
 */
export function encodeWav(samples, rate) {
  const channels = 1
  const bitsPerSample = 16
  const blockAlign = (channels * bitsPerSample) / 8
  const byteRate = rate * blockAlign
  const dataBytes = samples.length * blockAlign

  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // PCM fmt chunk size
  header.writeUInt16LE(1, 20) // format 1 = PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataBytes, 40)

  const body = Buffer.alloc(dataBytes)
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    // 32767 rather than 32768: the positive rail must stay inside int16.
    body.writeInt16LE(Math.round(clamped * 32767), i * 2)
  }

  return Buffer.concat([header, body])
}

// -------------------------------------------------------------------- CLI ---

const HELP = `synth.mjs — describe notes and pitches, get a WAV file.

Usage:
  node tools/synth.mjs "<spec>" --out <file.wav> [options]

Spec:
  C5:q E5:q G5:h     note and duration, separated by spaces or commas
  880Hz:0.3s         explicit frequency
  -:q                rest
  [C4+E4+G4]:h       chord
  C5:q.              dotted quarter
  C5:200ms           explicit milliseconds

Durations: w h q e s t (whole .. thirty-second), '.' adds half, a bare number is
beats, NNNms and N.Ns are absolute.

Options:
  --out <path>       output WAV (required unless --dry-run)
  --wave <name>      sine | square | saw | triangle      (default sine)
  --rate <hz>        sample rate                          (default 44100)
  --tempo <bpm>      beats per minute                     (default 120)
  --gain <0..1>      output gain                          (default 0.8)
  --attack <ms>      attack ramp                          (default 8)
  --release <ms>     release ramp                         (default 60)
  --tail <ms>        silence after the last note          (default 120)
  --normalize        scale so the peak reaches full scale
  --spec-file <path> read the spec from a file instead of the argument
  --dry-run          print the parsed events and the length estimate only
  --help             this text

Exit codes: 0 success, 1 bad spec or IO error.
`

function parseArgs(argv) {
  const options = { ...DEFAULTS }
  let spec = ''
  let out = ''
  let specFile = ''
  let dryRun = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) throw new SpecError(`missing value for ${arg}`)
      return argv[i]
    }

    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--out') out = next()
    else if (arg === '--spec-file') specFile = next()
    else if (arg === '--wave') options.wave = next()
    else if (arg === '--rate') options.rate = Number(next())
    else if (arg === '--tempo') options.tempo = Number(next())
    else if (arg === '--gain') options.gain = Number(next())
    else if (arg === '--attack') options.attack = Number(next())
    else if (arg === '--release') options.release = Number(next())
    else if (arg === '--tail') options.tail = Number(next())
    else if (arg === '--normalize') options.normalize = true
    else if (arg === '--dry-run') dryRun = true
    else if (arg.startsWith('--')) throw new SpecError(`unknown option: ${arg}`)
    else spec = spec === '' ? arg : `${spec} ${arg}`
  }

  if (specFile !== '') spec = readFileSync(specFile, 'utf8')
  return { spec, out, dryRun, options }
}

function main() {
  let parsed
  try {
    parsed = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`error: ${error.message}`)
    return 1
  }

  if (parsed.options.help) {
    process.stdout.write(HELP)
    return 0
  }

  const { options } = parsed

  try {
    if (!['sine', 'square', 'saw', 'triangle'].includes(options.wave)) {
      throw new SpecError(`--wave must be sine, square, saw or triangle (got "${options.wave}")`)
    }
    if (!(options.rate >= 8000 && options.rate <= 192000)) throw new SpecError('--rate must be 8000..192000')
    if (!(options.tempo > 0)) throw new SpecError('--tempo must be positive')
    if (!(options.gain > 0)) throw new SpecError('--gain must be positive')

    const events = parseSpec(parsed.spec, options)

    if (parsed.dryRun) {
      let end = 0
      for (const event of events) end = Math.max(end, event.at + event.duration)
      console.log(`events   : ${events.length}`)
      for (const event of events) {
        console.log(`  at ${event.at.toFixed(3)}s  ${event.duration.toFixed(3)}s  ${event.frequency.toFixed(2)} Hz`)
      }
      const seconds = end + options.tail / 1000
      console.log(`duration : ${seconds.toFixed(3)}s`)
      console.log(`samples  : ${Math.ceil(seconds * options.rate)} @ ${options.rate} Hz`)
      console.log(`wav bytes: ${Math.ceil(seconds * options.rate) * 2 + 44}`)
      return 0
    }

    if (!parsed.out) throw new SpecError('--out is required (or use --dry-run)')

    const raw = render(events, options)
    const { samples, peak, clipped } = scale(raw, options)
    const wav = encodeWav(samples, options.rate)
    writeFileSync(parsed.out, wav)

    console.log(`wrote    : ${parsed.out}`)
    console.log(`duration : ${(samples.length / options.rate).toFixed(3)}s`)
    console.log(`samples  : ${samples.length} @ ${options.rate} Hz`)
    console.log(`bytes    : ${wav.length}`)
    console.log(`peak     : ${peak.toFixed(4)} (source)` + (clipped ? '  WARNING: limited' : ''))
    return 0
  } catch (error) {
    console.error(`error: ${error.message}`)
    return 1
  }
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('synth.mjs')) {
  process.exit(main())
}
