import { strToU8, zipSync } from 'fflate'
import { createSnapBoardAttribution, serializeSnapBoardAttribution } from './snapboardAttribution'
import type { SplitConfig } from '../types/geometry'
import { PEGBOARD_DEFAULT_CONFIG } from './pegboardSplit'
import { BAMBU_COMPAT_VERSION, bambuProjectSettingsJson } from './export3mf'
import { Z_TOP_LAYER_HEIGHT_MM, Z_TOP_FINISH_DEPTH_MM } from './bambuPrintProfile'
import { manufacturingHeightRanges } from './textureLayerDepths'

export interface SpatialMesh3MF {
  name: string
  /** Packed xyz triples in millimetres. */
  vertices: Float32Array | number[]
  /** Packed zero-based vertex index triples. */
  triangles: Uint32Array | number[]
}

const xml = (value: string) => value.replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
})[char]!)

/** Small standards-compliant 3MF for non-planar solids; flat panels use the main Bambu exporter. */
export function writeSpatial3MF(meshes: SpatialMesh3MF[], projectName: string, metadata: Record<string, Uint8Array> = {}, cfg:SplitConfig=PEGBOARD_DEFAULT_CONFIG): Uint8Array {
  if (!meshes.length) throw new Error('没有可导出的立体实体')
  const layerRanges:string[]=[]
  const resources = meshes.map((mesh, index) => {
    if (!mesh.vertices.length || !mesh.triangles.length || mesh.vertices.length % 3 || mesh.triangles.length % 3) {
      throw new Error(`${mesh.name} 的网格顶点或三角面无效`)
    }
    const vertices: string[] = []
    const triangles: string[] = []
    let lo=Infinity,hi=-Infinity
    for (let i = 0; i < mesh.vertices.length; i += 3) {
      const x = mesh.vertices[i], y = mesh.vertices[i + 1], z = mesh.vertices[i + 2]
      if (![x, y, z].every(Number.isFinite)) throw new Error(`${mesh.name} 含非有限坐标`)
      lo=Math.min(lo,z);hi=Math.max(hi,z)
      vertices.push(`<vertex x="${x.toFixed(5)}" y="${y.toFixed(5)}" z="${z.toFixed(5)}"/>`)
    }
    const count = mesh.vertices.length / 3
    for (let i = 0; i < mesh.triangles.length; i += 3) {
      const a = mesh.triangles[i], b = mesh.triangles[i + 1], c = mesh.triangles[i + 2]
      if (![a, b, c].every(vertex => Number.isInteger(vertex) && vertex >= 0 && vertex < count)) {
        throw new Error(`${mesh.name} 含越界三角面`)
      }
      triangles.push(`<triangle v1="${a}" v2="${b}" v3="${c}"/>`)
    }
    const ranges=manufacturingHeightRanges([{lo,hi,height:.28}],{depth:Z_TOP_FINISH_DEPTH_MM,height:Z_TOP_LAYER_HEIGHT_MM},.25)
    layerRanges.push(`<object id="${index+1}">${ranges.map(range=>`<range min_z="${range.lo}" max_z="${range.hi}"><option opt_key="layer_height">${range.height}</option></range>`).join('')}</object>`)
    return `<object id="${index + 1}" name="${xml(mesh.name)}" type="model"><mesh><vertices>${vertices.join('')}</vertices><triangles>${triangles.join('')}</triangles></mesh></object>`
  })
  const title = projectName.trim() || 'SnapBoard 立体版面'
  const attribution = createSnapBoardAttribution({ projectName: title })
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">BambuStudio-${BAMBU_COMPAT_VERSION}</metadata><metadata name="Title">${xml(title)}</metadata><metadata name="Generator">SnapBoard</metadata><metadata name="SnapBoard:SourceRecordId">${xml(attribution.sourceRecordId)}</metadata><metadata name="SnapBoard:OriginUrl">${xml(attribution.originUrl)}</metadata><metadata name="SnapBoard:PublicationNotice">${xml(attribution.publicationNotice)}</metadata><metadata name="SnapBoard:Authenticity">${attribution.authenticity}</metadata><resources>${resources.join('')}</resources><build>${meshes.map((_, index) => `<item objectid="${index + 1}"/>`).join('')}</build></model>`
  const types = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="config" ContentType="text/xml"/><Default Extension="xml" ContentType="text/xml"/><Default Extension="json" ContentType="application/json"/></Types>'
  const rels = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'
  return zipSync({
    '[Content_Types].xml': strToU8(types), '_rels/.rels': strToU8(rels),
    '3D/3dmodel.model': strToU8(model),
    'Metadata/project_settings.config':strToU8(bambuProjectSettingsJson(cfg,['#3EC6B0'],undefined,.25)),
    'Metadata/layer_config_ranges.xml':strToU8(`<?xml version="1.0" encoding="UTF-8"?><objects>${layerRanges.join('')}</objects>`),
    'Metadata/model_settings.config':strToU8(`<?xml version="1.0" encoding="UTF-8"?><config>${meshes.map((mesh,index)=>`<object id="${index+1}"><metadata key="name" value="${xml(mesh.name)}"/><metadata key="extruder" value="1"/><metadata key="layer_height" value="0.28"/><metadata face_count="${mesh.triangles.length/3}"/><part id="${index+1}" subtype="normal_part"><metadata key="name" value="${xml(mesh.name)}"/><metadata key="extruder" value="1"/><mesh_stat face_count="${mesh.triangles.length/3}" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/></part></object>`).join('')}<plate><metadata key="plater_id" value="1"/><metadata key="plater_name" value="SnapBoard 立体板件"/>${meshes.map((_,index)=>`<model_instance><metadata key="object_id" value="${index+1}"/><metadata key="instance_id" value="0"/><metadata key="identify_id" value="${index+1}"/></model_instance>`).join('')}</plate><assemble/></config>`),
    ...metadata,
    'Metadata/snapboard-attribution.json': strToU8(serializeSnapBoardAttribution(attribution)),
  })
}
