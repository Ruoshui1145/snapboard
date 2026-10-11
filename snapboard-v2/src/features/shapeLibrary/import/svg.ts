import { cleanRing, distanceSquared } from './geometry'
import type { ImportPoint, ShapeImportIssue, ShapeImportResult, SvgImportOptions } from './types'
import { draftFromClosedLoops, normalizeAndValidateShape } from './validation'

type Matrix = [number, number, number, number, number, number]

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]
const NUMBER_PATTERN = '[-+]?(?:\\d*\\.\\d+|\\d+\\.?)(?:[eE][-+]?\\d+)?'
const PATH_TOKEN = new RegExp(`[a-zA-Z]|${NUMBER_PATTERN}`, 'g')
const DANGEROUS_ELEMENT = /<(?:\s*\/\s*)?(?:script|foreignObject|use|image|iframe|object|embed|link|style|base)\b/i
const SAFE_ELEMENTS = new Set(['svg', 'g', 'path', 'polygon', 'polyline', 'rect', 'circle', 'ellipse'])
const IGNORED_ELEMENTS = new Set(['title', 'desc', 'metadata'])

interface SvgFrame {
  name: string
  matrix: Matrix
  ignored: boolean
}

interface TessellationContext {
  tolerance: number
  remaining: number
}

const makeIssue = (severity: 'warning' | 'error', code: string, message: string): ShapeImportIssue => ({
  severity,
  code,
  message,
})

function multiply(first: Matrix, second: Matrix): Matrix {
  return [
    first[0] * second[0] + first[2] * second[1],
    first[1] * second[0] + first[3] * second[1],
    first[0] * second[2] + first[2] * second[3],
    first[1] * second[2] + first[3] * second[3],
    first[0] * second[4] + first[2] * second[5] + first[4],
    first[1] * second[4] + first[3] * second[5] + first[5],
  ]
}

function transformPoint(matrix: Matrix, point: ImportPoint): ImportPoint {
  return {
    x: matrix[0] * point.x + matrix[2] * point.y + matrix[4],
    y: matrix[1] * point.x + matrix[3] * point.y + matrix[5],
  }
}

function parseNumberList(value: string): number[] | null {
  const result: number[] = []
  const token = new RegExp(NUMBER_PATTERN, 'g')
  let lastIndex = 0
  for (const match of value.matchAll(token)) {
    const index = match.index ?? 0
    if (!/^[\s,]*$/.test(value.slice(lastIndex, index))) return null
    result.push(Number(match[0]))
    lastIndex = index + match[0].length
  }
  if (!/^[\s,]*$/.test(value.slice(lastIndex)) || result.some(number => !Number.isFinite(number))) return null
  return result
}

function parseTransform(value: string): Matrix | null {
  let result = IDENTITY
  let lastIndex = 0
  const command = /([a-zA-Z]+)\s*\(([^)]*)\)/g
  for (const match of value.matchAll(command)) {
    const index = match.index ?? 0
    if (!/^\s*$/.test(value.slice(lastIndex, index))) return null
    const values = parseNumberList(match[2])
    if (!values) return null
    let next: Matrix
    switch (match[1].toLowerCase()) {
      case 'matrix':
        if (values.length !== 6) return null
        next = values as Matrix
        break
      case 'translate':
        if (values.length < 1 || values.length > 2) return null
        next = [1, 0, 0, 1, values[0], values[1] ?? 0]
        break
      case 'scale':
        if (values.length < 1 || values.length > 2) return null
        next = [values[0], 0, 0, values[1] ?? values[0], 0, 0]
        break
      case 'rotate': {
        if (values.length !== 1 && values.length !== 3) return null
        const angle = values[0] * Math.PI / 180
        const rotation: Matrix = [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0]
        if (values.length === 1) next = rotation
        else {
          const toCenter: Matrix = [1, 0, 0, 1, values[1], values[2]]
          const fromCenter: Matrix = [1, 0, 0, 1, -values[1], -values[2]]
          next = multiply(multiply(toCenter, rotation), fromCenter)
        }
        break
      }
      case 'skewx': {
        if (values.length !== 1) return null
        next = [1, 0, Math.tan(values[0] * Math.PI / 180), 1, 0, 0]
        break
      }
      case 'skewy': {
        if (values.length !== 1) return null
        next = [1, Math.tan(values[0] * Math.PI / 180), 0, 1, 0, 0]
        break
      }
      default: return null
    }
    result = multiply(result, next)
    lastIndex = index + match[0].length
  }
  return /^\s*$/.test(value.slice(lastIndex)) ? result : null
}

