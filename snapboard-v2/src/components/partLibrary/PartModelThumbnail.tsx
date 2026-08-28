import { useEffect, useState } from 'react'
import * as THREE from 'three'
import { loadPartModel } from '../../utils/glbLoader'
import { partPreviewPath, type PartDefinition } from '../../partLibrary/types'

const thumbnailCache = new Map<string, Promise<string>>()
let renderQueue = Promise.resolve()

const disposeObject = (object: THREE.Object3D) => {
  object.traverse(node => {
    const mesh = node as THREE.Mesh
    mesh.geometry?.dispose()
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []
    materials.forEach(material => material.dispose())
  })
}

const renderModelThumbnail = (part: PartDefinition, preview: string) => {
  const key = `${preview}|${part.model.orientation?.join(',') ?? ''}|${part.model.scale ?? 1}`
  if (thumbnailCache.has(key)) return thumbnailCache.get(key)!
  const queued = renderQueue.then(async () => {
    const model = await loadPartModel(`/partLibrary/${preview}`, part.model)
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(34, 1, 0.01, 100000)
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
    renderer.setPixelRatio(1)
    renderer.setSize(180, 180, false)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.setClearColor(0x000000, 0)
    scene.add(new THREE.HemisphereLight(0xffffff, 0x20283b, 2.4))
    const keyLight = new THREE.DirectionalLight(0xffffff, 3.1)
    keyLight.position.set(2, 3, 4)
    scene.add(keyLight)
    const rimLight = new THREE.DirectionalLight(0x7cebd7, 1.2)
    rimLight.position.set(-3, 1, -2)
    scene.add(rimLight)
    scene.add(model)
    scene.updateMatrixWorld(true)

    const box = new THREE.Box3().setFromObject(model)
    const center = box.getCenter(new THREE.Vector3())
    const dimensions = box.getSize(new THREE.Vector3())
    const radius = Math.max(dimensions.length() * 0.5, 1)
    const direction = new THREE.Vector3(0.72, 0.48, 1.65).normalize()
    camera.position.copy(center).addScaledVector(direction, radius * 3.15)
    camera.near = Math.max(0.001, radius / 100)
    camera.far = radius * 20
    camera.lookAt(center)
    camera.updateProjectionMatrix()
    renderer.render(scene, camera)
    const dataUrl = renderer.domElement.toDataURL('image/png')
    disposeObject(model)
    renderer.dispose()
    renderer.forceContextLoss()
    return dataUrl
  })
  renderQueue = queued.then(() => undefined, () => undefined)
  thumbnailCache.set(key, queued)
  return queued
}

const categoryIcon = (part: PartDefinition) =>
  part.category === 'hook' ? '🪝' : part.category === 'bracket' ? '📐' : part.category === 'base' ? '🦶' : '🔩'

export function PartModelThumbnail({ part }: { part: PartDefinition }) {
  const preview = partPreviewPath(part)
  const [image, setImage] = useState<string | null>(part.thumbnail ? `/partLibrary/${part.thumbnail}` : null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (part.thumbnail || !preview) return
    let alive = true
    setFailed(false)
    renderModelThumbnail(part, preview)
      .then(url => { if (alive) setImage(url) })
      .catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [part, preview])

  if (image) return <img src={image} alt={`${part.name} 模型预览`} />
  return <span className={failed ? 'failed' : 'loading'}>{failed ? categoryIcon(part) : '◌'}</span>
}
