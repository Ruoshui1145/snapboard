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
// This builds the public website portion. `apps/wiki` remains the Markdown
// authoring source for contributors, while the designer can be built and
// deployed separately from the snapboard-v2 subdirectory. GitHub Pages passes
// BASE_URL (for example /snapboard/) so client-side routes keep working below a
// project prefix.
const siteBase = process.env.VITE_BASE ?? process.env.BASE_URL ?? '/'
const publicSiteOnly = process.argv.includes('--public-only') || process.env.PUBLIC_SITE_ONLY === '1'

run(['--workspace', 'snapboard-v2', 'run', publicSiteOnly ? 'build:public' : 'build'], {
  ...process.env,
  VITE_BASE: siteBase,
  ...(publicSiteOnly ? { VITE_PUBLIC_SITE_ONLY: '1' } : {}),
})
// GitHub Pages serves 404.html for deep links. Reusing the SPA shell lets
// /guide and /project resolve through the same client router; /design is only
// a fallback for local unified development and normally points to the separate
// VITE_DESIGNER_URL in production.
copyFileSync(path.join(studioDist, 'index.html'), path.join(studioDist, '404.html'))
console.log(`Public site built: ${siteBase} (${publicSiteOnly ? '官网模式：不含设计器' : '官网 + 社区 + 指南 + 项目资料 + 设计器'})`)