function decodeXmlAttribute(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, entity => {
    if (entity === '&amp;') return '&'
    if (entity === '&lt;') return '<'
    if (entity === '&gt;') return '>'
    if (entity === '&quot;') return '"'
    if (entity === '&apos;') return "'"
    const hex = entity.toLowerCase().startsWith('&#x')
    const code = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10)
    return Number.isFinite(code) ? String.fromCodePoint(code) : entity
  })
}

function parseAttributes(source: string): Record<string, string> | null {
  const attributes: Record<string, string> = {}
  let index = 0
  while (index < source.length) {
    while (/\s/.test(source[index] ?? '')) index++
    if (index >= source.length) break
    const nameMatch = /^[A-Za-z_:][\w:.-]*/.exec(source.slice(index))
    if (!nameMatch) return null
    const name = nameMatch[0].toLowerCase()
    if (Object.hasOwn(attributes, name)) return null
    index += nameMatch[0].length
    while (/\s/.test(source[index] ?? '')) index++
    if (source[index] !== '=') return null
    index++
    while (/\s/.test(source[index] ?? '')) index++
    const quote = source[index]
    if (quote !== '"' && quote !== "'") return null
    index++
    const end = source.indexOf(quote, index)
    if (end < 0) return null
    attributes[name] = decodeXmlAttribute(source.slice(index, end))
    index = end + 1
  }
  return attributes
}

function attrNumber(attributes: Record<string, string>, name: string, fallback?: number): number | null {
  const value = attributes[name]
  if (value === undefined) return fallback ?? null
  const match = new RegExp(`^\\s*(${NUMBER_PATTERN})(?:px)?\\s*$`, 'i').exec(value)
  if (!match) return null
  const parsed = Number(match[1])
  return Number.isFinite(parsed) ? parsed : null
}

function appendPoint(points: ImportPoint[], point: ImportPoint, context: TessellationContext): void {
  if (points.length > 0 && distanceSquared(points[points.length - 1], point) <= 1e-20) return
  context.remaining--
  if (context.remaining < 0) throw new Error('CURVE_SEGMENT_LIMIT')
  points.push(point)
}

function tessellateQuadratic(
  points: ImportPoint[],
  start: ImportPoint,
  control: ImportPoint,
  end: ImportPoint,
  context: TessellationContext,
  depth = 0,
): void {
  const lineLength = Math.hypot(end.x - start.x, end.y - start.y)
  const chordDistance = lineLength <= 1e-12
    ? Math.hypot(control.x - start.x, control.y - start.y)
    : Math.abs(
      (end.x - start.x) * (start.y - control.y) - (start.x - control.x) * (end.y - start.y),
    ) / lineLength
  if (chordDistance <= context.tolerance || depth >= 16) {
    appendPoint(points, end, context)
    return
  }
  const first = { x: (start.x + control.x) / 2, y: (start.y + control.y) / 2 }
  const second = { x: (control.x + end.x) / 2, y: (control.y + end.y) / 2 }
  const middle = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
  tessellateQuadratic(points, start, first, middle, context, depth + 1)
  tessellateQuadratic(points, middle, second, end, context, depth + 1)
}

function tessellateCubic(
  points: ImportPoint[],
  start: ImportPoint,
  firstControl: ImportPoint,
  secondControl: ImportPoint,
  end: ImportPoint,
  context: TessellationContext,
  depth = 0,
): void {
  const lineLength = Math.hypot(end.x - start.x, end.y - start.y)
  const firstDistance = lineLength <= 1e-12
    ? Math.hypot(firstControl.x - start.x, firstControl.y - start.y)
    : Math.abs(
      (end.x - start.x) * (start.y - firstControl.y) - (start.x - firstControl.x) * (end.y - start.y),
    ) / lineLength
  const secondDistance = lineLength <= 1e-12
    ? Math.hypot(secondControl.x - start.x, secondControl.y - start.y)
    : Math.abs(
      (end.x - start.x) * (start.y - secondControl.y) - (start.x - secondControl.x) * (end.y - start.y),
    ) / lineLength
  if (Math.max(firstDistance, secondDistance) <= context.tolerance || depth >= 16) {
    appendPoint(points, end, context)
    return
  }
  const a = { x: (start.x + firstControl.x) / 2, y: (start.y + firstControl.y) / 2 }
  const b = { x: (firstControl.x + secondControl.x) / 2, y: (firstControl.y + secondControl.y) / 2 }
  const c = { x: (secondControl.x + end.x) / 2, y: (secondControl.y + end.y) / 2 }
  const d = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  const e = { x: (b.x + c.x) / 2, y: (b.y + c.y) / 2 }
  const middle = { x: (d.x + e.x) / 2, y: (d.y + e.y) / 2 }
  tessellateCubic(points, start, a, d, middle, context, depth + 1)
  tessellateCubic(points, middle, e, c, end, context, depth + 1)
}

