import type { BoardTextureConfig, SplitConfig, SplitPanel } from '../types/geometry'
import type { MultiPolygon } from 'polygon-clipping'
import { createSplitPanelShape } from './boardMesh'
import { buildTextureRegionContours } from './textureRegionContours'
import { extrudeTexturePartition } from './textureRegionExtrusion'
import { texturePolygon } from './texturePolygon'
import profile from '../assets/woodgrain-growth-profile.json'
import { pointInPolygon } from './holePattern'

export interface WoodGrainConfig {
  algorithm: 'growth-rings-v2'
  distribution: 'per-panel' | 'continuous'
  pattern: 'long-grain' | 'end-grain'
  spacingMm: number; variation: number; seed: number; cutDepthMm: number
  scale: number; rotationDegrees: number; offsetXmm: number; offsetYmm: number
  filamentType: 'PLA' | 'PETG'
}
export const DEFAULT_WOOD_GRAIN: WoodGrainConfig = {
  algorithm: 'growth-rings-v2', distribution: 'per-panel', pattern: 'long-grain', spacingMm: 4, variation: 1, seed: 0, cutDepthMm: 135,
  scale: 1, rotationDegrees: 0, offsetXmm: 0, offsetYmm: 0, filamentType: 'PETG',
}
export interface WoodGrainBounds { minX: number; minY: number; width: number; height: number }

export function normalizeWoodGrain(value: unknown): WoodGrainConfig {
  const result = { ...DEFAULT_WOOD_GRAIN }
  if (!value || typeof value !== 'object') return result
  const raw = value as Record<string, unknown>
  if (raw.distribution === 'continuous') result.distribution = 'continuous'
  if (raw.pattern === 'end-grain') result.pattern = raw.pattern
  if (raw.filamentType === 'PLA' || raw.filamentType === 'PETG') result.filamentType = raw.filamentType
  for (const [key,min,max] of [['spacingMm',2,20],['variation',0,2],['seed',0,65535],['cutDepthMm',0,500],
    ['scale',.1,20],['rotationDegrees',-360,360],['offsetXmm',-5000,5000],['offsetYmm',-5000,5000]] as const) {
    const n = raw[key]
    if (typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max) result[key] = key === 'seed' ? Math.round(n) : n
  }
  // Old projects migrate to the algorithm; discard the embedded original mesh and its 3D pose.
  return result
}

/** A cross-section of correlated, distorted growth shells, not independent painted stripes.
 * Calibrated to the reference's ~4 mm spacing, ~1.9 mm bands, ~2% radial distortion,
 * radius-dependent center drift and smooth axial bending. No source mesh is required. */
export function createWoodGrainField(value: WoodGrainConfig, bounds: WoodGrainBounds) {
  return woodGrainField(value, bounds, 0)
}

function woodGrainField(value: WoodGrainConfig, bounds: WoodGrainBounds, panelVariant: number) {
  const config = normalizeWoodGrain(value), a = config.rotationDegrees * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a)
  const cx = bounds.minX + bounds.width / 2 + config.offsetXmm, cy = bounds.minY + bounds.height / 2 + config.offsetYmm
  const spacing = config.spacingMm, strength = config.variation
  const phase = config.seed * 2.399963229728653 + panelVariant * (2 * Math.PI / 4294967296)
  const cosinePhase = Math.cos(phase), sinePhase = Math.sin(phase)
  const sample = (x: number, y: number): number => {
    const dx = (x - cx) / config.scale, dy = (y - cy) / config.scale
    let u = dx * cos + dy * sin, v = -dx * sin + dy * cos
    const axial = config.pattern === 'long-grain' ? v + 30 : 0
    if (config.pattern === 'long-grain') { u += 30; v = -config.cutDepthMm }
    const axisAngle = axial * 2 * Math.PI / profile.axialPeriodMm + phase
    const c = Math.cos(axisAngle), s = Math.sin(axisAngle)
    let hc = c, hs = s, driftX = profile.centerX[0], driftY = profile.centerY[0]
    for (let i = 1; i < profile.centerX.length; i += 2) {
      driftX += profile.centerX[i] * hc + profile.centerX[i + 1] * hs
      driftY += profile.centerY[i] * hc + profile.centerY[i + 1] * hs
      const next = hc * c - hs * s; hs = hs * c + hc * s; hc = next
    }
    driftX *= strength * spacing / 4; driftY *= strength * spacing / 4
    let r = Math.hypot(u - driftX, v - driftY)
    // The reference's outer rings drift ~13 mm relative to its inner rings over ~200 mm radius.
    for (let i = 0; i < 2; i++) r = Math.hypot(u - driftX - strength * profile.radialCenterDrift[0] * r, v - driftY - strength * profile.radialCenterDrift[1] * r)
    const rx = u - driftX - strength * profile.radialCenterDrift[0] * r, ry = v - driftY - strength * profile.radialCenterDrift[1] * r
    const norm = Math.hypot(rx,ry) || 1
    const ac = rx / norm * cosinePhase - ry / norm * sinePhase, as = ry / norm * cosinePhase + rx / norm * sinePhase
    hc = ac * ac - as * as; hs = 2 * ac * as
    let distortion = 0
    for (let i = 0; i < profile.angular.length; i += 2) {
      distortion += profile.angular[i] * hc + profile.angular[i + 1] * hs
      const next = hc * ac - hs * as; hs = hs * ac + hc * as; hc = next
    }
    r /= 1 + strength * distortion
    const growth = r / spacing
    const index = growth + strength * (.16 * Math.sin(.83 * growth + phase) + .1 * Math.sin(2.71 * growth + .6 + phase))
    const width = .46 + strength * (.12 * Math.sin(.67 * index + 1.1 + phase) + .06 * Math.sin(1.73 * index + phase))
    return width / 2 - Math.abs(index - Math.floor(index) - .5)
  }
  return { config, sample, variantSeed: (panelVariant + config.seed) >>> 0 }
}

