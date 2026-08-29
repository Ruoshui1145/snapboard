import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { partPreviewPath, type PartDefinition } from '../../partLibrary/types'
import { loadPartModel } from '../../utils/glbLoader'
import { dimensionsLabel } from '../../utils/modelInspection'

const PRESETS = [
  { id: 'install', label: '装配效果', direction: [0.72, 0.48, 1.65] as [number, number, number] },
  { id: 'front', label: '正面', direction: [0, 0.12, 1] as [number, number, number] },
  { id: 'top', label: '顶部', direction: [0.08, 1, 0.2] as [number, number, number] },
  { id: 'side', label: '侧面', direction: [1, 0.16, 0.18] as [number, number, number] },
]

const disposeObject = (object: THREE.Object3D) => {
  object.traverse(node => {
    const mesh = node as THREE.Mesh
    mesh.geometry?.dispose()
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []
    materials.forEach(material => material.dispose())
  })
}

interface Props {
  part: PartDefinition
  onClose: () => void
  onEdit: () => void
  onSaved: () => void
}

export function PartPreviewDialog({ part, onClose, onEdit, onSaved }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const controlsRef = useRef<OrbitControls | null>(null)
  const radiusRef = useRef(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const preview = partPreviewPath(part)

  useEffect(() => {
    const host = hostRef.current
    if (!host || !preview) return
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x101624)
    const camera = new THREE.PerspectiveCamera(38, Math.max(1, host.clientWidth) / Math.max(1, host.clientHeight), 0.01, 100000)
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.05
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight))
    host.appendChild(renderer.domElement)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.screenSpacePanning = true
    cameraRef.current = camera
    controlsRef.current = controls
    scene.add(new THREE.HemisphereLight(0xffffff, 0x1c2538, 2.2))
    const key = new THREE.DirectionalLight(0xffffff, 3)
    key.position.set(3, 4, 5)
    scene.add(key)
    const rim = new THREE.DirectionalLight(0x6ce4d3, 1.1)
    rim.position.set(-4, 2, -3)
    scene.add(rim)
    const grid = new THREE.GridHelper(600, 30, 0x264966, 0x1a2b40)
    grid.position.y = -80
    scene.add(grid)

    let model: THREE.Object3D | null = null
    let cancelled = false
    loadPartModel(`/partLibrary/${preview}`, part.model).then(object => {
      if (cancelled) { disposeObject(object); return }
      model = object
      scene.add(object)
      object.updateWorldMatrix(true, true)
      const box = new THREE.Box3().setFromObject(object)
      const center = box.getCenter(new THREE.Vector3())
      const size = box.getSize(new THREE.Vector3())
      const radius = Math.max(size.length() * .5, 1)
      radiusRef.current = radius
      controls.target.copy(center)
      const initial = new THREE.Vector3(...(part.model.previewDirection ?? PRESETS[0].direction)).normalize()
      camera.position.copy(center).addScaledVector(initial, radius * 3.1)
      camera.near = Math.max(.001, radius / 100)
      camera.far = radius * 30
      camera.updateProjectionMatrix()
      controls.update()
    }).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))

    let raf = 0
    const render = () => {
      raf = requestAnimationFrame(render)
      controls.update()
      renderer.render(scene, camera)
    }
    render()
    const resize = () => {
      const width = Math.max(1, host.clientWidth)
      const height = Math.max(1, host.clientHeight)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      renderer.setSize(width, height)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      observer.disconnect()
      controls.dispose()
      if (model) disposeObject(model)
      renderer.dispose()
      if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement)
      cameraRef.current = null
      controlsRef.current = null
    }
  }, [part, preview])

  const applyPreset = (direction: [number, number, number]) => {
    const camera = cameraRef.current
    const controls = controlsRef.current
    if (!camera || !controls) return
    camera.position.copy(controls.target).addScaledVector(new THREE.Vector3(...direction).normalize(), radiusRef.current * 3.1)
    camera.lookAt(controls.target)
    controls.update()
  }

  const saveCurrentView = async () => {
    const camera = cameraRef.current
    const controls = controlsRef.current
    if (!camera || !controls || !part.packageId || !part.localId) return
    const direction = camera.position.clone().sub(controls.target).normalize().toArray()
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/part-library/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packageId: part.packageId, localId: part.localId, direction }),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error || `保存失败 (HTTP ${response.status})`)
      window.dispatchEvent(new Event('snapboard:part-library-updated'))
      onSaved()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const dimensions = part.model.dimensionsMm
    ? dimensionsLabel({ x: part.model.dimensionsMm[0], y: part.model.dimensionsMm[1], z: part.model.dimensionsMm[2] })
    : '未记录'
  const usageImage = part.model.usageImage ? `/partLibrary/${part.model.usageImage}` : null

  return createPortal(
    <div className="part-preview-backdrop" role="presentation" onPointerDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <section className="part-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="part-preview-title">
        <header>
          <span><b id="part-preview-title">{part.name}</b><small>拖动旋转 · 滚轮缩放 · 双指操作</small></span>
          <button type="button" onClick={onClose} aria-label="关闭">×</button>
        </header>
        <div className="part-preview-layout">
          <div className="part-preview-stage">
            <div ref={hostRef} className="part-preview-canvas" />
            <div className="part-preview-presets" aria-label="常用展示视角">
              {PRESETS.map(preset => <button key={preset.id} type="button" onClick={() => applyPreset(preset.direction)}>{preset.label}</button>)}
            </div>
          </div>
          <aside className="part-preview-details">
            <div className="part-preview-meta"><span>模型尺寸</span><b>{dimensions}</b></div>
            <div className="part-preview-meta"><span>格式与状态</span><b>{part.model.format?.toUpperCase() ?? '模型'} · {part.model.renderNode ? '仅显示主体' : '完整模型'}</b></div>
            <p>{part.description || '暂未填写用途说明。'}</p>
            <section className="part-preview-usage">
              <span>实际安装效果</span>
              {usageImage ? <img src={usageImage} alt={`${part.name} 实装示例`} /> : <button type="button" onClick={onEdit}>＋ 添加实装照片</button>}
            </section>
            <button type="button" className="part-preview-edit" onClick={onEdit}>编辑资料与展示</button>
          </aside>
        </div>
        {error && <div className="part-import-error">{error}</div>}
        <footer>
          <span>把模型转到最容易看懂的角度，再保存为卡片封面。</span>
          <button type="button" onClick={() => void saveCurrentView()} disabled={busy || Boolean(part.thumbnail)}>{part.thumbnail ? '当前使用固定封面图' : busy ? '正在保存…' : '保存当前角度为封面'}</button>
        </footer>
      </section>
    </div>,
    document.body,
  )
}