function vectorAngle(ux: number, uy: number, vx: number, vy: number): number {
  const denominator = Math.max(1e-12, Math.hypot(ux, uy) * Math.hypot(vx, vy))
  const angle = Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / denominator)))
  return ux * vy - uy * vx < 0 ? -angle : angle
}

function tessellateArc(
  points: ImportPoint[],
  start: ImportPoint,
  rxInput: number,
  ryInput: number,
  rotationDegrees: number,
  largeArc: boolean,
  sweep: boolean,
  end: ImportPoint,
  context: TessellationContext,
): void {
  let rx = Math.abs(rxInput)
  let ry = Math.abs(ryInput)
  if (rx <= 1e-12 || ry <= 1e-12 || distanceSquared(start, end) <= 1e-20) {
    appendPoint(points, end, context)
    return
  }
  const rotation = rotationDegrees * Math.PI / 180
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  const halfDx = (start.x - end.x) / 2
  const halfDy = (start.y - end.y) / 2
  const xPrime = cos * halfDx + sin * halfDy
  const yPrime = -sin * halfDx + cos * halfDy
  const scale = xPrime * xPrime / (rx * rx) + yPrime * yPrime / (ry * ry)
  if (scale > 1) {
    const multiplier = Math.sqrt(scale)
    rx *= multiplier
    ry *= multiplier
  }
  const numerator = Math.max(0, rx * rx * ry * ry - rx * rx * yPrime * yPrime - ry * ry * xPrime * xPrime)
  const denominator = Math.max(1e-20, rx * rx * yPrime * yPrime + ry * ry * xPrime * xPrime)
  const sign = largeArc === sweep ? -1 : 1
  const coefficient = sign * Math.sqrt(numerator / denominator)
  const centerPrimeX = coefficient * rx * yPrime / ry
  const centerPrimeY = -coefficient * ry * xPrime / rx
  const centerX = cos * centerPrimeX - sin * centerPrimeY + (start.x + end.x) / 2
  const centerY = sin * centerPrimeX + cos * centerPrimeY + (start.y + end.y) / 2
  const unitStartX = (xPrime - centerPrimeX) / rx
  const unitStartY = (yPrime - centerPrimeY) / ry
  const unitEndX = (-xPrime - centerPrimeX) / rx
  const unitEndY = (-yPrime - centerPrimeY) / ry
  const startAngle = vectorAngle(1, 0, unitStartX, unitStartY)
  let delta = vectorAngle(unitStartX, unitStartY, unitEndX, unitEndY)
  if (!sweep && delta > 0) delta -= Math.PI * 2
  if (sweep && delta < 0) delta += Math.PI * 2
  const radius = Math.max(rx, ry)
  const chordStep = radius <= context.tolerance
    ? Math.PI / 4
    : 2 * Math.acos(Math.max(-1, Math.min(1, 1 - context.tolerance / radius)))
  const segments = Math.max(1, Math.ceil(Math.abs(delta) / Math.max(1e-4, Math.min(Math.PI / 12, chordStep))))
  for (let index = 1; index <= segments; index++) {
    const angle = startAngle + delta * index / segments
    const localX = rx * Math.cos(angle)
    const localY = ry * Math.sin(angle)
    appendPoint(points, {
      x: centerX + cos * localX - sin * localY,
      y: centerY + sin * localX + cos * localY,
    }, context)
  }
}

