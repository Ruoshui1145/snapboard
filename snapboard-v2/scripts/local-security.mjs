// All dev APIs pass this gate before individual plugins can read or write files.
export const privateFileGlobs = ['**/.env', '**/.env.*', '**/*.{pem,key,crt}', '**/.git/**', '**/.aws/**',
  '**/.tccli/**', '**/.codex/**', '**/.codex-tmp/**', '**/.merchant-license/**', '**/workspace-data/**',
  '**/订单数据/**', '**/已保存项目/**', '**/output/**', '**/docs-internal/**']
const privateSegments = new Set(['.git', '.aws', '.tccli', '.codex', '.codex-tmp', '.merchant-license',
  'workspace-data', '订单数据', '已保存项目', 'output', 'docs-internal'])

export function localRequestProblem(request) {
  const host = request.headers.host
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host || '')) return { status: 403, error: '只接受本机工作台访问' }
  const origin = (request.socket?.encrypted ? 'https://' : 'http://') + host
  let url
  try { url = new URL(request.url || '/', origin) } catch { return { status: 400, error: '请求地址无效' } }
  if (url.origin !== origin || url.username || url.password) return { status: 403, error: '请求来源无效' }
  if (request.headers.origin && request.headers.origin !== origin) return { status: 403, error: '只接受当前工作台同源请求' }
  const navigation = request.method === 'GET' && request.headers['sec-fetch-mode'] === 'navigate'
    && ['/', '/design', '/order-console', '/index.html'].includes(url.pathname)
  if (!navigation && request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site']))
    return { status: 403, error: '外部网页不能操作本机工作台' }
  try {
    const segments = decodeURIComponent(url.pathname).replaceAll('\\', '/').toLowerCase().split('/')
    if (segments.some(segment => privateSegments.has(segment) || /^\.env(?:\.|$)/.test(segment) || /\.(pem|key|crt)$/.test(segment)))
      return { status: 403, error: '私有数据只能通过指定接口访问' }
  } catch { return { status: 400, error: '请求地址编码无效' } }
  return null
}

export const localSecurityPlugin = () => ({
  name: 'snapboard-local-security', enforce: 'pre', apply: 'serve',
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const problem = localRequestProblem(request)
      if (!problem) { next(); return }
      response.writeHead(problem.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      response.end(JSON.stringify({ error: problem.error }))
    })
  },
})
