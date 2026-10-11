export async function readJson(request) {
  let size = 0; const chunks = []
  for await (const chunk of request) { size += chunk.length; if (size > 64 * 1024) throw new Error('授权请求过大'); chunks.push(chunk) }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
export function json(response, value, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  response.end(JSON.stringify(value))
}