function tokenizePath(data: string): Array<string | number> | null {
  const tokens: Array<string | number> = []
  let lastIndex = 0
  for (const match of data.matchAll(PATH_TOKEN)) {
    const index = match.index ?? 0
    if (!/^[\s,]*$/.test(data.slice(lastIndex, index))) return null
    tokens.push(/[a-zA-Z]/.test(match[0]) ? match[0] : Number(match[0]))
    lastIndex = index + match[0].length
  }
  return /^[\s,]*$/.test(data.slice(lastIndex)) ? tokens : null
}

function pathToLoops(data: string, context: TessellationContext): { loops: ImportPoint[][]; openLoops: number } | null {
  const tokens = tokenizePath(data)
  if (!tokens) return null
  const loops: ImportPoint[][] = []
  let openLoops = 0
  let index = 0
  let command = ''
  let previousCommand = ''
  let current: ImportPoint = { x: 0, y: 0 }
  let start: ImportPoint = { x: 0, y: 0 }
  let active: ImportPoint[] = []
  let cubicControl: ImportPoint | null = null
  let quadraticControl: ImportPoint | null = null
  const finish = (closed: boolean): void => {
    if (active.length >= 3) {
      const cleaned = cleanRing(active, 1e-10).points
      if (cleaned.length >= 3) loops.push(cleaned)
      if (!closed) openLoops++
    }
    active = []
  }
  const hasNumber = (): boolean => typeof tokens[index] === 'number'
  const take = (): number | null => {
    const value = tokens[index]
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
    index++
    return value
  }
  const point = (relative: boolean): ImportPoint | null => {
    const x = take()
    const y = take()
    if (x === null || y === null) return null
    return relative ? { x: current.x + x, y: current.y + y } : { x, y }
  }

  while (index < tokens.length) {
    if (typeof tokens[index] === 'string') command = String(tokens[index++])
    else if (!command) return null
    const relative = command === command.toLowerCase()
    const upper = command.toUpperCase()
    if (!'MLHVCSQTAZ'.includes(upper)) return null
    if (upper === 'Z') {
      if (active.length > 0) finish(true)
      current = { ...start }
      cubicControl = quadraticControl = null
      previousCommand = upper
      command = ''
      continue
    }
    if (!hasNumber()) return null
    let consumed = false
    while (hasNumber()) {
      consumed = true
      if (upper === 'M') {
        const target = point(relative)
        if (!target) return null
        if (active.length > 0) finish(false)
        current = target
        start = target
        active = [{ ...target }]
        command = relative ? 'l' : 'L'
        while (hasNumber()) {
          const lineTarget = point(relative)
          if (!lineTarget) return null
          appendPoint(active, lineTarget, context)
          current = lineTarget
        }
      } else if (upper === 'L') {
        const target = point(relative)
        if (!target) return null
        appendPoint(active, target, context)
        current = target
      } else if (upper === 'H') {
        const value = take()
        if (value === null) return null
        current = { x: relative ? current.x + value : value, y: current.y }
        appendPoint(active, current, context)
      } else if (upper === 'V') {
        const value = take()
        if (value === null) return null
        current = { x: current.x, y: relative ? current.y + value : value }
        appendPoint(active, current, context)
      } else if (upper === 'C') {
        const first = point(relative)
        const second = point(relative)
        const target = point(relative)
        if (!first || !second || !target) return null
        tessellateCubic(active, current, first, second, target, context)
        current = target
        cubicControl = second
      } else if (upper === 'S') {
        const second = point(relative)
        const target = point(relative)
        if (!second || !target) return null
        const first = (previousCommand === 'C' || previousCommand === 'S') && cubicControl
          ? { x: current.x * 2 - cubicControl.x, y: current.y * 2 - cubicControl.y }
          : { ...current }
        tessellateCubic(active, current, first, second, target, context)
        current = target
        cubicControl = second
      } else if (upper === 'Q') {
        const control = point(relative)
        const target = point(relative)
        if (!control || !target) return null
        tessellateQuadratic(active, current, control, target, context)
        current = target
        quadraticControl = control
      } else if (upper === 'T') {
        const target = point(relative)
        if (!target) return null
        const reflectedControl: ImportPoint = (previousCommand === 'Q' || previousCommand === 'T') && quadraticControl
          ? { x: current.x * 2 - quadraticControl.x, y: current.y * 2 - quadraticControl.y }
          : { ...current }
        tessellateQuadratic(active, current, reflectedControl, target, context)
        current = target
        quadraticControl = reflectedControl
      } else if (upper === 'A') {
        const rx = take()
        const ry = take()
        const rotation = take()
        const large = take()
        const sweep = take()
        const target = point(relative)
        if (rx === null || ry === null || rotation === null || large === null || sweep === null || !target
          || (large !== 0 && large !== 1) || (sweep !== 0 && sweep !== 1)) return null
        tessellateArc(active, current, rx, ry, rotation, large === 1, sweep === 1, target, context)
        current = target
      }
      previousCommand = upper
      if (upper !== 'C' && upper !== 'S') cubicControl = null
      if (upper !== 'Q' && upper !== 'T') quadraticControl = null
      if (upper === 'M') break
    }
    if (!consumed) return null
  }
  if (active.length > 0) finish(false)
  return { loops, openLoops }
}

