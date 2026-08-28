import { cpSync, mkdirSync, rmSync } from 'node:fs'
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
const wikiStatic = path.join(root, 'apps', 'wiki', 'static', 'design')

run(['--workspace', 'snapboard-v2', 'run', 'build'], { ...process.env, VITE_BASE: '/design/' })
rmSync(wikiStatic, { recursive: true, force: true })
mkdirSync(wikiStatic, { recursive: true })
cpSync(studioDist, wikiStatic, { recursive: true })

run(['--workspace', 'apps-wiki', 'run', 'build'])
console.log('Public site built: Wiki / + docs + devlog, Studio /design/')
