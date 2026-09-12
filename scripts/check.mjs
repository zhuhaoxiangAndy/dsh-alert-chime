/**
 * Verifies both halves the way DSH itself does, then verifies the one piece of
 * hand-rolled bit twiddling that a mistake in would be invisible until a toast
 * came out garbled.
 *
 * 1. Syntax. `node --check` cannot be used on `src/*.js` directly: those files
 *    are function BODIES and contain a top-level `return`, which is a syntax
 *    error in a script. The parameter lists below mirror the two real
 *    evaluators (`dsh-cordis-host-runner` sandbox / `dsh-cordis-client-runner`
 *    closure), so a name the sandbox shadows is shadowed here too.
 *
 * 2. Encoder. `utf16leBase64` is extracted from src/host.js between its region
 *    markers and round-tripped against Node's own Buffer encoder. It has to be
 *    hand-rolled because the sandbox's `btoa` is UTF-8 based, and getting it
 *    wrong corrupts every non-ASCII toast.
 *
 * Usage: node scripts/check.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Host sandbox symbol surface (HOST_BUILTIN_INSPECTION). */
const HOST_PARAMS = ['ctx', 'harness', 'console', 'btoa', 'atob', 'TextEncoder', 'TextDecoder']

/** Browser closure symbol surface (evaluator parameters + redirect traps). */
const CLIENT_PARAMS = [
  'React',
  'console',
  'styles',
  'host',
  'harness',
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval',
  'fetch',
  'require',
  'process',
  'Buffer',
]

const TARGETS = [
  { file: 'src/host.js', params: HOST_PARAMS },
  { file: 'src/client.js', params: CLIENT_PARAMS },
]

let failed = 0

// --- 1) syntax ------------------------------------------------------------

const sources = new Map()

for (const target of TARGETS) {
  const source = readFileSync(join(root, target.file), 'utf8')
  sources.set(target.file, source)
  const wrapped = `return (async () => {\n${source}\n})()`
  try {
    // Parsing only: the body is never executed here.
    new Function(...target.params, wrapped)
    const lines = source.split('\n').length
    console.log(`ok    syntax      ${target.file}  ${lines} lines, ${target.params.length} closure symbols`)
  } catch (error) {
    failed += 1
    console.error(`FAIL  syntax      ${target.file}: ${error.message}`)
  }
}

// --- 2) the UTF-16LE base64 encoder --------------------------------------

const START = '// #region utf16le-base64'
const END = '// #endregion utf16le-base64'

const host = sources.get('src/host.js') ?? ''
const from = host.indexOf(START)
const to = host.indexOf(END)

if (from < 0 || to < 0 || to <= from) {
  failed += 1
  console.error(`FAIL  encoder     region markers ${START} / ${END} not found in src/host.js`)
} else {
  let encode
  try {
    encode = new Function(`${host.slice(from, to)}\nreturn utf16leBase64`)()
  } catch (error) {
    failed += 1
    console.error(`FAIL  encoder     could not build utf16leBase64: ${error.message}`)
  }

  if (encode) {
    const cases = [
      '',
      'A',
      'AB',
      'ABC',
      'ABCD',
      'DSH',
      '审批',
      'DSH · 提问',
      '工作区 · e:\\项目\\dsh-alert-chime',
      '会话 · 提示音插件开发',
      `mixed 'single' and "double" and & < > quotes`,
      'emoji 🚀 tail',
      '日本語と한국어とРусский',
      'x'.repeat(200),
    ]

    const mismatches = []
    for (const value of cases) {
      const expected = Buffer.from(value, 'utf16le').toString('base64')
      let actual
      try {
        actual = encode(value)
      } catch (error) {
        actual = `threw: ${error.message}`
      }
      if (actual !== expected) mismatches.push({ value, expected, actual })
    }

    if (mismatches.length === 0) {
      console.log(`ok    encoder     utf16leBase64 matches Buffer utf16le on ${cases.length} cases`)
    } else {
      failed += 1
      for (const mismatch of mismatches) {
        console.error(`FAIL  encoder     ${JSON.stringify(mismatch.value)}`)
        console.error(`                    expected ${mismatch.expected}`)
        console.error(`                    actual   ${mismatch.actual}`)
      }
    }
  }
}

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
