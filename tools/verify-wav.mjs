/**
 * verify-wav.mjs — read a WAV back and prove it is what it claims to be.
 *
 * "The file exists" is not a test. This parses the container and the PCM data
 * and checks the things that actually break: a wrong chunk size (plays as noise
 * or is rejected), a bad byte rate, a silent file, and clipped samples.
 *
 * Usage:
 *   node tools/verify-wav.mjs <file.wav> [--expect-duration 0.72] [--tolerance 0.05]
 *   node tools/verify-wav.mjs <file.wav> --json
 */

import { readFileSync } from 'node:fs'

class VerifyError extends Error {}

/**
 * Parse a RIFF/WAVE PCM file.
 * @param {Buffer} buffer
 * @returns {{format:number, channels:number, rate:number, bits:number, dataOffset:number, samples:Int16Array}}
 */
export function parseWav(buffer) {
  if (buffer.length < 44) throw new VerifyError(`file is only ${buffer.length} bytes; a WAV header alone is 44`)

  const riff = buffer.toString('ascii', 0, 4)
  const wave = buffer.toString('ascii', 8, 12)
  if (riff !== 'RIFF') throw new VerifyError(`expected RIFF, found "${riff}"`)
  if (wave !== 'WAVE') throw new VerifyError(`expected WAVE, found "${wave}"`)

  const riffSize = buffer.readUInt32LE(4)
  if (riffSize !== buffer.length - 8) {
    throw new VerifyError(`RIFF size ${riffSize} does not match file length ${buffer.length} - 8 = ${buffer.length - 8}`)
  }

  // Walk the chunks rather than assuming the canonical 44-byte layout.
  let offset = 12
  let format = 0
  let channels = 0
  let rate = 0
  let bits = 0
  let dataOffset = -1
  let dataBytes = 0

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const body = offset + 8

    if (id === 'fmt ') {
      format = buffer.readUInt16LE(body)
      channels = buffer.readUInt16LE(body + 2)
      rate = buffer.readUInt32LE(body + 4)
      const byteRate = buffer.readUInt32LE(body + 8)
      const blockAlign = buffer.readUInt16LE(body + 12)
      bits = buffer.readUInt16LE(body + 14)

      const expectedByteRate = rate * channels * (bits / 8)
      if (byteRate !== expectedByteRate) {
        throw new VerifyError(`byte rate ${byteRate} != rate*channels*bits/8 = ${expectedByteRate}`)
      }
      if (blockAlign !== channels * (bits / 8)) {
        throw new VerifyError(`block align ${blockAlign} != channels*bits/8 = ${channels * (bits / 8)}`)
      }
    } else if (id === 'data') {
      dataOffset = body
      dataBytes = size
    }

    // Chunks are word-aligned.
    offset = body + size + (size % 2)
  }

  if (dataOffset < 0) throw new VerifyError('no data chunk')
  if (format !== 1) throw new VerifyError(`expected PCM format 1, found ${format}`)
  if (bits !== 16) throw new VerifyError(`expected 16-bit samples, found ${bits}`)
  if (dataOffset + dataBytes > buffer.length) {
    throw new VerifyError(`data chunk claims ${dataBytes} bytes but only ${buffer.length - dataOffset} remain`)
  }

  const samples = new Int16Array(dataBytes / 2)
  for (let i = 0; i < samples.length; i += 1) samples[i] = buffer.readInt16LE(dataOffset + i * 2)

  return { format, channels, rate, bits, dataOffset, samples }
}

/**
 * Summarise what is in the samples.
 * @param {Int16Array} samples
 * @returns {{peak:number, peakAt:number, rms:number, silent:number, clipped:number}}
 */
export function analyse(samples) {
  let peak = 0
  let peakAt = 0
  let sumSquares = 0
  let silent = 0
  let clipped = 0

  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i]
    const magnitude = Math.abs(value)
    if (magnitude > peak) {
      peak = magnitude
      peakAt = i
    }
    sumSquares += value * value
    if (magnitude === 0) silent += 1
    if (magnitude >= 32767) clipped += 1
  }

  return {
    peak,
    peakAt,
    rms: samples.length === 0 ? 0 : Math.sqrt(sumSquares / samples.length),
    silent,
    clipped,
  }
}

function main() {
  const argv = process.argv.slice(2)
  const file = argv.find((arg) => !arg.startsWith('--'))
  const asJson = argv.includes('--json')

  const durationIndex = argv.indexOf('--expect-duration')
  const expectDuration = durationIndex >= 0 ? Number(argv[durationIndex + 1]) : null
  const toleranceIndex = argv.indexOf('--tolerance')
  const tolerance = toleranceIndex >= 0 ? Number(argv[toleranceIndex + 1]) : 0.05

  if (!file) {
    console.error('usage: node tools/verify-wav.mjs <file.wav> [--expect-duration N] [--tolerance N] [--json]')
    return 2
  }

  let result
  try {
    const buffer = readFileSync(file)
    const parsed = parseWav(buffer)
    const stats = analyse(parsed.samples)
    const duration = parsed.samples.length / parsed.channels / parsed.rate

    if (duration <= 0) throw new VerifyError('the file contains no samples')
    if (stats.peak === 0) throw new VerifyError('the file is entirely silent')
    if (stats.peak < 100) throw new VerifyError(`signal is far too quiet (peak ${stats.peak} of 32767)`)
    if (stats.clipped > parsed.samples.length * 0.001) {
      throw new VerifyError(`${stats.clipped} clipped samples (${((stats.clipped / parsed.samples.length) * 100).toFixed(2)}%)`)
    }
    if (expectDuration !== null && Math.abs(duration - expectDuration) > tolerance) {
      throw new VerifyError(`duration ${duration.toFixed(3)}s is not within ${tolerance}s of ${expectDuration}s`)
    }

    result = {
      file,
      ok: true,
      rate: parsed.rate,
      channels: parsed.channels,
      bits: parsed.bits,
      samples: parsed.samples.length,
      duration: Number(duration.toFixed(4)),
      peak: stats.peak,
      peakPercent: Number(((stats.peak / 32767) * 100).toFixed(1)),
      rms: Math.round(stats.rms),
      silentPercent: Number(((stats.silent / parsed.samples.length) * 100).toFixed(1)),
      clipped: stats.clipped,
      bytes: buffer.length,
    }
  } catch (error) {
    if (asJson) {
      console.log(JSON.stringify({ file, ok: false, error: error.message }))
    } else {
      console.error(`FAIL ${file}: ${error.message}`)
    }
    return 1
  }

  if (asJson) {
    console.log(JSON.stringify(result))
  } else {
    console.log(`ok       : ${result.file}`)
    console.log(`format   : ${result.rate} Hz, ${result.channels} ch, ${result.bits}-bit PCM`)
    console.log(`duration : ${result.duration}s  (${result.samples} samples)`)
    console.log(`peak     : ${result.peak}  (${result.peakPercent}% of full scale)`)
    console.log(`rms      : ${result.rms}`)
    console.log(`silence  : ${result.silentPercent}% of samples are exactly zero`)
    console.log(`clipped  : ${result.clipped}`)
    console.log(`bytes    : ${result.bytes}`)
  }

  return 0
}

if (process.argv[1] && process.argv[1].endsWith('verify-wav.mjs')) {
  process.exit(main())
}