/** Stable variation per logical board, identical in preview and every export. */
export function createWoodGrainPanelField(value: WoodGrainConfig, panel: SplitPanel, bounds: WoodGrainBounds) {
  const config = normalizeWoodGrain(value)
  if (config.distribution === 'continuous') return woodGrainField(config, bounds, 0)
  let hash = 2166136261
  for (const char of `${panel.id}|${panel.x}|${panel.y}|${panel.w}|${panel.h}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0
  return woodGrainField(config, { minX: panel.x, minY: panel.y, width: panel.w, height: panel.h }, hash)
}

export function woodGrainVeneerDepth(totalThickness: number, surfaceThickness = 1) {
  if (!Number.isFinite(surfaceThickness) || surfaceThickness < .4 || surfaceThickness > 3 ||
      !Number.isFinite(totalThickness) || totalThickness - surfaceThickness < .2 - 1e-6)
    throw new Error('木纹质感层至少需要 0.4 mm，并保留至少 0.2 mm 基材；请调整贴面厚度或增加总板厚')
  return { base: totalThickness - surfaceThickness, surface: surfaceThickness, total: totalThickness }
}

/** Migrate the previous whole-board appearance into a veneer recipe, without retaining its embedded mesh. */
export function normalizeWoodGrainTexture(texture: BoardTextureConfig, legacy = texture.woodGrain?.algorithm !== 'growth-rings-v2'): BoardTextureConfig {
  const woodGrain = normalizeWoodGrain(texture.woodGrain)
  const defaultSurface = texture.surfaceMaterialName === '浅绿色 PETG 大理石'
  return { ...texture, woodGrain, backEnabled: false, surfaceFinish: 'smooth-top',
    surfaceColor: legacy ? texture.baseColor : defaultSurface ? '#A57B4B' : texture.surfaceColor,
    surfaceMaterialName: defaultSurface ? `仿木 ${woodGrain.filamentType}` : texture.surfaceMaterialName,
    baseMaterialName: texture.baseMaterialName === '普通白色 PETG' && woodGrain.filamentType === 'PLA' ? '普通 PLA' : texture.baseMaterialName,
    baseColor: legacy && texture.baseMaterialName === '普通白色 PETG' ? '#F3F3EE' : texture.baseColor }
}

export function woodGrainPartSettings(_value: WoodGrainConfig, modifier = false): Record<string, string> {
  if (modifier) return { infill_direction: '135', top_surface_pattern: 'alignedrectilinear',
    fuzzy_skin: 'external', fuzzy_skin_point_distance: '1', fuzzy_skin_thickness: '0.08' }
  return { infill_direction: '45', top_surface_pattern: 'alignedrectilinear', bottom_surface_pattern: 'monotonic',
    fuzzy_skin: 'none', layer_height: '0.08', initial_layer_print_height: '0.2', wall_loops: '2',
    top_shell_layers: '9', top_shell_thickness: '0.8', bottom_shell_layers: '7', bottom_shell_thickness: '0',
    sparse_infill_density: '100%', sparse_infill_pattern: 'zig-zag', ironing_type: 'no ironing' }
}

/** World-aligned sampling with a one-cell halo keeps split edges on the same grain field. */
export async function woodGrainModifier(panel: SplitPanel, cfg: SplitConfig, value: WoodGrainConfig, bounds: WoodGrainBounds, signal?: AbortSignal, surfaceThickness = 1) {
  const depths = woodGrainVeneerDepth(cfg.thickness, surfaceThickness)
  const field = createWoodGrainPanelField(value, panel, bounds), step = .2
  const x0 = Math.floor(panel.x / step) - 1, y0 = Math.floor(panel.y / step) - 1
  const width = Math.ceil((panel.x + panel.w) / step) + 1 - x0, height = Math.ceil((panel.y + panel.h) / step) + 1 - y0
  if (width * height > 3_000_000) throw new Error('木纹板件过大，请先按热床尺寸分板')
  const xs = Float64Array.from({ length: width + 1 }, (_, i) => (x0 + i) * step)
  const ys = Float64Array.from({ length: height + 1 }, (_, i) => (y0 + i) * step)
  const materials = new Int16Array(width * height)
  for (let y = 0; y < height; y++) {
    if (!(y % 128)) {
      if (signal?.aborted) throw new DOMException('已取消导出', 'AbortError')
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    for (let x = 0; x < width; x++) materials[y * width + x] = field.sample((xs[x] + xs[x + 1]) / 2, (ys[y] + ys[y + 1]) / 2) > 0 ? 1 : 0
  }
  const { regions } = buildTextureRegionContours({ materials, width, height, xBoundaries: xs, yBoundaries: ys, toleranceMm: .05 })
  const shape = createSplitPanelShape(panel, cfg, 24).extractPoints(24)
  const domain: MultiPolygon = [[shape.shape.map(p => [p.x,p.y]), ...shape.holes.map(ring => ring.map(p => [p.x,p.y] as [number,number]))]]
  const clipped = texturePolygon.intersection((regions.get(1) ?? []).map(p => [p.outer,...p.holes]), domain)
  if (!clipped.length) return { mesh: null }
  const mesh = extrudeTexturePartition(clipped.map(p => ({ outer:p[0], holes:p.slice(1) })), depths.base, depths.total)
  // Grain sampling stays in sketch coordinates; the sibling structural mesh is panel-local in the 3MF.
  for (let i = 0; i < mesh.vertices.length; i += 3) {
    mesh.vertices[i] -= panel.x
    mesh.vertices[i + 1] -= panel.y
  }
  return { mesh, polygons: clipped, variantSeed: field.variantSeed }
}

/** Same single-colour material under fixed directional lighting; not a printed colour image. */
export function drawWoodGrainPreview(ctx: CanvasRenderingContext2D, width: number, height: number, value: WoodGrainConfig, bounds: WoodGrainBounds, color: string, panels: SplitPanel[] = []) {
  const fallback = createWoodGrainField(value, bounds)
  const fields = panels.map(panel => ({ panel, ...createWoodGrainPanelField(value, panel, bounds) }))
  const base = /^#[0-9a-f]{6}$/i.test(color) ? color : '#A57B4B'
  const rgb = [1,3,5].map(i => parseInt(base.slice(i,i+2),16)), output = ctx.createImageData(width,height)
  const dx = bounds.width / width, dy = bounds.height / height
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const wx = bounds.minX + (x + .5) * dx, wy = bounds.minY + bounds.height - (y + .5) * dy
    const owner = fields.find(({ panel }) => wx >= panel.x && wx <= panel.x + panel.w && wy >= panel.y && wy <= panel.y + panel.h &&
      (!panel.contour || pointInPolygon({ x:wx, y:wy }, panel.contour)))
    const direction = (owner ?? fallback).sample(wx,wy) > 0 ? 135 : 45
    const reflection = 1 + .12 * Math.cos(2 * (direction - 45) * Math.PI / 180)
    const ridge = Math.max(dx,dy) < .3 ? .025 * Math.cos(2 * Math.PI * (wx + (direction === 45 ? wy : -wy)) / (.42 * Math.SQRT2)) : 0
    const index = (y * width + x) * 4
    for (let axis = 0; axis < 3; axis++) output.data[index + axis] = Math.max(0,Math.min(255,rgb[axis] * (reflection + ridge)))
    output.data[index + 3] = 255
  }
  ctx.putImageData(output,0,0)
}
