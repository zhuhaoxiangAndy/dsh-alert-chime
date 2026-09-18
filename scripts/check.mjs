/**
 * Verifies everything the two shipping forms depend on.
 *
 * 1. Syntax of the dynamic halves. `node --check` cannot be used on `src/*.js`:
 *    those files are function BODIES and contain a top-level `return`, which is
 *    a syntax error in a script. The parameter lists mirror the two real
 *    evaluators, so a name the sandbox shadows is shadowed here too.
 *
 * 2. The plugin package actually loads and exports the Cordis contract
 *    (`name`, `inject`, `apply`). Importing it is a real load test: the module
 *    has no side effects at load time, so this is safe, and it catches a broken
 *    export that a composition row would otherwise reject at mount.
 *
 * 3. The UTF-16LE base64 encoder, in EVERY file that carries one, extracted
 *    between its region markers and round-tripped against Node's own Buffer
 *    encoder. There are two copies by necessity - a dynamic half cannot import
 *    from a module and vice versa - so checking only one would let the other rot
 *    silently, and a wrong encoder corrupts every non-ASCII notification.
 *
 * Usage: node scripts/check.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
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

/** Function-body halves evaluated in a sandbox / closure. */
const BODY_TARGETS = [
  { file: 'src/host.js', params: HOST_PARAMS },
  { file: 'src/client.js', params: CLIENT_PARAMS },
]

/** Every file that carries a copy of the encoder. */
const ENCODER_SOURCES = ['src/host.js', 'plugin/lib/index.js']

const PLUGIN_MODULE = 'plugin/lib/index.js'

const START = '// #region utf16le-base64'
const END = '// #endregion utf16le-base64'

let failed = 0

function fail(message) {
  failed += 1
  console.error(`FAIL  ${message}`)
}

// --- 1) syntax of the dynamic halves, caching their sources ---------------

const sources = new Map()

for (const target of BODY_TARGETS) {
  const source = readFileSync(join(root, target.file), 'utf8')
  sources.set(target.file, source)
  const wrapped = `return (async () => {\n${source}\n})()`
  try {
    // Parsing only: the body is never executed here.
    new Function(...target.params, wrapped)
    console.log(`ok    syntax      ${target.file}  ${source.split('\n').length} lines, ${target.params.length} closure symbols`)
  } catch (error) {
    fail(`syntax      ${target.file}: ${error.message}`)
  }
}

// --- 2) the plugin package loads and exports the Cordis contract ----------

try {
  const loaded = await import(pathToFileURL(join(root, PLUGIN_MODULE)).href)

  const problems = []
  if (typeof loaded.name !== 'string' || loaded.name === '') problems.push('name is not a non-empty string')
  if (!Array.isArray(loaded.inject)) problems.push('inject is not an array')
  if (typeof loaded.apply !== 'function') problems.push('apply is not a function')

  if (problems.length === 0) {
    console.log(`ok    plugin      ${PLUGIN_MODULE}  name=${loaded.name} inject=[${loaded.inject.join(', ')}] apply=fn`)
  } else {
    fail(`plugin      ${PLUGIN_MODULE}: ${problems.join('; ')}`)
  }

  sources.set(PLUGIN_MODULE, readFileSync(join(root, PLUGIN_MODULE), 'utf8'))
} catch (error) {
  fail(`plugin      ${PLUGIN_MODULE} failed to load: ${error.message}`)
}

// --- 3) the encoder, in every copy ---------------------------------------

const CASES = [
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

const built = []

for (const file of ENCODER_SOURCES) {
  const source = sources.get(file) ?? readFileSync(join(root, file), 'utf8')
  const from = source.indexOf(START)
  const to = source.indexOf(END)

  if (from < 0 || to <= from) {
    fail(`encoder     region markers ${START} / ${END} not found in ${file}`)
    continue
  }

  let encode
  try {
    encode = new Function(`${source.slice(from, to)}\nreturn utf16leBase64`)()
    built.push({ file, encode })
  } catch (error) {
    fail(`encoder     could not build utf16leBase64 from ${file}: ${error.message}`)
    continue
  }

  const mismatches = []
  for (const value of CASES) {
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
    console.log(`ok    encoder     ${file}  matches Buffer utf16le on ${CASES.length} cases`)
  } else {
    fail(`encoder     ${file}: ${mismatches.length} mismatch(es)`)
    for (const mismatch of mismatches) {
      console.error(`                    ${JSON.stringify(mismatch.value)}`)
      console.error(`                    expected ${mismatch.expected}`)
      console.error(`                    actual   ${mismatch.actual}`)
    }
  }
}

// --- 4) the encoder copies must not drift apart --------------------------

if (built.length === 2) {
  const drifted = CASES.filter((value) => built[0].encode(value) !== built[1].encode(value))
  if (drifted.length === 0) {
    console.log(`ok    encoder     ${built[0].file} and ${built[1].file} agree on all cases`)
  } else {
    fail(`encoder     ${built[0].file} and ${built[1].file} disagree on ${drifted.length} case(s)`)
  }
}

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
