/**
 * Validates each half the way DSH itself does: as the body of an async function
 * whose parameters ARE the symbol surface.
 *
 * `node --check` cannot be used on `src/*.js` directly: those files are function
 * BODIES and contain a top-level `return`, which is a syntax error in a script.
 * The parameter lists below mirror the two real evaluators
 * (`dsh-cordis-host-runner` sandbox / `dsh-cordis-client-runner` closure), so a
 * name the sandbox shadows is shadowed here too and a stray global is caught.
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

for (const target of TARGETS) {
  const source = readFileSync(join(root, target.file), 'utf8')
  const wrapped = `return (async () => {\n${source}\n})()`
  try {
    // Parsing only: the body is never executed here.
    new Function(...target.params, wrapped)
    const lines = source.split('\n').length
    console.log(`ok   ${target.file}  ${lines} lines, ${target.params.length} closure symbols`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${target.file}: ${error.message}`)
  }
}

process.exit(failed === 0 ? 0 : 1)
