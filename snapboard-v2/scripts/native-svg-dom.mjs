import { createRequire } from 'node:module'

/** Local desktop process adapter for SVGLoader's small DOM surface. */
export function installNativeSvgDom() {
  const requireDesktop = createRequire(new URL('../../desktop/server.cjs', import.meta.url))
  const { DOMParser, XMLSerializer } = requireDesktop('@xmldom/xmldom')
  const probe = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>', 'image/svg+xml')
  const documentPrototype = Object.getPrototypeOf(probe)
  const elementPrototype = Object.getPrototypeOf(probe.documentElement)
  const select = function (selector) {
    return selector.split(',').flatMap(name => Array.from(this.getElementsByTagName(name.trim())))
  }
  documentPrototype.querySelectorAll = select
  documentPrototype.querySelector = function (selector) { return select.call(this, selector)[0] ?? null }
  elementPrototype.querySelectorAll = select
  elementPrototype.querySelector = function (selector) { return select.call(this, selector)[0] ?? null }
  elementPrototype.remove = function () { this.parentNode?.removeChild(this) }
  elementPrototype.replaceWith = function (node) { this.parentNode?.replaceChild(node, this) }
  if (!Object.getOwnPropertyDescriptor(elementPrototype, 'children')) Object.defineProperty(elementPrototype, 'children', {
    get() { return Array.from(this.childNodes).filter(node => node.nodeType === 1) },
  })
  if (!Object.getOwnPropertyDescriptor(elementPrototype, 'style')) Object.defineProperty(elementPrototype, 'style', {
    // SVGLoader reads inline CSS through node.style, which xmldom does not expose.
    // Return the browser's empty-string default for missing declarations.
    get() {
      const fields = Object.create(null)
      for (const declaration of (this.getAttribute('style') ?? '').split(';')) {
        const colon = declaration.indexOf(':')
        if (colon > 0) fields[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim().replace(/\s*!important$/, '')
      }
      return new Proxy(fields, { get: (target, key) => target[key] ?? '' })
    },
  })
  globalThis.DOMParser = DOMParser
  globalThis.XMLSerializer = XMLSerializer
}
