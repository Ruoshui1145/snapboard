import path from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'

// The packaged app supplies Electron safeStorage. The Windows source runtime uses the same user-bound DPAPI protection.
function dpapi(mode, value) {
  const script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $item=[Console]::In.ReadToEnd() | ConvertFrom-Json; if($item.mode -eq 'protect'){$bytes=[Text.Encoding]::UTF8.GetBytes($item.value); [Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))}else{$bytes=[Convert]::FromBase64String($item.value); [Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))}"
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''; const timeout = setTimeout(() => child.kill(), 8000)
    child.stdout.on('data', bytes => { output += bytes.toString('utf8'); if (output.length > 8192) child.kill() })
    child.stderr.resume() // Never expose decrypted material or PowerShell diagnostic inputs to logs.
    child.on('error', () => { clearTimeout(timeout); reject(new Error('Windows 授权密钥保护不可用')) })
    child.on('close', code => { clearTimeout(timeout); if (code === 0 && output.length <= 8192) resolve(output.trim()); else reject(new Error('Windows 授权密钥保护不可用')) })
    child.stdin.end(JSON.stringify({ mode, value }))
  })
}
export async function windowsLicenseStorageKey(directory) {
  if (process.platform !== 'win32') throw new Error('授权存储需要操作系统保护的密钥')
  const filename = path.join(directory, 'source-vault-key.dpapi')
  let encrypted
  try { encrypted = await readFile(filename, 'utf8') } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('授权密钥文件无法读取')
    encrypted = await dpapi('protect', randomBytes(32).toString('base64'))
    try { await writeFile(filename, encrypted, { mode: 0o600, flag: 'wx' }) } catch (writeError) {
      if (writeError.code !== 'EEXIST') throw new Error('授权密钥文件无法保存')
      encrypted = await readFile(filename, 'utf8')
    }
  }
  const key = Buffer.from(await dpapi('unprotect', encrypted), 'base64')
  if (key.length !== 32) throw new Error('操作系统保护的授权密钥无效')
  return key
}
