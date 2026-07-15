import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'

const root = process.cwd()
const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  cwd: root,
  encoding: 'utf8'
})
if (listed.status !== 0) throw new Error(listed.stderr)

const files = listed.stdout.trim().split(/\r?\n/).filter(Boolean)
const forbiddenPaths = ['tests/screenshots/', 'playwright-report/', 'test-results/']
const requiredPublicFiles = [
  'docs/screenshots/session-workspace.png',
  'docs/screenshots/project-history.png'
]
const approvedScreenshotHashes = {
  'docs/screenshots/project-history.png': '9ff8c3b3da72e1192b8040ab2e1114c943f79dd56761338d90016e011756a942',
  'docs/screenshots/session-workspace.png': '16fa891a307c5b8ca502fdebd41c5d6208dbdff6b4816812d4975b015de932ba'
}
const forbiddenContent = [
  /Jommbles/i,
  /Kartorium/i,
  /AIza[0-9A-Za-z_-]{20,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/
]

for (const [screenshot, approvedHash] of Object.entries(approvedScreenshotHashes)) {
  const hash = createHash('sha256').update(await readFile(path.join(root, screenshot))).digest('hex')
  if (hash !== approvedHash) throw new Error('Public screenshot requires privacy and accuracy review: ' + screenshot)
}

for (const file of files) {
  if (file.replaceAll('\\', '/') === 'scripts/validate-public-release.mjs') continue
  const normalized = file.replaceAll('\\', '/')
  if (forbiddenPaths.some((prefix) => normalized.startsWith(prefix))) {
    throw new Error(`Private test artifact is included in the public release: ${file}`)
  }
  if (/\.(png|ico|jpg|jpeg|webp|lock)$/i.test(file)) continue
  const contents = await readFile(path.join(root, file), 'utf8')
  for (const pattern of forbiddenContent) {
    if (pattern.test(contents)) throw new Error(`Public-release check failed for ${file}: ${pattern}`)
  }
}

for (const requiredFile of requiredPublicFiles) {
  if (!files.includes(requiredFile)) throw new Error(`Public release is missing ${requiredFile}`)
}

const readme = await readFile(path.join(root, 'README.md'), 'utf8')
for (const screenshot of requiredPublicFiles) {
  if (!readme.includes(screenshot)) throw new Error(`README.md must display ${screenshot}`)
}

console.log(`Validated ${files.length} public release files.`)