function ellipseRing(cx: number, cy: number, rx: number, ry: number, context: TessellationContext): ImportPoint[] {
  const radius = Math.max(rx, ry)
  const step = radius <= context.tolerance
    ? Math.PI / 4
    : 2 * Math.acos(Math.max(-1, Math.min(1, 1 - context.tolerance / radius)))
  const segments = Math.max(12, Math.ceil(Math.PI * 2 / Math.max(1e-4, Math.min(Math.PI / 12, step))))
  const points: ImportPoint[] = []
  for (let index = 0; index < segments; index++) appendPoint(points, {
    x: cx + rx * Math.cos(index * Math.PI * 2 / segments),
    y: cy + ry * Math.sin(index * Math.PI * 2 / segments),
  }, context)
  return points
}

function rectRing(attributes: Record<string, string>, context: TessellationContext): ImportPoint[] | null {
  const x = attrNumber(attributes, 'x', 0)
  const y = attrNumber(attributes, 'y', 0)
  const width = attrNumber(attributes, 'width')
  const height = attrNumber(attributes, 'height')
  if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) return null
  let rx = attrNumber(attributes, 'rx', 0)
  let ry = attrNumber(attributes, 'ry', 0)
  if (rx === null || ry === null || rx < 0 || ry < 0) return null
  if (attributes.rx !== undefined && attributes.ry === undefined) ry = rx
  if (attributes.ry !== undefined && attributes.rx === undefined) rx = ry
  rx = Math.min(rx, width / 2)
  ry = Math.min(ry, height / 2)
  if (rx <= 0 || ry <= 0) return [
    { x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height },
  ]
  const points: ImportPoint[] = [{ x: x + rx, y }]
  const corners = [
    { cx: x + width - rx, cy: y + ry, start: -Math.PI / 2 },
    { cx: x + width - rx, cy: y + height - ry, start: 0 },
    { cx: x + rx, cy: y + height - ry, start: Math.PI / 2 },
    { cx: x + rx, cy: y + ry, start: Math.PI },
  ]
  for (const corner of corners) {
    const segments = Math.max(2, Math.ceil(Math.PI / 2 / Math.max(0.05, Math.min(Math.PI / 12, 2 * Math.acos(
      Math.max(-1, Math.min(1, 1 - context.tolerance / Math.max(rx, ry))),
    )))))
    for (let index = 0; index <= segments; index++) {
      const angle = corner.start + Math.PI / 2 * index / segments
      appendPoint(points, { x: corner.cx + rx * Math.cos(angle), y: corner.cy + ry * Math.sin(angle) }, context)
    }
  }
  return cleanRing(points, 1e-10).points
}

