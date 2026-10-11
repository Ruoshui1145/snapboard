import assert from 'node:assert/strict'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { createServer } from 'vite'

const vite = await createServer({ appType: 'custom', logLevel: 'error', server: { middlewareMode: true, hmr: false } })
try {
  const { useFileDrop } = await vite.ssrLoadModule('/src/hooks/useFileDrop.ts')
  const received = []
  let binding
  const mount = disabled => renderToString(React.createElement(function Probe() {
    binding = useFileDrop(files => received.push(files), disabled)
    return React.createElement('div', binding.dropProps)
  }))
  const a = new File(['a'], 'a.svg', { type: 'image/svg+xml' })
  const b = new File(['b'], 'b.png', { type: 'image/png' })
  const event = (types, files = [], data = {}) => {
    const e = { dataTransfer: { types, files, dropEffect: 'none', getData: type => data[type] || '' },
      currentTarget: { contains: () => false }, relatedTarget: null,
      prevented: 0, stopped: 0,
      preventDefault() { this.prevented++ }, stopPropagation() { this.stopped++ } }
    return e
  }
  assert.match(mount(false), /data-file-drop="ready"/)
  const drag = event(['Files'])
  binding.dropProps.onDragOver(drag)
  assert.equal(drag.dataTransfer.dropEffect, 'copy')
  assert.equal(drag.prevented, 1)
  const drop = event(['Files'], [a, b])
  binding.dropProps.onDrop(drop)
  assert.deepEqual(received[0], [a, b], 'drop must preserve file order and forward the original files to the importer')
  assert.equal(drop.stopped, 1, 'one file drop must not import twice through ancestor handlers')
  const part = event(['application/x-snapboard-part'])
  binding.dropProps.onDragOver(part)
  binding.dropProps.onDrop(part)
  assert.equal(part.prevented, 0)
  assert.equal(part.stopped, 0, 'internal part dragging must remain available to the viewport')
  for (const type of ['application/snapboard-part', 'application/snapboard-reorder']) {
    const internal = event([type, 'text/plain', 'text/html'])
    binding.dropProps.onDragOver(internal); binding.dropProps.onDrop(internal)
    assert.equal(internal.prevented, 0, 'internal drags with browser text fallback must not become file imports')
  }
  assert.equal(received.length, 1)
  binding.dropProps.onDrop(event(['Files']))
  assert.equal(received.length, 1, 'empty drops must not clear existing images')
  assert.match(mount(true), /data-file-drop="disabled"/)
  const busy = event(['Files'], [a])
  binding.dropProps.onDragOver(busy)
  binding.dropProps.onDrop(busy)
  assert.equal(busy.dataTransfer.dropEffect, 'none')
  assert.equal(received.length, 1, 'busy importers must not receive a concurrent upload')
  assert.equal(busy.prevented, 2, 'disabled file drops must not navigate the browser away')
  const { captureFileDrop, resolveFileDrop } = await vite.ssrLoadModule('/src/utils/fileDrop.ts')
  assert.deepEqual(captureFileDrop(event(['Files'], [a, b]).dataTransfer).files, [a, b])
  const captured = captureFileDrop(event(['text/uri-list'], [], { 'text/uri-list': '# original image\r\nhttps://images.example/picture?id=12\r\n' }).dataTransfer)
  assert.equal(captured.url, 'https://images.example/picture?id=12')
  const webImage = await resolveFileDrop({ files: [], url: 'data:image/png;base64,aGVsbG8=' })
  assert.equal(webImage[0].name, '网页图片.png')
  assert.equal(webImage[0].type, 'image/png')
  await assert.rejects(resolveFileDrop({ files: [], url: 'javascript:alert(1)' }), /图片或文件链接/)
  const originalFetch = globalThis.fetch
  try {
    const fetched = []
    globalThis.fetch = async (url, init) => {
      fetched.push({ url, init })
      if (url.startsWith('https://')) throw new TypeError('CORS blocked')
      return new Response('image', { headers: { 'Content-Type': 'image/png' } })
    }
    const image = await resolveFileDrop(captured)
    assert.equal(image[0].name, 'picture.png', 'extensionless image URLs get the actual MIME extension')
    assert.equal(fetched[1].url, '/api/import-image-url')
    assert.equal(JSON.parse(fetched[1].init.body).url, captured.url)
    assert.equal(fetched[0].init.credentials, 'omit', 'external requests do not forward browser credentials')
    globalThis.fetch = async () => new Response('<html>page</html>', { headers: { 'Content-Type': 'text/html' } })
    await assert.rejects(resolveFileDrop(captured), /网页/)
    globalThis.fetch = async () => new Response('large', { headers: { 'Content-Type': 'image/png', 'Content-Length': '200' } })
    await assert.rejects(resolveFileDrop(captured, { maxBytes: 100 }), /大小限制/)
    globalThis.fetch = async () => new Response('0123456789', { headers: { 'Content-Type': 'image/png' } })
    await assert.rejects(resolveFileDrop(captured, { maxBytes: 5 }), /大小限制/, 'streamed bodies must also respect the size limit')
    await assert.rejects(resolveFileDrop(captured, { accept: '.dxf' }), /格式不适用/)
    const { MAX_TEXTURE_ASSET_BYTES, MAX_TEXTURE_SVG_ASSET_BYTES } = await vite.ssrLoadModule('/src/utils/textureComposition.ts')
    const textureLimits = { maxBytes: mime => mime === 'image/svg+xml' ? MAX_TEXTURE_SVG_ASSET_BYTES : MAX_TEXTURE_ASSET_BYTES }
    for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
      globalThis.fetch = async () => new Response('image', { headers: { 'Content-Type': type, 'Content-Length': String(MAX_TEXTURE_ASSET_BYTES + 1) } })
      await assert.rejects(resolveFileDrop(captured, textureLimits), /大小限制/)
    }
    globalThis.fetch = async () => new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml', 'Content-Length': String(100 * 1024 * 1024) } })
    assert.equal((await resolveFileDrop(captured, textureLimits))[0].type, 'image/svg+xml', 'large SVG headers must use the independent SVG budget')
    globalThis.fetch = async () => new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml', 'Content-Length': String(MAX_TEXTURE_SVG_ASSET_BYTES + 1) } })
    await assert.rejects(resolveFileDrop(captured, textureLimits), /大小限制/)
    globalThis.fetch = async () => new Response('0123456789', { headers: { 'Content-Type': 'image/svg+xml' } })
    await assert.rejects(resolveFileDrop(captured, { maxBytes: mime => mime === 'image/svg+xml' ? 5 : 100 }), /大小限制/, 'MIME-specific limits must also bound chunked responses')
    const errors = []
    let finish
    globalThis.fetch = () => new Promise(resolve => { finish = resolve })
    renderToString(React.createElement(function Probe() {
      binding = useFileDrop(files => received.push(files), false, { onError: error => errors.push(error) })
      return React.createElement('div', binding.dropProps)
    }))
    const urlDrop = event(['text/uri-list'], [], { 'text/uri-list': captured.url })
    binding.dropProps.onDrop(urlDrop)
    binding.dropProps.onDrop(urlDrop)
    finish(new Response('png', { headers: { 'Content-Type': 'image/png' } }))
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(received.length, 2, 'a pending URL drop must not be imported twice')
    assert.equal(errors.length, 0)
  } finally { globalThis.fetch = originalFetch }
  console.log('File drop passed: local/files/URI/data images, CORS fallback, size/type errors, one import, busy state and real internal part/reorder drags')
} finally { await vite.close() }
