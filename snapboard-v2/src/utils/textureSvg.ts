/** Validate SVG as a self-contained image, without mounting it in the document. */
export function prepareTextureSvg(text: string): { dataUrl: string; width: number; height: number } {
  if (/<!ENTITY\b/i.test(text)) throw new Error('SVG 包含不支持的实体声明，请导出为自包含 SVG')
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
  if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'svg') {
    throw new Error('SVG 格式不完整或 XML 无法解析，请重新导出 SVG')
  }
  const root = doc.documentElement
  const forbidden = new Set(['script', 'foreignobject', 'iframe', 'object', 'embed', 'link', 'animate', 'animatetransform', 'animatemotion', 'set'])
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    if (forbidden.has(el.localName.toLowerCase())) throw new Error(`SVG 含不支持的动态元素：${el.localName}`)
    for (const attr of Array.from(el.attributes)) {
      const name = attr.localName.toLowerCase(), value = attr.value.trim()
      if (name.startsWith('on') || name === 'base') throw new Error('SVG 含事件或外部基址，无法作为静态图片导入')
      if (name === 'href' && value && !value.startsWith('#')
          && !(el.localName === 'image' && /^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=\s]+$/i.test(value))) {
        throw new Error('SVG 引用了外部文件，请在导出时嵌入图片并转曲字体')
      }
      checkCss(value)
    }
    if (el.localName === 'style') checkCss(el.textContent ?? '')
  }
  const viewBox = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
  const hasViewBox = viewBox.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0
  const length = (raw: string | null): number => {
    const match = /^\s*([\d.]+)\s*(px|mm|cm|in|pt|pc)?\s*$/i.exec(raw ?? '')
    if (!match) return NaN
    const factors: Record<string, number> = { px: 1, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, pt: 96 / 72, pc: 16 }
    return Number(match[1]) * factors[(match[2] ?? 'px').toLowerCase()]
  }
  const width = length(root.getAttribute('width')) || (hasViewBox ? viewBox[2] : NaN)
  const height = length(root.getAttribute('height')) || (hasViewBox ? viewBox[3] : NaN)
  if (![width, height].every(n => Number.isFinite(n) && n > 0)) throw new Error('SVG 缺少有效的宽高或 viewBox')
  if (width / height > 100 || height / width > 100) throw new Error('SVG 宽高比例超过 100:1，请裁掉空白后导入')
  // ViewBox-only / percentage-sized exports otherwise decode as a browser-dependent 300×150 image.
  if (!hasViewBox) root.setAttribute('viewBox', `0 0 ${width} ${height}`)
  const scale = Math.min(1, 4096 / Math.max(width, height))
  root.setAttribute('width', String(Math.max(1, Math.round(width * scale))))
  root.setAttribute('height', String(Math.max(1, Math.round(height * scale))))
  root.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  const bytes = new TextEncoder().encode(new XMLSerializer().serializeToString(root))
  const chunks: string[] = []
  for (let i = 0; i < bytes.length; i += 8192) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)))
  return { dataUrl: `data:image/svg+xml;base64,${btoa(chunks.join(''))}`, width, height }
}

function checkCss(value: string): void {
  if (/@import|expression\s*\(|javascript:|\\/i.test(value)) throw new Error('SVG 包含不支持的样式引用')
  for (const match of value.matchAll(/url\s*\(([^)]*)\)/gi)) {
    if (!/^['"]?#[\w:.-]+['"]?$/.test(match[1].trim())) throw new Error('SVG 样式引用了外部资源，请导出自包含 SVG')
  }
}