function safeAttributes(attributes: Record<string, string>): string | null {
  for (const [name, value] of Object.entries(attributes)) {
    if (/^on/i.test(name)) return `事件属性 ${name}`
    if (name === 'href' || name === 'xlink:href' || name === 'src') return `外部引用属性 ${name}`
    if (/url\s*\(|@import|expression\s*\(/i.test(value)) return `可执行或外链样式 ${name}`
  }
  return null
}

/**
 * Parses SVG as data with a strict XML tokenizer. It never mounts markup in the DOM and never
 * resolves URLs. Open path/polyline subpaths are explicitly closed with a warning for board use.
 */
export function importSvgString(svg: string, options: SvgImportOptions = {}): ShapeImportResult {
  const warnings: ShapeImportIssue[] = []
  const errors: ShapeImportIssue[] = []
  if (svg.length > 5_000_000) return {
    draft: null,
    warnings,
    errors: [makeIssue('error', 'SVG_SIZE_LIMIT', 'SVG 文本超过 5 MB 安全上限。')],
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(svg)) errors.push(makeIssue('error', 'SVG_DOCTYPE_REJECTED', '不接受 DOCTYPE 或实体声明。'))
  if (DANGEROUS_ELEMENT.test(svg)) errors.push(makeIssue('error', 'SVG_DANGEROUS_ELEMENT', 'SVG 包含 script、外链、use 或 foreignObject 等禁用元素。'))
  if (errors.length > 0) return { draft: null, warnings, errors }

  const loops: ImportPoint[][] = []
  const frames: SvgFrame[] = []
  const context: TessellationContext = {
    tolerance: Math.max(1e-4, options.curveTolerance ?? 0.25),
    remaining: Math.max(32, Math.floor(options.maxCurveSegments ?? 50_000)),
  }
  let sourceWidth: number | undefined
  let sourceHeight: number | undefined
  let sawSvgRoot = false
  let lastIndex = 0
  const tagPattern = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![^>]*>|<[^>]+>/g
  try {
    for (const match of svg.matchAll(tagPattern)) {
      const index = match.index ?? 0
      const text = svg.slice(lastIndex, index)
      if (text.trim() && !frames.some(frame => frame.ignored)) {
        errors.push(makeIssue('error', 'SVG_TEXT_OUTSIDE_METADATA', '图形节点之间包含无法解释的文本。'))
      }
      lastIndex = index + match[0].length
      const token = match[0]
      if (token.startsWith('<!--') || token.startsWith('<?')) continue
      if (token.startsWith('<!')) {
        errors.push(makeIssue('error', 'SVG_DECLARATION_REJECTED', 'SVG 中包含不支持的声明。'))
        continue
      }
      if (/^<\s*\//.test(token)) {
        const closeMatch = /^<\s*\/\s*([A-Za-z_:][\w:.-]*)\s*>$/.exec(token)
        if (!closeMatch || frames.length === 0 || frames[frames.length - 1].name !== closeMatch[1].toLowerCase()) {
          errors.push(makeIssue('error', 'SVG_MALFORMED_XML', 'SVG 标签嵌套不完整。'))
        } else frames.pop()
        continue
      }
      const selfClosing = /\/\s*>$/.test(token)
      const content = token.slice(1, token.length - (selfClosing ? 2 : 1)).trim()
      const nameMatch = /^([A-Za-z_:][\w:.-]*)/.exec(content)
      if (!nameMatch) {
        errors.push(makeIssue('error', 'SVG_MALFORMED_XML', 'SVG 起始标签格式错误。'))
        continue
      }
      const name = nameMatch[1].toLowerCase()
      const attributes = parseAttributes(content.slice(nameMatch[0].length))
      if (!attributes) {
        errors.push(makeIssue('error', 'SVG_MALFORMED_ATTRIBUTE', `${name} 包含格式错误的属性。`))
        continue
      }
      const unsafe = safeAttributes(attributes)
      if (unsafe) errors.push(makeIssue('error', 'SVG_DANGEROUS_ATTRIBUTE', `${name} 包含禁用的${unsafe}。`))
      const parent = frames[frames.length - 1]
      if (!parent && name !== 'svg') errors.push(makeIssue('error', 'SVG_ROOT_ORDER', '所有图形节点都必须位于 <svg> 根元素内。'))
      if (!parent && name === 'svg' && sawSvgRoot) errors.push(makeIssue('error', 'SVG_MULTIPLE_ROOTS', 'SVG 只能包含一个根元素。'))
      const ignored = Boolean(parent?.ignored) || IGNORED_ELEMENTS.has(name)
      if (!ignored && !SAFE_ELEMENTS.has(name)) {
        errors.push(makeIssue('error', 'SVG_UNSUPPORTED_ELEMENT', `暂不支持 SVG 元素 <${name}>。`))
      }
      const localTransform = attributes.transform ? parseTransform(attributes.transform) : IDENTITY
      if (!localTransform) errors.push(makeIssue('error', 'SVG_INVALID_TRANSFORM', `${name} 的 transform 无法解析。`))
      const matrix = multiply(parent?.matrix ?? IDENTITY, localTransform ?? IDENTITY)
      if (name === 'svg') {
        sawSvgRoot = true
        const width = attrNumber(attributes, 'width')
        const height = attrNumber(attributes, 'height')
        const viewBox = attributes.viewbox ? parseNumberList(attributes.viewbox) : null
        if (width !== null && width > 0) sourceWidth = width
        if (height !== null && height > 0) sourceHeight = height
        if (viewBox?.length === 4) {
          sourceWidth ??= viewBox[2]
          sourceHeight ??= viewBox[3]
        }
      }
      if (!ignored && SAFE_ELEMENTS.has(name) && !['svg', 'g'].includes(name)) {
        let elementLoops: ImportPoint[][] | null = null
        if (name === 'path') {
          const parsed = attributes.d ? pathToLoops(attributes.d, context) : null
          if (!parsed) errors.push(makeIssue('error', 'SVG_INVALID_PATH', 'path 的 d 属性无法完整解析。'))
          else {
            elementLoops = parsed.loops
            if (parsed.openLoops > 0) warnings.push(makeIssue(
              'warning',
              'OPEN_SUBPATH_CLOSED',
              `${parsed.openLoops} 个开放 path 子路径已显式闭合以形成板型。`,
            ))
          }
        } else if (name === 'polygon' || name === 'polyline') {
          const values = attributes.points ? parseNumberList(attributes.points) : null
          if (!values || values.length < 6 || values.length % 2 !== 0) {
            errors.push(makeIssue('error', 'SVG_INVALID_POINTS', `${name} 的 points 属性无效。`))
          } else {
            const points: ImportPoint[] = []
            for (let valueIndex = 0; valueIndex < values.length; valueIndex += 2) points.push({
              x: values[valueIndex], y: values[valueIndex + 1],
            })
            elementLoops = [cleanRing(points, 1e-10).points]
            if (name === 'polyline') warnings.push(makeIssue('warning', 'OPEN_POLYLINE_CLOSED', 'polyline 已显式闭合以形成板型。'))
          }
        } else if (name === 'rect') {
          const ring = rectRing(attributes, context)
          if (!ring) errors.push(makeIssue('error', 'SVG_INVALID_RECT', 'rect 的尺寸或圆角属性无效。'))
          else elementLoops = [ring]
        } else if (name === 'circle' || name === 'ellipse') {
          const cx = attrNumber(attributes, 'cx', 0)
          const cy = attrNumber(attributes, 'cy', 0)
          const rx = name === 'circle' ? attrNumber(attributes, 'r') : attrNumber(attributes, 'rx')
          const ry = name === 'circle' ? rx : attrNumber(attributes, 'ry')
          if (cx === null || cy === null || rx === null || ry === null || rx <= 0 || ry <= 0) {
            errors.push(makeIssue('error', 'SVG_INVALID_ELLIPSE', `${name} 的中心或半径属性无效。`))
          } else elementLoops = [ellipseRing(cx, cy, rx, ry, context)]
        }
        if (elementLoops) loops.push(...elementLoops.map(ring => ring.map(point => transformPoint(matrix, point))))
      }
      if (!selfClosing) frames.push({ name, matrix, ignored: ignored || !SAFE_ELEMENTS.has(name) })
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'CURVE_SEGMENT_LIMIT') {
      errors.push(makeIssue('error', 'CURVE_SEGMENT_LIMIT', '曲线离散点超过安全上限；请提高容差或简化源文件。'))
    } else errors.push(makeIssue('error', 'SVG_PARSE_FAILED', 'SVG 曲线解析失败。'))
  }
  if (svg.slice(lastIndex).trim()) errors.push(makeIssue('error', 'SVG_TRAILING_TEXT', 'SVG 末尾包含无法解释的文本。'))
  if (frames.length > 0) errors.push(makeIssue('error', 'SVG_UNCLOSED_TAG', 'SVG 存在未闭合标签。'))
  if (!sawSvgRoot) errors.push(makeIssue('error', 'SVG_ROOT_MISSING', '缺少 <svg> 根元素。'))
  if (errors.length > 0) return { draft: null, warnings, errors }

  const classified = draftFromClosedLoops('svg', options.name ?? '导入 SVG 板型', loops, { sourceWidth, sourceHeight })
  warnings.push(...classified.warnings)
  errors.push(...classified.errors)
  if (!classified.draft || errors.length > 0) return { draft: null, warnings, errors }
  const validated = normalizeAndValidateShape(classified.draft, options)
  return {
    draft: validated.draft,
    warnings: warnings.concat(validated.warnings),
    errors: errors.concat(validated.errors),
  }
}
