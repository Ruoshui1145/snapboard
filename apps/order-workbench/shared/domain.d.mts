export interface OrderProjectSummary {
  product: { name: string; layoutCode: string; mappingCode: string; colourCode: string; thicknessMm: number; widthMm: number;
    heightMm: number; material: string; profile: string; projectFile: string; notes: string }
  panels: Array<{ code: string; quantity: number; widthMm: number; heightMm: number; depthMm?: number; sourcePanelId: string; notes: string }>
  warning: string
  designFingerprint?: string
}
export function summarizeSnapBoardProject(input: unknown, filename: string, options?: { allowEmpty?: boolean }): OrderProjectSummary
