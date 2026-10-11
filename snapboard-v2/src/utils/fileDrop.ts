export interface FileDropOptions {
  accept?: string
  maxBytes?: number | ((mime: string) => number)
  onError?: (message: string) => void
}

export interface CapturedFileDrop { files: File[]; url?: string }

const imageExtensions: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/svg+xml': '.svg',
}

export function isImportDrag(transfer: DataTransfer): boolean {
  const types = Array.from(transfer.types)
  // Library reordering and placing parts are handled by their own drop targets.
  if (types.some(type => /^application\/(x-)?snapboard/.test(type))) return false
  return types.some(type => ['Files', 'text/html', 'text/uri-list', 'text/plain'].includes(type))
}

/** Drag data is protected again after the event returns; capture before awaiting. */
export function captureFileDrop(transfer: DataTransfer): CapturedFileDrop {
  const files = Array.from(transfer.files)
  if (!files.length) for (const item of Array.from(transfer.items ?? [])) {
    if (item.kind === 'file') { const file = item.getAsFile(); if (file) files.push(file) }
  }
  if (files.length) return { files }
  const html = transfer.getData('text/html')
  const uris = transfer.getData('text/uri-list').split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#'))
  const fallback = uris[0]?.trim() || transfer.getData('text/plain').trim()
  if (html) {
    const document = new DOMParser().parseFromString(html, 'text/html')
    const image = document.querySelector('img')
    // Linked pictures import the image itself, rather than the surrounding page.
    const source = image?.getAttribute('src') || document.querySelector('a')?.getAttribute('href')
    if (source) {
      try { return { files, url: new URL(source, document.querySelector('base')?.getAttribute('href') || fallback || location.href).href } }
      catch { /* A valid URI payload may still be present. */ }
    }
  }
  return { files, url: fallback || undefined }
}

function accepts(file: File, accept = 'image/*'): boolean {
  return accept.split(',').some(value => {
    const rule = value.trim().toLowerCase()
    return rule.startsWith('.') ? file.name.toLowerCase().endsWith(rule)
      : rule.endsWith('/*') ? file.type.startsWith(rule.slice(0, -1)) : file.type === rule
  })
}

async function limitedBlob(response: Response, maxBytes: number): Promise<Blob> {
  if (!response.ok) throw new Error(`文件读取失败（${response.status}）`)
  if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('拖入的文件超过此入口的大小限制')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('未读取到文件内容')
  const chunks: BlobPart[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) throw new Error('拖入的文件超过此入口的大小限制')
      chunks.push(new Uint8Array(value))
    }
  } catch (error) { await reader.cancel(); throw error }
  if (!size) throw new Error('拖入的文件为空')
  return new Blob(chunks, { type: response.headers.get('content-type')?.split(';')[0] || '' })
}

export async function resolveFileDrop(drop: CapturedFileDrop, options: FileDropOptions = {}): Promise<File[]> {
  if (drop.files.length) return drop.files
  if (!drop.url) return []
  let url: URL
  try { url = new URL(drop.url) } catch { throw new Error('请拖入图片或文件，而不是普通文字') }
  if (!['https:', 'http:', 'data:', 'blob:'].includes(url.protocol) || url.username || url.password) throw new Error('请拖入图片或文件链接')
  let response: Response
  try {
    response = await fetch(url.href, { credentials: 'omit', signal: AbortSignal.timeout(15_000) })
  } catch {
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('无法读取这张网页图片，请将原图保存后拖入')
    // Local service handles image sites that do not permit browser CORS requests.
    response = await fetch('/api/import-image-url', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url.href }), signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) {
      const result = await response.json().catch(() => null) as { error?: string } | null
      throw new Error(result?.error || '此页面不提供可读取的原图，请保存图片后拖入')
    }
  }
  const mime = (response.headers.get('content-type')?.split(';')[0] || '').trim().toLowerCase()
  const maxBytes = typeof options.maxBytes === 'function' ? options.maxBytes(mime) : options.maxBytes ?? 20 * 1024 * 1024
  const blob = await limitedBlob(response, maxBytes)
  // Never treat a linked HTML page as an SVG/image even when its URL ends in .png.
  if (blob.type === 'text/html') throw new Error('拖入的是网页，请拖动网页中的图片或直接文件链接')
  const extension = imageExtensions[blob.type]
  let name = '网页图片'
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    try { name = decodeURIComponent(url.pathname.split('/').pop() || name) } catch { /* Keep the default name. */ }
  }
  if (extension && !Object.values(imageExtensions).some(ext => name.toLowerCase().endsWith(ext))) name += extension
  const file = new File([blob], name, { type: blob.type })
  if (!accepts(file, options.accept)) throw new Error('拖入的内容格式不适用于此导入框')
  return [file]
}
