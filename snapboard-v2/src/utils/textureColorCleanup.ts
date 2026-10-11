/** Remove small quantization islands only when the original image has no corresponding edge. */
export function cleanTextureColorIslands(
  source: Uint8ClampedArray,
  mapped: Uint8ClampedArray,
  width: number,
  height: number,
  maxArea = 36,
  sourceTolerance = 18,
): number {
  if (source.length !== width * height * 4 || mapped.length !== source.length) throw new Error('Invalid texture cleanup dimensions')
  const total = width * height
  const colors = new Uint32Array(total)
  for (let i = 0; i < total; i++) colors[i] = (mapped[i*4] << 16) | (mapped[i*4+1] << 8) | mapped[i*4+2]
  const visited = new Uint8Array(total)
  const queue = new Int32Array(total)
  let changed = 0
  for (let start = 0; start < total; start++) {
    if (visited[start] || source[start*4+3] < 250) continue
    const color = colors[start]
    queue[0] = start; visited[start] = 1
    let head = 0, size = 1, border = false
    const sum = [0,0,0]
    const neighbours = new Map<number, { count: number; sum: number[] }>()
    while (head < size) {
      const p = queue[head++], x = p % width, y = Math.floor(p / width)
      if (x === 0 || x === width-1 || y === 0 || y === height-1) border = true
      for (let channel = 0; channel < 3; channel++) sum[channel] += source[p*4+channel]
      for (const q of [x>0?p-1:-1, x<width-1?p+1:-1, y>0?p-width:-1, y<height-1?p+width:-1]) {
        if (q < 0) continue
        if (source[q*4+3] < 250) { border = true; continue }
        if (colors[q] === color) {
          if (!visited[q]) { visited[q] = 1; queue[size++] = q }
        } else if (size <= maxArea) {
          let item = neighbours.get(colors[q])
          if (!item) { item = { count: 0, sum: [0,0,0] }; neighbours.set(colors[q], item) }
          item.count++
          for (let channel = 0; channel < 3; channel++) item.sum[channel] += source[q*4+channel]
        }
      }
    }
    if (size > maxArea || border) continue
    // Broad regions stay untouched; high-contrast fine details retain their source edges.
    let replacement: number | undefined, best = Infinity
    for (const [candidate, item] of neighbours) {
      if (item.count < 3) continue
      const distance = sum.reduce((d,v,ch) => d + (v/size-item.sum[ch]/item.count)**2,0)
      if (distance <= sourceTolerance**2 && distance < best) { best=distance; replacement=candidate }
    }
    if (replacement === undefined) continue
    for (let i = 0; i < size; i++) {
      const offset = queue[i]*4
      mapped[offset] = replacement >> 16
      mapped[offset+1] = (replacement >> 8) & 255
      mapped[offset+2] = replacement & 255
    }
    changed += size
  }
  return changed
}
