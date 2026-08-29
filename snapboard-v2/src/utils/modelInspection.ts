// ============ 导入模型元数据读取：尺寸 + 多对象选择 ============
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js'

export interface ModelDimensionsMm {
  x: number
  y: number
  z: number
}

export interface ModelObjectOption {
  path: string
  label: string
  dimensionsMm: ModelDimensionsMm
}

export interface ModelInspection {
  format: '3mf' | 'stl' | 'glb' | 'gltf'
  dimensionsMm: ModelDimensionsMm
  objects: ModelObjectOption[]
}

const extensionOf = (name: string): ModelInspection['format'] => {
  const ext = name.toLowerCase().split('.').pop()
  if (ext === '3mf' || ext === 'stl' || ext === 'glb' || ext === 'gltf') return ext
  throw new Error('暂不支持读取该模型的尺寸')
}

const scaleForFormat = (format: ModelInspection['format']) => format === 'glb' || format === 'gltf' ? 1000 : 1

const dimensionsFor = (object: THREE.Object3D, scale: number): ModelDimensionsMm => {
  object.updateWorldMatrix(true, true)
  const size = new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3()).multiplyScalar(scale)
  return { x: size.x, y: size.y, z: size.z }
}

const formatDimension = (value: number) => Math.max(0, Math.round(value * 10) / 10)

const hasMesh = (object: THREE.Object3D): boolean => {
  let found = false
  object.traverse(node => { if ((node as THREE.Mesh).isMesh) found = true })
  return found
}

const pathFor = (object: THREE.Object3D): string => {
  const indexes: number[] = []
  let current: THREE.Object3D | null = object
  while (current?.parent) {
    indexes.unshift(current.parent.children.indexOf(current))
    current = current.parent
  }
  return indexes.join('/')
}

const inspectObject = (object: THREE.Object3D, format: ModelInspection['format']): ModelInspection => {
  const scale = scaleForFormat(format)
  const dimensionsMm = dimensionsFor(object, scale)
  const objects = object.children
    .filter(child => hasMesh(child))
    .map((child, index) => ({
      path: pathFor(child),
      label: child.name?.trim() || `组件 ${index + 1}`,
      dimensionsMm: dimensionsFor(child, scale),
    }))
  return { format, dimensionsMm, objects: objects.length > 1 ? objects : [] }
}

const disposeObject = (object: THREE.Object3D | THREE.BufferGeometry) => {
  if (object instanceof THREE.BufferGeometry) {
    object.dispose()
    return
  }
  object.traverse(node => {
    const mesh = node as THREE.Mesh
    mesh.geometry?.dispose()
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []
    materials.forEach(material => material.dispose())
  })
}

const parseGltf = async (loader: GLTFLoader, data: ArrayBuffer): Promise<THREE.Object3D> => (await loader.parseAsync(data, '')).scene

/** 在浏览器本地读取模型包围盒，不上传文件；3MF 多顶层对象会给出可选渲染对象。 */
export async function inspectModelFile(file: File): Promise<ModelInspection> {
  const format = extensionOf(file.name)
  const data = await file.arrayBuffer()
  const stl = new STLLoader()
  const threeMf = new ThreeMFLoader()
  let object: THREE.Object3D
  if (format === 'stl') {
    object = new THREE.Mesh(stl.parse(data), new THREE.MeshBasicMaterial())
  } else if (format === '3mf') {
    object = threeMf.parse(data)
  } else {
    object = await parseGltf(new GLTFLoader(), data)
  }
  try {
    const inspection = inspectObject(object, format)
    inspection.dimensionsMm = {
      x: formatDimension(inspection.dimensionsMm.x),
      y: formatDimension(inspection.dimensionsMm.y),
      z: formatDimension(inspection.dimensionsMm.z),
    }
    inspection.objects = inspection.objects.map(option => ({
      ...option,
      dimensionsMm: {
        x: formatDimension(option.dimensionsMm.x),
        y: formatDimension(option.dimensionsMm.y),
        z: formatDimension(option.dimensionsMm.z),
      },
    }))
    return inspection
  } finally {
    disposeObject(object)
  }
}

export const dimensionsLabel = (dimensions: ModelDimensionsMm | undefined) => dimensions
  ? `${formatDimension(dimensions.x)} × ${formatDimension(dimensions.y)} × ${formatDimension(dimensions.z)} mm`
  : '尺寸读取中…'
