import printerConfigurations from '../assets/woodgrain-bambu-printer-configs.json?raw'
import type { SplitConfig } from '../types/geometry'
import { getBambuPrinterPreset } from './bambuPrinterPresets'

export const BAMBU_PROFILE_VERSION = '02.08.02.60'
export const BULK_LAYER_HEIGHT_MM = 0.28
export const Z_TOP_LAYER_HEIGHT_MM = 0.2
export const Z_TOP_FINISH_DEPTH_MM = Z_TOP_LAYER_HEIGHT_MM * 2

/** Optical body paths follow Lumina. Bed-contact width is a separate printer
 * setting and must retain the standard template value (0.50 mm for P1S 0.4). */
export const PREPARED_OPTICAL_PATH_SETTINGS: Readonly<Record<string, string>> = Object.freeze({
  line_width: '0.42',
  outer_wall_line_width: '0.42', inner_wall_line_width: '0.42',
  sparse_infill_line_width: '0.42', internal_solid_infill_line_width: '0.42',
  top_surface_line_width: '0.42', wall_generator: 'arachne',
})

/** Bambu serializes the conventional Rectilinear pattern as `zig-zag`, not
 * `rectilinear`. The latter becomes an unknown-enum import substitution. */
export function normalizeBambuFillPatterns(settings: Record<string, string>): Record<string, string> {
  const result = { ...settings }
  for (const key of ['sparse_infill_pattern', 'internal_solid_infill_pattern', 'top_surface_pattern', 'bottom_surface_pattern']) {
    if (result[key] === 'rectilinear') result[key] = 'zig-zag'
  }
  return result
}

/** Same bed-facing contact skin as the existing optical generator. Keep
 * density explicit: these material volumes encode colours, not sparse ribs. */
export function preparedOpticalPartSettings(settings: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {
    ...normalizeBambuFillPatterns(settings),
    ...PREPARED_OPTICAL_PATH_SETTINGS,
    layer_height: '0.08', wall_loops: '1', top_shell_layers: '0',
    top_shell_thickness: '0', bottom_shell_layers: '1', bottom_shell_thickness: '0',
    sparse_infill_density: '100%', sparse_infill_pattern: 'zig-zag',
    internal_solid_infill_pattern: 'zig-zag', fuzzy_skin: 'none',
  }
  // Inherit the editable project first-layer width; old per-volume values
  // would silently shadow the user's adjustment in Bambu Studio.
  delete result.initial_layer_line_width
  delete result.initial_layer_infill_line_width
  return result
}

/** Colour boards stay solid even if an importer drops an object/part override.
 * Mechanical bases retain their explicit object-level infill preferences. */
export function applyPreparedOpticalProjectDefaults(settings: Record<string, unknown>): void {
  Object.assign(settings, PREPARED_OPTICAL_PATH_SETTINGS)
  settings.sparse_infill_density = '100%'
  settings.sparse_infill_pattern = 'zig-zag'
  settings.internal_solid_infill_pattern = 'zig-zag'
  // These unrelated experimental defaults can produce substitutions in
  // older importers; the standee uses the conventional dense pattern.
  for (const key of ['infill_lock_depth', 'infill_shift_step', 'infill_rotate_step',
    'locked_skin_infill_pattern', 'locked_skeleton_infill_pattern', 'skin_infill_density',
    'skeleton_infill_density', 'skin_infill_line_width', 'skeleton_infill_line_width',
    'skin_infill_depth', 'symmetric_infill_y_axis', 'sparse_infill_lattice_angle_1',
    'sparse_infill_lattice_angle_2', 'reduce_infill_retraction_mode']) delete settings[key]
  const changes = settings.different_settings_to_system as string[]
  if (changes?.length) changes[0] = [...new Set([...changes[0].split(';'),
    'sparse_infill_density', 'sparse_infill_pattern', 'internal_solid_infill_pattern',
    'initial_layer_line_width', ...Object.keys(PREPARED_OPTICAL_PATH_SETTINGS)])].join(';')
}

