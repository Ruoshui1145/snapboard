import path from 'node:path'
import { lstat, realpath } from 'node:fs/promises'
// Lexical checks alone do not stop a stored file from being a symlink outside its library.
export async function managedPath(base, target, allowMissing = false) {
  const root = await realpath(base), absolute = path.resolve(target)
  if (!absolute.startsWith(path.resolve(base) + path.sep)) throw new Error('受控文件路径越界')
  try {
    const info = await lstat(absolute)
    if (info.isSymbolicLink()) throw new Error('受控文件不能是符号链接')
    const resolved = await realpath(absolute)
    if (!resolved.startsWith(root + path.sep)) throw new Error('受控文件实际路径越界')
    return resolved
  } catch (error) {
    if (!allowMissing || error.code !== 'ENOENT') throw error
    const parent = await realpath(path.dirname(absolute))
    if (parent !== root && !parent.startsWith(root + path.sep)) throw new Error('受控目录实际路径越界')
    return absolute
  }
}
