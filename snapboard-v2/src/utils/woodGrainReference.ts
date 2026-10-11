import { unzipSync, strFromU8, compressSync, decompressSync } from 'fflate'
import { Matrix4, Vector3 } from 'three'

export interface WoodModifierSource {
  name: string; author: string; license: string; data: string; sha256: string
  vertexCount: number; triangleCount: number
  transform: number[]; referenceCenter: number[]; bounds: number[]
  sliceBounds?: number[]
  globalSettings: Record<string, string>; modifierSettings: Record<string, string>
}
const decodeXml = (text: string) => text.replace(/&(?:amp|quot|apos|lt|gt);/g, value => ({
  '&amp;':'&', '&quot;':'"', '&apos;':"'", '&lt;':'<', '&gt;':'>',
})[value]!)
const attrs = (text: string) => Object.fromEntries([...text.matchAll(/([\w:]+)="([^"]*)"/g)].map(m => [m[1], decodeXml(m[2])]))
const identity = [1,0,0,0,1,0,0,0,1,0,0,0]
const vector = (value: unknown, length: number): value is number[] => Array.isArray(value) && value.length === length && value.every(n => typeof n === 'number' && Number.isFinite(n))
const processKeys = new Set(['layer_height','initial_layer_print_height','wall_loops','top_shell_layers','top_shell_thickness',
  'bottom_shell_layers','bottom_shell_thickness','top_surface_pattern','bottom_surface_pattern','infill_direction',
  'sparse_infill_density','sparse_infill_pattern','ironing_type','fuzzy_skin','fuzzy_skin_point_distance','fuzzy_skin_thickness'])
const settings = (value: unknown) => value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
  .filter(([key,v]) => processKeys.has(key) && typeof v === 'string' && v.length < 100)) as Record<string,string> : {}

const matrixFrom3MF = (m: number[]) => new Matrix4().set(m[0],m[3],m[6],m[9], m[1],m[4],m[7],m[10], m[2],m[5],m[8],m[11], 0,0,0,1)
function base64(bytes: Uint8Array): string {
  let result = ''; for (let i=0;i<bytes.length;i+=32768) result += String.fromCharCode(...bytes.subarray(i,i+32768))
  return btoa(result)
}
let cached: { data: string; vertices: Float64Array; triangles: Uint32Array } | undefined
export function woodModifierGeometry(source: WoodModifierSource) {
  if (cached?.data === source.data) return cached
  const expected = 8 + source.vertexCount * 24 + source.triangleCount * 12
  const raw = decompressSync(Uint8Array.from(atob(source.data), c=>c.charCodeAt(0)), { out: new Uint8Array(expected) })
  if (raw.length !== expected || raw.byteOffset % 8) throw new Error('原木纹修改器数据长度无效')
  const counts = new Uint32Array(raw.buffer,raw.byteOffset,2)
  if (counts[0] !== source.vertexCount || counts[1] !== source.triangleCount) throw new Error('原木纹修改器网格计数不一致')
  const vertices = new Float64Array(raw.buffer,raw.byteOffset+8,source.vertexCount*3)
  const triangles = new Uint32Array(raw.buffer,raw.byteOffset+8+source.vertexCount*24,source.triangleCount*3)
  if (vertices.some(n=>!Number.isFinite(n)) || triangles.some(n=>n>=source.vertexCount)) throw new Error('原木纹修改器含无效顶点或三角面')
  // ponytail: cache only the most recently imported mesh; add a bounded multi-source cache if projects require it.
  return cached = { data: source.data, vertices, triangles }
}

