import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { loadPartModel } from '../../utils/glbLoader'
import { partPreviewPath, type PartDefinition } from '../../partLibrary/types'

const thumbnailCache = new Map<string, Promise<string>>()
let renderQueue = Promise.resolve()
const DEFAULT_DIRECTION = new THREE.Vector3(0.72, 0.48, 1.65).normalize()

const disposeObject = (object: THREE.Object3D) => {
  object.traverse(node => {
    const mesh = node as THREE.Mesh
    mesh.geometry?.dispose()
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []
    materials.forEach(material => material.dispose())
  })
}

const thumbnailDirection = (part: PartDefinition) => {
  const saved = part.model.previewDirection
  if (!saved || saved.length !== 3) return DEFAULT_DIRECTION
  const direction = new THREE.Vector3(...saved)
  return direction.lengthSq() > 0.01 ? direction.normalize() : DEFAULT_DIRECTION
}

const renderModelThumbnail = (part: PartDefinition, preview: string) => {
  const key = `${preview}|${part.model.orientation?.join(',') ?? ''}|${part.model.scale ?? 1}|${part.model.renderNode ?? ''}|${part.model.previewDirection?.join(',') ?? 'default'}`
  if (thumbnailCache.has(key)) return thumbnailCache.get(key)!
  const queued = renderQueue.then(async () => {
    const model = await loadPartModel(`/partLibrary/${preview}`, part.model)
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(34, 1, 0.01, 100000)
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
    renderer.setPixelRatio(1)
    renderer.setSize(180, 180, false)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.05
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
    camera.position.copy(center).addScaledVector(thumbnailDirection(part), radius * 3.15)
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

/** 卡片缩略图保持纯展示；视角编辑在大预览弹窗中完成。 */
export function PartModelThumbnail({ part }: { part: PartDefinition }) {
  const preview = partPreviewPath(part)
  const [image, setImage] = useState<string | null>(part.thumbnail ? `/partLibrary/${part.thumbnail}` : null)
  const [failed, setFailed] = useState(false)
  const [visible, setVisible] = useState(Boolean(part.thumbnail))
  const hostRef = useRef<HTMLSpanElement>(null)

  // 资源同步可能把“实装照片误当封面”的旧 thumbnail 清掉；同步后立即切回
  // 模型渲染缩略图，避免旧的 <img> 状态在卡片上继续残留。
  useEffect(() => {
    setImage(part.thumbnail ? `/partLibrary/${part.thumbnail}` : null)
    setFailed(false)
    if (part.thumbnail) setVisible(true)
  }, [part.thumbnail])

  // 配件库可能有几十到上百个模型；只有进入视口附近才创建 WebGL 缩略图，
  // 避免首次打开面板时一次性排队加载所有 STL/GLB 并占满主线程与显存。
  useEffect(() => {
    if (part.thumbnail || visible || !hostRef.current) return
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setVisible(true)
        observer.disconnect()
      }
    }, { root: null, rootMargin: '240px 0px', threshold: 0.01 })
    observer.observe(hostRef.current)
    return () => observer.disconnect()
  }, [part.thumbnail, visible])

  useEffect(() => {
    if (part.thumbnail || !preview || !visible) return
    let alive = true
    renderModelThumbnail(part, preview)
      .then(url => { if (alive) setImage(url) })
      .catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [part, preview, visible])

  if (image) return <img src={image} alt={`${part.name} 模型预览`} />
  return <span ref={hostRef} className={failed ? 'failed' : 'loading'} aria-busy={!visible || undefined}>{failed ? categoryIcon(part) : visible ? '◌' : '○'}</span>
}
