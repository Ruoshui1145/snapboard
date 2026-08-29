import { copyFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const run = (args, env = process.env) => {
  // Reuse npm's JS entry point when invoked from an npm script. This avoids
  // shell quoting differences on Windows while remaining portable in CI.
  const npmExecPath = env.npm_execpath
  const command = npmExecPath ? process.execPath : npm
  const commandArgs = npmExecPath ? [npmExecPath, ...args] : args
  const result = spawnSync(command, commandArgs, { cwd: root, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${npm} ${args.join(' ')} failed with exit code ${result.status}`)
}

const studioDist = path.join(root, 'snapboard-v2', 'dist')
// The React site is the single public entry point. `apps/wiki` remains the
// Markdown authoring source for contributors, but is not a second user-facing
// server. GitHub Pages passes BASE_URL (for example /snapboard/) so client-side
// routes keep working when the repository is hosted below a project prefix.
const siteBase = process.env.VITE_BASE ?? process.env.BASE_URL ?? '/'
const publicSiteOnly = process.argv.includes('--public-only') || process.env.PUBLIC_SITE_ONLY === '1'

run(['--workspace', 'snapboard-v2', 'run', 'build'], {
  ...process.env,
  VITE_BASE: siteBase,
  ...(publicSiteOnly ? { VITE_PUBLIC_SITE_ONLY: '1' } : {}),
})
// GitHub Pages serves 404.html for deep links. Reusing the SPA shell lets
// /guide, /project and /design resolve through the same client router.
copyFileSync(path.join(studioDist, 'index.html'), path.join(studioDist, '404.html'))
console.log(`Public site built: ${siteBase} (${publicSiteOnly ? '官网模式：不含设计器' : '官网 + 社区 + 指南 + 项目资料 + 设计器'})`)
