/**
 * End-to-end check of the exact path the Host half uses to raise a Windows
 * notification: the same UTF-16LE base64 encoder (extracted from src/host.js
 * between its region markers), the same toast XML, the same -EncodedCommand
 * invocation.
 *
 * Why this exists: a successful spawn only proves PowerShell started. If the
 * encoded stream or the XML were wrong the toast would simply never appear,
 * while the plugin still reported ok. Running the real bytes here is what tells
 * those apart - and it is what catches the non-ASCII case, which is the failure
 * that actually happened twice while this was being built:
 *
 *   - a BOM-less .ps1 is read as ANSI by Windows PowerShell 5.1, so Chinese
 *     written into a script FILE arrives mangled;
 *   - the sandbox's `btoa` is UTF-8 based, so it cannot produce UTF-16LE bytes.
 *
 * Both are sidestepped by sending the script as an encoded command, and `--dump`
 * proves the round trip rather than trusting it.
 *
 * Usage (PowerShell):
 *   $b64 = (node scripts/toast-e2e.mjs).Trim()
 *   powershell -NoProfile -NonInteractive -EncodedCommand $b64
 *
 *   # round-trip only, no popup: writes the XML text PowerShell actually parsed
 *   $b64 = (node scripts/toast-e2e.mjs --dump).Trim()
 *   powershell -NoProfile -NonInteractive -EncodedCommand $b64
 *   cat toast-roundtrip.txt
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const hostPath = join(root, 'src', 'host.js')

const host = readFileSync(hostPath, 'utf8')
const from = host.indexOf('// #region utf16le-base64')
const to = host.indexOf('// #endregion utf16le-base64')

if (from < 0 || to <= from) {
  console.error('region markers not found in src/host.js')
  process.exit(1)
}

// The encoder is taken from the shipped source, not reimplemented: a copy could
// stay correct here while the plugin's own copy rotted.
const encode = new Function(`${host.slice(from, to)}\nreturn utf16leBase64`)()

/** Registered on a stock Windows install; an unregistered id is dropped silently. */
const AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const stamp = new Date().toTimeString().slice(0, 8)

const lines = [
  '工作区 · dsh-alert-chime',
  '会话 · 提示音插件开发 (encoded-command test)',
  '身份 · 主会话 · ' + stamp,
  `mixed 'quotes' and "double" and & <angle> - ${stamp}`,
]

let xml = '<toast><visual><binding template="ToastGeneric">'
xml += '<text>' + escapeXml('DSH · 审批') + '</text>'
for (const line of lines) xml += '<text>' + escapeXml(line) + '</text>'
xml += '<text placement="attribution">DSH</text>'
xml += '</binding></visual><audio silent="true"/></toast>'

const literal = "'" + xml.replace(/'/g, "''") + "'"

const dumpPath = resolve(argValue('--out', join(root, 'toast-roundtrip.txt')))

const tail = process.argv.includes('--dump')
  ? // Write the text PowerShell actually parsed back out as UTF-8, so fidelity
    // can be checked without a human reading a notification. Does NOT Show().
    `;[IO.File]::WriteAllText('${dumpPath.replace(/\\/g, '\\\\')}',$x.InnerText,[Text.Encoding]::UTF8)`
  : `;[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${AUMID}').Show($t)`

const script =
  [
    '[void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]',
    '[void][Windows.UI.Notifications.ToastNotification,Windows.UI.Notifications,ContentType=WindowsRuntime]',
    '[void][Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime]',
    '$x=New-Object Windows.Data.Xml.Dom.XmlDocument',
    '$x.LoadXml(' + literal + ')',
    '$t=New-Object Windows.UI.Notifications.ToastNotification $x',
  ].join(';') + tail

if (process.argv.includes('--show-script')) {
  console.error('--- script ---')
  console.error(script)
  console.error('--- end ---')
}

process.stdout.write(encode(script))
