#!/usr/bin/env node
// Force LF line endings on the CLI entry script so the `#!/usr/bin/env node`
// shebang works on Linux/macOS/WSL. A CRLF shebang becomes
// `#!/usr/bin/env node\r`, and the kernel fails with
// "env: 'node\r': No such file or directory".
//
// This runs as a `postinstall` hook so the installed executable is always LF
// regardless of how the package was checked out or packed (git autocrlf, npm
// tarball produced on Windows, etc.).
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const bin = join(root, 'bin', 'run.js')

function main() {
  let raw
  try {
    raw = readFileSync(bin, 'utf8')
  } catch {
    // bin/run.js is a static file shipped in the package; if it is somehow
    // missing, do not fail the install.
    return
  }

  const lf = raw.replaceAll('\r\n', '\n')
  if (lf !== raw) {
    writeFileSync(bin, lf, 'utf8')
    console.log('fix-bin-eol: normalized bin/run.js to LF')
  }
}

main()