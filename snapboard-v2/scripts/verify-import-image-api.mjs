import assert from 'node:assert/strict'
import dns from 'node:dns'
import http from 'node:http'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { mock } from 'node:test'
import { importImageApi, downloadWebImage, isPublicImageAddress } from './import-image-api.mjs'

for (const address of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.31.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::ffff:127.0.0.1', 'fe80::1', 'fc00::1']) assert.equal(isPublicImageAddress(address), false, address)
assert.equal(isPublicImageAddress('8.8.8.8'), true)
assert.equal(isPublicImageAddress('2606:4700::1111'), true)
await assert.rejects(downloadWebImage('http://127.0.0.1/test.png'), /公开网页/)
await assert.rejects(downloadWebImage('file:///c:/test.png'), /公开网页/)

let responses = [], connections = [], lookups = []
mock.method(dns.promises, 'lookup', async hostname => {
  lookups.push(hostname)
  return [{ address: hostname === 'private.example' ? '127.0.0.1' : '8.8.8.8', family: 4 }]
})
mock.method(http, 'request', (url, options, callback) => {
  connections.push(url.href)
  // Exercise the exact custom DNS resolver used by the real HTTP connection.
  options.lookup(url.hostname, { all: true }, (error, addresses) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]) })
  const descriptor = responses.shift()
  const response = Readable.from(descriptor.body ?? [Buffer.from('png')])
  response.statusCode = descriptor.status ?? 200
  response.headers = descriptor.headers ?? { 'content-type': 'image/png' }
  const request = new EventEmitter()
  request.end = () => queueMicrotask(() => callback(response))
  return request
})
syncBuiltinESMExports()
try {
  responses = [{}]
  const image = await downloadWebImage('http://images.example/image')
  assert.equal(image.type, 'image/png'); assert.equal(image.buffer.toString(), 'png')
  responses = [{ headers: { 'content-type': 'text/html' } }]
  await assert.rejects(downloadWebImage('http://images.example/page.png'), /原图/)
  const imageLimit = 16 * 1024 * 1024, svgLimit = 128 * 1024 * 1024
  for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
    responses = [{ headers: { 'content-type': type, 'content-length': imageLimit }, body: [Buffer.alloc(imageLimit)] }]
    assert.equal((await downloadWebImage('http://images.example/boundary')).buffer.length, imageLimit)
    responses = [{ headers: { 'content-type': type, 'content-length': imageLimit + 1 } }]
    await assert.rejects(downloadWebImage('http://images.example/too-large'), /16 MB/)
    responses = [{ headers: { 'content-type': type }, body: [Buffer.alloc(imageLimit), Buffer.alloc(1)] }]
    await assert.rejects(downloadWebImage('http://images.example/stream'), /16 MB/)
  }
  responses = [{ headers: { 'content-type': 'image/svg+xml', 'content-length': svgLimit }, body: [Buffer.alloc(svgLimit)] }]
  assert.equal((await downloadWebImage('http://images.example/art.svg')).buffer.length, svgLimit)
  responses = [{ headers: { 'content-type': 'image/svg+xml', 'content-length': svgLimit + 1 } }]
  await assert.rejects(downloadWebImage('http://images.example/too-large.svg'), /128 MB/)
  responses = [{ headers: { 'content-type': 'image/svg+xml' }, body: [Buffer.alloc(svgLimit), Buffer.alloc(1)] }]
  await assert.rejects(downloadWebImage('http://images.example/stream.svg'), /128 MB/)
  responses = [{ status: 302, headers: { location: 'http://private.example/secret.png' } }]
  const connectionCount = connections.length
  await assert.rejects(downloadWebImage('http://images.example/redirect'), /公开网页/)
  assert.equal(connections.length, connectionCount + 1, 'private redirect must be rejected before making a connection')
  assert.ok(lookups.includes('private.example'), 'each redirected target must be validated')
  responses = [{ status: 302, headers: { location: 'http://images.example/final' } }, {}]
  assert.equal((await downloadWebImage('http://images.example/start')).buffer.toString(), 'png')
  let handler
  importImageApi().configureServer({ middlewares: { use: (route, callback) => { assert.equal(route, '/api/import-image-url'); handler = callback } } })
  const call = async headers => {
    const req = Readable.from([JSON.stringify({ url: 'http://images.example/image' })])
    Object.assign(req, { method: 'POST', headers })
    const res = { statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value }, end(body) { this.body = body } }
    await handler(req, res); return res
  }
  responses = [{}]
  const result = await call({ host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173', 'sec-fetch-site': 'same-origin' })
  assert.equal(result.statusCode, 200); assert.equal(result.headers['Content-Type'], 'image/png')
  const blocked = await call({ host: '127.0.0.1:5173', origin: 'https://other.example', 'sec-fetch-site': 'cross-site' })
  assert.equal(blocked.statusCode, 400)
  console.log('Web image API passed: raw image, separate raster/SVG byte limits, DNS pinning, public redirects, private targets, HTML limits and same-origin requests')
} finally { mock.restoreAll(); syncBuiltinESMExports() }
