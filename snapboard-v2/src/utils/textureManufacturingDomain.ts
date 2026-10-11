import type {MultiPolygon} from 'polygon-clipping'
import {texturePolygon as pc,insetTexturePolygon} from './texturePolygon'
export const insetTextureDomain=insetTexturePolygon

/** Coupons inherit original edges; their cut edge must not gain a new seal. */
export function textureLayerDomains(panel: MultiPolygon, source: MultiPolygon, inset: number, sealWidth: number) {
  const effective = pc.intersection(panel, insetTextureDomain(source, inset))
  const color = pc.intersection(panel, insetTextureDomain(source, Math.max(inset, sealWidth)))
  const seal = sealWidth > inset ? pc.difference(effective, color) : []
  return { effective, color, seal }
}
