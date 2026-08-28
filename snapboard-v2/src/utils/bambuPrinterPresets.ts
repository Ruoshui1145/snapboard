import type { PrintBedKeepout, SplitConfig } from '../types/geometry'

export interface BambuPrinterPreset {
  id: string
  label: string
  model: string
  profile: string
  bedW: number
  bedH: number
  printableHeight: number
  defaultPrintProfile: string
  defaultFilamentProfile: string
  keepouts: PrintBedKeepout[]
  extruderPrintableArea?: string[]
  extruderCount?: number
}

const frontLeftKeepout = (): PrintBedKeepout[] => [{
  id: 'bambu-front-left', name: '前左擦嘴/机构禁放区', x: 0, y: 0, w: 18, h: 28, enabled: true,
}]

/** 来自本机 Bambu Studio 02.08 的 BBL machine profiles（0.4 mm 喷嘴）。 */
export const BAMBU_PRINTER_PRESETS: BambuPrinterPreset[] = [
  { id: 'bambu-p1s', label: 'Bambu P1S', model: 'Bambu Lab P1S', profile: 'Bambu Lab P1S 0.4 nozzle', bedW: 256, bedH: 256, printableHeight: 256, defaultPrintProfile: '0.20mm Standard @BBL X1C', defaultFilamentProfile: 'Bambu PETG HF @BBL P1S 0.4 nozzle', keepouts: frontLeftKeepout() },
  { id: 'bambu-p1p', label: 'Bambu P1P', model: 'Bambu Lab P1P', profile: 'Bambu Lab P1P 0.4 nozzle', bedW: 256, bedH: 256, printableHeight: 256, defaultPrintProfile: '0.20mm Standard @BBL P1P', defaultFilamentProfile: 'Bambu PETG HF @BBL P1P 0.4 nozzle', keepouts: frontLeftKeepout() },
  { id: 'bambu-p2s', label: 'Bambu P2S', model: 'Bambu Lab P2S', profile: 'Bambu Lab P2S 0.4 nozzle', bedW: 256, bedH: 256, printableHeight: 256, defaultPrintProfile: '0.20mm Standard @BBL P2S', defaultFilamentProfile: 'Bambu PETG HF @BBL P2S 0.4 nozzle', keepouts: [] },
  { id: 'bambu-x1c', label: 'Bambu X1 Carbon', model: 'Bambu Lab X1 Carbon', profile: 'Bambu Lab X1 Carbon 0.4 nozzle', bedW: 256, bedH: 256, printableHeight: 256, defaultPrintProfile: '0.20mm Standard @BBL X1C', defaultFilamentProfile: 'Bambu PETG HF @BBL X1C', keepouts: frontLeftKeepout() },
  { id: 'bambu-x1', label: 'Bambu X1', model: 'Bambu Lab X1', profile: 'Bambu Lab X1 0.4 nozzle', bedW: 256, bedH: 256, printableHeight: 256, defaultPrintProfile: '0.20mm Standard @BBL X1C', defaultFilamentProfile: 'Bambu PETG HF @BBL X1C', keepouts: frontLeftKeepout() },
  { id: 'bambu-x1e', label: 'Bambu X1E', model: 'Bambu Lab X1E', profile: 'Bambu Lab X1E 0.4 nozzle', bedW: 256, bedH: 256, printableHeight: 256, defaultPrintProfile: '0.20mm Standard @BBL X1C', defaultFilamentProfile: 'Bambu PETG HF @BBL X1C', keepouts: frontLeftKeepout() },
  { id: 'bambu-a1', label: 'Bambu A1', model: 'Bambu Lab A1', profile: 'Bambu Lab A1 0.4 nozzle', bedW: 256, bedH: 256, printableHeight: 256, defaultPrintProfile: '0.20mm Standard @BBL A1', defaultFilamentProfile: 'Bambu PETG HF @BBL A1', keepouts: [] },
  { id: 'bambu-a1-mini', label: 'Bambu A1 mini', model: 'Bambu Lab A1 mini', profile: 'Bambu Lab A1 mini 0.4 nozzle', bedW: 180, bedH: 180, printableHeight: 180, defaultPrintProfile: '0.20mm Standard @BBL A1M', defaultFilamentProfile: 'Bambu PETG HF @BBL A1M', keepouts: [] },
  { id: 'bambu-h2s', label: 'Bambu H2S', model: 'Bambu Lab H2S', profile: 'Bambu Lab H2S 0.4 nozzle', bedW: 340, bedH: 320, printableHeight: 340, defaultPrintProfile: '0.20mm Standard @BBL H2S', defaultFilamentProfile: 'Bambu PETG HF @BBL H2S', keepouts: [] },
  { id: 'bambu-h2d', label: 'Bambu H2D', model: 'Bambu Lab H2D', profile: 'Bambu Lab H2D 0.4 nozzle', bedW: 350, bedH: 320, printableHeight: 325, defaultPrintProfile: '0.20mm Standard @BBL H2D', defaultFilamentProfile: 'Bambu PETG HF @BBL H2D 0.4 nozzle', keepouts: [], extruderCount: 2, extruderPrintableArea: ['0x0,325x0,325x320,0x320', '25x0,350x0,350x320,25x320'] },
  { id: 'bambu-h2d-pro', label: 'Bambu H2D Pro', model: 'Bambu Lab H2D Pro', profile: 'Bambu Lab H2D Pro 0.4 nozzle', bedW: 350, bedH: 320, printableHeight: 325, defaultPrintProfile: '0.20mm Standard @BBL H2D', defaultFilamentProfile: 'Bambu PETG HF @BBL H2DP 0.4 nozzle', keepouts: [], extruderCount: 2, extruderPrintableArea: ['0x0,325x0,325x320,0x320', '25x0,350x0,350x320,25x320'] },
  { id: 'bambu-h2c', label: 'Bambu H2C', model: 'Bambu Lab H2C', profile: 'Bambu Lab H2C 0.4 nozzle', bedW: 330, bedH: 320, printableHeight: 325, defaultPrintProfile: '0.20mm Standard @BBL H2C', defaultFilamentProfile: 'Bambu PETG HF @BBL H2C', keepouts: [], extruderCount: 2, extruderPrintableArea: ['0x0,325x0,325x320,0x320', '25x0,330x0,330x320,25x320'] },
  { id: 'bambu-a2l', label: 'Bambu A2L', model: 'Bambu Lab A2L', profile: 'Bambu Lab A2L 0.4 nozzle', bedW: 330, bedH: 320, printableHeight: 325, defaultPrintProfile: '0.20mm Standard @BBL A2L', defaultFilamentProfile: 'Bambu PETG HF @BBL A2L', keepouts: [] },
  { id: 'bambu-x2d', label: 'Bambu X2D', model: 'Bambu Lab X2D', profile: 'Bambu Lab X2D 0.4 nozzle', bedW: 256, bedH: 256, printableHeight: 261, defaultPrintProfile: '0.20mm Standard @BBL X2D', defaultFilamentProfile: 'Bambu PETG HF @BBL X2D 0.4 nozzle', keepouts: [], extruderCount: 2, extruderPrintableArea: ['0x0,256x0,256x256,0x256', '20.5x0,256x0,256x256,20.5x256'] },
]

export const DEFAULT_BAMBU_PRINTER_PRESET = 'bambu-p1s'

export function getBambuPrinterPreset(id: string | undefined): BambuPrinterPreset {
  return BAMBU_PRINTER_PRESETS.find(preset => preset.id === id) ?? BAMBU_PRINTER_PRESETS[0]
}

export function splitConfigForPrinter(id: string): Partial<SplitConfig> {
  const preset = getBambuPrinterPreset(id)
  return {
    printerPreset: preset.id,
    bedW: preset.bedW,
    bedH: preset.bedH,
    bedMarginLeft: 0,
    bedMarginRight: 0,
    bedMarginBottom: 0,
    bedMarginTop: 0,
    bedKeepouts: preset.keepouts.map(zone => ({ ...zone })),
  }
}
