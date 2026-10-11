import type { SplitConfig, SplitPanel, BoardTextureConfig } from '../types/geometry'
import { summarizeSnapBoardProject } from '../../../apps/order-workbench/shared/domain.mjs'

/** A production-only catalog lets an existing file populate a new order without a pre-existing order number. */
export function manufacturingCatalog(panels: SplitPanel[], cfg: SplitConfig, texture?: BoardTextureConfig) {
  const summary = summarizeSnapBoardProject({format:'snapboard-project',schemaVersion:1,workspace:{splitResult:{panels},splitConfig:cfg,boardTexture:texture,spatialLayout:{enabled:false}}},'制造文件',{allowEmpty:true})
  return {format:'snapboard-manufacturing-catalog',schemaVersion:1,kitQuantity:1,product:{layoutCode:summary.product.layoutCode,mappingCode:summary.product.mappingCode,colourCode:summary.product.colourCode,widthMm:summary.product.widthMm,heightMm:summary.product.heightMm,thicknessMm:cfg.thickness,material:texture?.surfaceMode === 'woodgrain' ? texture.woodGrain?.filamentType || 'PETG' : 'PETG',profile:summary.product.profile},panels:summary.panels.map(({code,quantity,widthMm,heightMm,sourcePanelId})=>({code,quantity,widthMm,heightMm,sourcePanelId}))}
}

export function orderManufacturingCatalog(panels: SplitPanel[], cfg: SplitConfig, texture: BoardTextureConfig | undefined,
  plan: {kitQuantity:number;panels:Array<{panelCode:string;sourcePanelId:string}>}) {
  const catalog=manufacturingCatalog(panels,cfg,texture)
  const quantities=new Map<string,number>(),codes=new Map<string,string>()
  for(const instance of plan.panels){quantities.set(instance.sourcePanelId,(quantities.get(instance.sourcePanelId) || 0)+1);codes.set(instance.sourcePanelId,instance.panelCode)}
  return {...catalog,kitQuantity:plan.kitQuantity,panels:catalog.panels.map(panel=>({...panel,
    code:codes.get(panel.sourcePanelId)!,quantity:quantities.get(panel.sourcePanelId)!/plan.kitQuantity}))}
}
