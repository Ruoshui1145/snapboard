import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

const MAX_IMAGE_BYTES = 16 * 1024 * 1024
const MAX_SVG_BYTES = 128 * 1024 * 1024
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'])

export function isPublicImageAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254
      || a === 172 && b >= 16 && b <= 31 || a === 192 && [0, 168].includes(b)
      || a === 100 && b >= 64 && b <= 127 || a === 198 && [18, 19].includes(b))
  }
  // Only global IPv6 unicast; mapped IPv4 and link-local addresses cannot bypass this check.
  return isIP(address) === 6 && /^[23]/.test(address) && !address.toLowerCase().startsWith('2001:db8:')
}

export async function downloadWebImage(source, redirects = 0, signal = AbortSignal.timeout(15_000)) {
  const url = new URL(source)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.port && !['80', '443'].includes(url.port)) throw new Error('仅支持公开网页的图片地址')
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true })
  if (!addresses.length || addresses.some(item => !isPublicImageAddress(item.address))) throw new Error('请拖入公开网页图片；本地文件请直接拖入文件')
  // Pin the checked DNS result for the connection, including each redirected target.
  const target = addresses[0]
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      signal, headers: { Accept: 'image/png,image/jpeg,image/webp,image/svg+xml', 'Accept-Encoding': 'identity' },
      lookup: (_hostname, options, callback) => options.all ? callback(null, [target]) : callback(null, target.address, target.family),
    }, response => {
      const status = response.statusCode ?? 500
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.resume()
        if (redirects >= 3 || !response.headers.location) { reject(new Error('图片跳转次数过多')); return }
        Promise.resolve().then(() => downloadWebImage(new URL(response.headers.location, url).href, redirects + 1, signal)).then(resolve, reject)
        return
      }
      const type = String(response.headers['content-type'] || '').split(';')[0].toLowerCase()
      if (status !== 200 || !imageTypes.has(type)) {
        response.resume(); reject(new Error('该网站没有提供可读取的 PNG/JPG/WebP/SVG 原图，请保存原图后拖入')); return
      }
      const vector = type === 'image/svg+xml'
      const maxBytes = vector ? MAX_SVG_BYTES : MAX_IMAGE_BYTES
      const sizeError = vector ? 'SVG 文件不能超过 128 MB' : '图片不能超过 16 MB'
      if (Number(response.headers['content-length']) > maxBytes) {
        response.destroy(); reject(new Error(sizeError)); return
      }
      const chunks = []
      let size = 0
      response.on('data', chunk => {
        size += chunk.length
        if (size > maxBytes) { response.destroy(); reject(new Error(sizeError)) }
        else chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => size ? resolve({ type, buffer: Buffer.concat(chunks) }) : reject(new Error('网页图片为空')))
    })
    request.on('error', reject)
    request.end()
  })
}

export const importImageApi = () => ({
  name: 'snapboard-import-image-api',
  configureServer(server) {
    server.middlewares.use('/api/import-image-url', async (req, res) => {
      try {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }
        if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(req.headers.host || '') || req.headers['sec-fetch-site'] === 'cross-site'
          || req.headers.origin && req.headers.origin !== 'http://' + req.headers.host) throw new Error('请从当前工作台导入图片')
        let raw = ''
        for await (const chunk of req) {
          raw += chunk
          if (raw.length > 8192) throw new Error('图片地址过长')
        }
        const { url } = JSON.parse(raw)
        if (typeof url !== 'string') throw new Error('没有图片地址')
        const image = await downloadWebImage(url)
        res.setHeader('Content-Type', image.type)
        res.setHeader('Content-Length', image.buffer.length)
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('X-Content-Type-Options', 'nosniff')
        res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
        res.end(image.buffer)
      } catch (error) {
        res.statusCode = 400
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: error.name === 'AbortError' ? '读取网页图片超时，请保存原图后拖入' : error.message }))
      }
    })
  },
})