const templates = JSON.parse(printerConfigurations) as {
  common: Record<string, unknown>; printers: Record<string, Record<string, unknown>>
}

/** These installed-machine templates already contain the correct physical extruder/variant vectors. */
export function selectedBambuProjectTemplate(cfg: SplitConfig): Record<string, unknown> {
  const printer = getBambuPrinterPreset(cfg.printerPreset)
  const machine = templates.printers[printer.id]
  if (!machine) throw new Error(`缺少 ${printer.label} 的切片机型配置`)
  return structuredClone({ ...templates.common, ...machine })
}

/** Bambu rebuilds inherited system presets on import; retain each deliberate recipe override. */
export function finalizeBambuProjectProfile(settings: Record<string, unknown>, cfg: SplitConfig, colors: string[]): string {
  const printer = getBambuPrinterPreset(cfg.printerPreset)
  settings.version = BAMBU_PROFILE_VERSION
  settings.nozzle_volume_type = structuredClone(settings.default_nozzle_volume_type)
  const physicalExtruders = printer.extruderCount ?? 1
  const heights = settings.extruder_printable_height as string[] | undefined
  if (!heights?.length) settings.extruder_printable_height = Array.from({ length: physicalExtruders }, () => String(printer.printableHeight))
  // The exported 0.4 mm machine selection uses Standard nozzles. Material vectors describe that selected variant.
  settings.filament_extruder_variant = colors.map(() => 'Direct Drive Standard')
  settings.filament_self_index = colors.map((_, index) => String(index + 1))
  const filamentId = settings.filament_id
  if (!filamentId || (Array.isArray(filamentId) && filamentId.length !== colors.length)) throw new Error('切片耗材标识与耗材数量不一致')
  // The CLI re-export reads this vector by material slot; an empty default
  // causes get_at() to assert after slicing, before writing the new project.
  settings.filament_ids = Array.isArray(filamentId) ? [...filamentId] : colors.map(() => String(filamentId))
  settings.filament_map = colors.map(() => '1')
  settings.filament_volume_map = colors.map(() => '0')
  settings.filament_nozzle_map = colors.map(() => '0')
  const printVariants = (settings.print_extruder_variant as string[]).length
  for (const key of ['outer_wall_speed', 'inner_wall_speed', 'sparse_infill_speed', 'internal_solid_infill_speed', 'top_surface_speed', 'initial_layer_speed', 'initial_layer_infill_speed']) {
    const value = settings[key]
    if (Array.isArray(value)) settings[key] = Array.from({ length: printVariants }, () => value[0])
  }
  const filaments = settings.filament_settings_id as string[]
  settings.inherits_group = [printer.defaultPrintProfile, ...filaments, printer.profile]
  settings.different_settings_to_system = [
    'layer_height;initial_layer_print_height;line_width;wall_loops;top_shell_layers;bottom_shell_layers;top_shell_thickness;bottom_shell_thickness;sparse_infill_density;sparse_infill_pattern;fuzzy_skin;enable_prime_tower;outer_wall_speed;inner_wall_speed;sparse_infill_speed;internal_solid_infill_speed;top_surface_speed;initial_layer_speed;initial_layer_infill_speed',
    ...colors.map(() => 'filament_type;filament_vendor;filament_density;filament_flow_ratio;filament_max_volumetric_speed;nozzle_temperature;nozzle_temperature_initial_layer;nozzle_temperature_range_low;nozzle_temperature_range_high;fan_min_speed;fan_max_speed;textured_plate_temp;textured_plate_temp_initial_layer;hot_plate_temp;hot_plate_temp_initial_layer;eng_plate_temp;eng_plate_temp_initial_layer'),
    'printable_area;printable_height;extruder_printable_area;extruder_printable_height;bed_exclude_area;wrapping_exclude_area',
  ]
  return JSON.stringify(settings, null, 2)
}
