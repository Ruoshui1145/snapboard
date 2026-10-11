import { matchSnapColor, rgbToLab, type SnapColorLut, type SnapColorRgb } from './snapColorLut'

/** Bind almost-identical design colours before LUT quantization. No pixel-area
 * threshold: a large flat cheek and a small patch obey the same colour rule.
 * Complete-link bounds prevent chaining an entire gradient into one colour.
 * Source-only ordering keeps mapping independent of placement/cropping. */
export function continuousTextureRecipes(palette: SnapColorRgb[], lut: SnapColorLut, hueWeight: number): number[] {
  const source = palette.map(rgbToLab)
  const recipes = palette.map(rgb => matchSnapColor(rgb, lut, hueWeight))
  const initial = [...recipes]
  const target = (recipe: number): SnapColorRgb => [lut.labs[recipe * 3], lut.labs[recipe * 3 + 1], lut.labs[recipe * 3 + 2]]
  const distance = (a: SnapColorRgb, b: SnapColorRgb) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
  const baseline = source.map((lab, i) => distance(lab, target(initial[i])))
  const clusters = palette.map((_, i) => [i])
  const owner = palette.map((_, i) => i)
  const pairs: Array<{ a: number; b: number; distance: number }> = []
  for (let a = 0; a < palette.length; a++) for (let b = a + 1; b < palette.length; b++) {
    // Restrict the correction to pale/muted colours. Dark ink and saturated eye
    // details must keep their original matching even near a LUT threshold.
    if ([a, b].some(i => source[i][0] < 65 || Math.hypot(source[i][1], source[i][2]) > 40)) continue
    const d = distance(source[a], source[b])
    if (d <= 5) pairs.push({ a, b, distance: d })
  }
  pairs.sort((a, b) => a.distance - b.distance || a.a - b.a || a.b - b.b)
  for (const pair of pairs) {
    const a = owner[pair.a], b = owner[pair.b]
    if (a === b) continue
    const members = [...clusters[a], ...clusters[b]]
    if (members.some(i => members.some(j => distance(source[i], source[j]) > 5))) continue
    // Only intervene where the output jump amplifies a weak source difference.
    if (!members.some(i => members.some(j => distance(target(recipes[i]), target(recipes[j])) > Math.max(6, distance(source[i], source[j]) * 2.5)))) continue
    const mean = [0, 1, 2].map(ch => members.reduce((sum, i) => sum + palette[i][ch], 0) / members.length) as SnapColorRgb
    const candidates = [...new Set([matchSnapColor(mean, lut, hueWeight), ...members.map(i => initial[i])])]
    let best = -1, score = Infinity
    for (const recipe of candidates) {
      const errors = members.map(i => distance(source[i], target(recipe)))
      // Never buy uniformity by allowing a large per-colour accuracy loss.
      if (errors.some((error, k) => error > baseline[members[k]] + 4)) continue
      const next = errors.reduce((sum, error) => sum + error * error, 0)
      if (next < score) { best = recipe; score = next }
    }
    if (best < 0) continue
    clusters[a] = members; clusters[b] = []
    for (const i of members) { owner[i] = a; recipes[i] = best }
  }
  return recipes
}