/** Preserve the original modifier. Do not sample, simplify or regenerate its wood pattern. */
export async function importWoodModifier(input: Uint8Array, fileName: string): Promise<WoodModifierSource> {
  if (input.length > 64*1024*1024) throw new Error('木纹 3MF 不能超过 64 MB')
  const zip = unzipSync(input,{ filter: entry => /^(3D\/|Metadata\/(model_settings|project_settings)\.config)/.test(entry.name) && entry.originalSize <= 160*1024*1024 })
  const root = strFromU8(zip['3D/3dmodel.model'] ?? new Uint8Array())
  const modelSettings = strFromU8(zip['Metadata/model_settings.config'] ?? new Uint8Array())
  const modifiers = [...modelSettings.matchAll(/<part\b([^>]*subtype="modifier_part"[^>]*)>([\s\S]*?)<\/part>/g)]
  if (modifiers.length !== 1) throw new Error('请选择包含一个原木纹修改器的 Bambu 3MF')
  const part = modifiers[0], id=attrs(part[1]).id
  if (!/^\d+$/.test(id)) throw new Error('木纹修改器对象 ID 无效')
  const component = [...root.matchAll(/<component\b([^>]*)\/?\s*>/g)].map(m=>attrs(m[1])).find(a=>a.objectid===id)
  if (!component) throw new Error('找不到原木纹修改器的装配引用')
  const path = (component['p:path'] || '/3D/3dmodel.model').replace(/^\//,'')
  const meshXml = strFromU8(zip[path] ?? new Uint8Array())
  const object = new RegExp(`<object\\b[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)<\\/object>`).exec(meshXml)?.[1]
  if (!object) throw new Error('找不到原木纹修改器网格')
  const vText=/<vertices>([\s\S]*?)<\/vertices>/.exec(object)?.[1]??'', tText=/<triangles>([\s\S]*?)<\/triangles>/.exec(object)?.[1]??''
  const vertexCount=(vText.match(/<vertex /g)??[]).length, triangleCount=(tText.match(/<triangle /g)??[]).length
  if (!vertexCount || vertexCount>2_000_000 || !triangleCount || triangleCount>4_000_000) throw new Error('原木纹修改器网格超出读取范围')
  const raw = new Uint8Array(8+vertexCount*24+triangleCount*12)
  new Uint32Array(raw.buffer,0,2).set([vertexCount,triangleCount])
  const vertices=new Float64Array(raw.buffer,8,vertexCount*3), triangles=new Uint32Array(raw.buffer,8+vertexCount*24,triangleCount*3)
  let index=0
  for (const m of vText.matchAll(/<vertex\b([^>]*)\/>/g)) { const a=attrs(m[1]); const p=[Number(a.x),Number(a.y),Number(a.z)]; if(p.some(n=>!Number.isFinite(n)))throw new Error('修改器顶点无效');vertices.set(p,index++*3) }
  index=0
  for (const m of tText.matchAll(/<triangle\b([^>]*)\/>/g)) { const a=attrs(m[1]);const p=[Number(a.v1),Number(a.v2),Number(a.v3)];if(p.some(n=>!Number.isInteger(n)||n<0||n>=vertexCount))throw new Error('修改器三角面无效');triangles.set(p,index++*3) }
  const transform=(component.transform||identity.join(' ')).trim().split(/\s+/).map(Number)
  if (!vector(transform,12)) throw new Error('原修改器姿态无效')
  const normal = [...root.matchAll(/<component\b([^>]*)\/?\s*>/g)].map(m=>attrs(m[1])).find(a=>a.objectid!==id)
  const referenceCenter = normal?.transform ? normal.transform.trim().split(/\s+/).slice(9,12).map(Number) : [0,0,0]
  const pose=matrixFrom3MF(transform), bounds=[Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity], point=new Vector3()
  const posed=new Float64Array(vertices.length)
  for(let i=0;i<vertices.length;i+=3){point.set(vertices[i],vertices[i+1],vertices[i+2]).applyMatrix4(pose);[point.x,point.y,point.z].forEach((n,j)=>{posed[i+j]=n;bounds[j]=Math.min(bounds[j],n);bounds[j+3]=Math.max(bounds[j+3],n)})}
  const sliceBounds=[Infinity,Infinity,-Infinity,-Infinity]
  for(let i=0;i<triangles.length;i+=3)for(let j=0;j<3;j++){
    const a=triangles[i+j]*3,b=triangles[i+(j+1)%3]*3,za=posed[a+2]-referenceCenter[2],zb=posed[b+2]-referenceCenter[2]
    if((za<0)===(zb<0))continue;const t=za/(za-zb)
    for(let axis=0;axis<2;axis++){const n=posed[a+axis]+t*(posed[b+axis]-posed[a+axis]);sliceBounds[axis]=Math.min(sliceBounds[axis],n);sliceBounds[axis+2]=Math.max(sliceBounds[axis+2],n)}
  }
  const metadata = Object.fromEntries([...part[2].matchAll(/<metadata\b([^>]*)\/>/g)].map(m=>{const a=attrs(m[1]);return[a.key,a.value]}))
  const global = JSON.parse(strFromU8(zip['Metadata/project_settings.config']??new Uint8Array()))
  const rootValue=(name:string)=>decodeXml(new RegExp(`<metadata name="${name}">([^<]*)<\\/metadata>`).exec(root)?.[1]??'')
  const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',input.slice().buffer)),b=>b.toString(16).padStart(2,'0')).join('')
  const source={ name: metadata.name||fileName, author:rootValue('Designer'), license:rootValue('License'), data:base64(compressSync(raw)),
    sha256,vertexCount,triangleCount,transform,referenceCenter,bounds,sliceBounds:vector(sliceBounds,4)?sliceBounds:undefined,globalSettings:settings(global),modifierSettings:settings(metadata) }
  woodModifierGeometry(source)
  return source
}
