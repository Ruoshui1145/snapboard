import { spawnSync } from 'node:child_process'

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npmExecPath = process.env.npm_execpath
const command = npmExecPath ? process.execPath : npm
const args = npmExecPath ? [npmExecPath, 'run', 'build'] : ['run', 'build']
const result = spawnSync(command, args, {
  cwd: process.cwd(),
  env: {...process.env, VITE_DESIGNER_ONLY: '1'},
  stdio: 'inherit',
})

if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
