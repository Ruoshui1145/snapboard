// ============ GLB 零件加载器 — 缓存 + 参数化变换 ============
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js'
import type { PartModelAssets, PartUnit } from '../partLibrary/types'

const gltfLoader = new GLTFLoader()
const stlLoader = new STLLoader()
const threeMFLoader = new ThreeMFLoader()
const cache = new Map<string, Promise<THREE.Object3D>>()

const unitToMM = (unit: PartUnit | undefined): number => {
  if (unit === 'meter') return 1000
  if (unit === 'centimeter') return 10
  if (unit === 'inch') return 25.4
  return 1
}

/** 缓存模板的 geometry/material 不能与实例共享，否则视口重建时 dispose 会破坏后续实例。 */
const cloneObject = (source: THREE.Object3D): THREE.Object3D => {
  const clone = source.clone(true)
  clone.traverse(node => {
    const mesh = node as THREE.Mesh
    if (mesh.geometry) mesh.geometry = mesh.geometry.clone()
    if (Array.isArray(mesh.material)) mesh.material = mesh.material.map(material => material.clone())
    else if (mesh.material) mesh.material = mesh.material.clone()
  })
  return clone
}

const selectRenderNode = (root: THREE.Object3D, path: string | undefined): THREE.Object3D => {
  if (!path) return root
  let current = root
  for (const segment of path.split('/')) {
    const index = Number(segment)
    if (!Number.isInteger(index) || !current.children[index]) return root
    current = current.children[index]
  }
  current.removeFromParent()
  return current
}

async function loadRawModel(url: string): Promise<THREE.Object3D> {
  const clean = url.split(/[?#]/)[0].toLowerCase()
  if (clean.endsWith('.glb') || clean.endsWith('.gltf')) return (await gltfLoader.loadAsync(url)).scene
  if (clean.endsWith('.3mf')) return threeMFLoader.loadAsync(url)
  if (clean.endsWith('.stl')) {
    const geometry = await stlLoader.loadAsync(url)
    geometry.computeVertexNormals()
    return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xb9c3d0, roughness: 0.72, metalness: 0.05 }))
  }
  throw new Error(`暂不支持的零件预览格式: ${url}`)
}

/**
 * 加载 GLB 零件 (带缓存)
 * @param url public/partLibrary/models/ 下的相对路径
 */
export async function loadPartModel(url: string, model: PartModelAssets = {}): Promise<THREE.Object3D> {
  if (!cache.has(url)) cache.set(url, loadRawModel(url))
  let raw = cloneObject(await cache.get(url)!)
  raw = selectRenderNode(raw, model.renderNode)
  const scale = unitToMM(model.unit) * (model.scale ?? 1)
  raw.scale.multiplyScalar(scale)
  // SnapBoard 世界坐标 Y 向上；SolidWorks 3MF/STL 通常以 Z 为上。
  if (model.upAxis === 'z') raw.rotation.x = -Math.PI / 2
  else if (model.upAxis === 'x') raw.rotation.z = Math.PI / 2

  // 外层专门承载用户标定朝向；锚点也以这个外层的局部 mm 坐标保存。
  // 把朝向节点的枢轴放到变换后网格的几何中心，避免 STL/3MF 原点偏离模型时
  // 旋转会把零件甩出相机视野。根对象仍保持在 (0,0,0)，不会改变锚点坐标语义。
  raw.updateMatrixWorld(true)
  const rawBounds = new THREE.Box3().setFromObject(raw)
  const rawCenter = rawBounds.getCenter(new THREE.Vector3())
  const obj = new THREE.Group()
  const orientationNode = new THREE.Group()
  orientationNode.name = 'model-default-orientation'
  orientationNode.position.copy(rawCenter)
  raw.position.sub(rawCenter)
  orientationNode.add(raw)
  obj.add(orientationNode)
  const orientation = model.orientation ?? [0, 0, 0]
  orientationNode.rotation.set(
    THREE.MathUtils.degToRad(orientation[0]),
    THREE.MathUtils.degToRad(orientation[1]),
    THREE.MathUtils.degToRad(orientation[2]),
  )
  obj.userData.partModel = {
    url,
    unit: model.unit ?? 'millimeter',
    scale,
    upAxis: model.upAxis ?? 'y',
    orientation,
  }
  obj.userData.orientationNode = orientationNode
  return obj
}

/**
 * 加载制造模型并保持其打印坐标系。3MF/STL 通常已经是 Z 向上；GLB/GLTF 若为
 * Y/X 向上则只转换到 Z 向上，不应用装配标定朝向。
 */
export async function loadPrintablePartModel(url: string, model: PartModelAssets = {}): Promise<THREE.Object3D> {
  if (!cache.has(url)) cache.set(url, loadRawModel(url))
  let raw = cloneObject(await cache.get(url)!)
  raw = selectRenderNode(raw, model.renderNode)
  raw.scale.multiplyScalar(unitToMM(model.unit) * (model.scale ?? 1))
  if (model.upAxis === 'y') raw.rotation.x = Math.PI / 2
  else if (model.upAxis === 'x') raw.rotation.y = -Math.PI / 2
  return raw
}

/**
 * 应用参数化变换到零件实例
 * 修改参数 → 变换 (scale/rotate/translate), 不重建网格
 */
export function applyPartParams(
  obj: THREE.Object3D,
  params: Record<string, number | string>,
  defParams: { id: string; default: number | string }[],
): void {
  // 计算缩放 (相对于默认值)
  let scaleX = 1, scaleY = 1, scaleZ = 1

  for (const p of defParams) {
    const val = params[p.id] ?? p.default
    const def = p.default
    if (typeof val === 'number' && typeof def === 'number' && def !== 0) {
      const ratio = val / def
      // 简化: 单参数缩放 (具体零件可自定义变换逻辑)
      // 实际实现中每个零件可有自定义 applyTransform 函数
      if (p.id === 'length') scaleY = ratio
      if (p.id === 'diameter') { scaleX = ratio; scaleZ = ratio }
    }
  }

  obj.scale.set(scaleX, scaleY, scaleZ)
}
