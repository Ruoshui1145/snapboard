import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { partPreviewPath, type PartDefinition } from '../../partLibrary/types'
import { fitPartAnchors, type AssemblyTarget } from '../../utils/assemblySnap'
import { loadPartModel } from '../../utils/glbLoader'
import { dimensionsLabel } from '../../utils/modelInspection'
import { createCalibrationReferenceBoard } from './calibrationReferenceBoard'

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
  embedded?: boolean
  onExpand?: () => void
  part: PartDefinition
  onClose: () => void
  onEdit: () => void
  onCalibrate: () => void
  onSaved: () => void
}

type AssemblyPreviewPhase = 'ready' | 'inserting' | 'sliding' | 'locked'
type AssemblyPreviewPose = {
  inserted: THREE.Vector3
  locked: THREE.Vector3
  rotationZ: number
  focus: THREE.Vector3
}

export function PartPreviewDialog({ part, onClose, onEdit, onCalibrate, onSaved, embedded = false, onExpand }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const controlsRef = useRef<OrbitControls | null>(null)
  const modelRef = useRef<THREE.Object3D | null>(null)
  const boardRef = useRef<THREE.Group | null>(null)
  const modelCenterRef = useRef(new THREE.Vector3())
  const assemblyPoseRef = useRef<AssemblyPreviewPose | null>(null)
  const assemblyAnimationRef = useRef<number | null>(null)
  const radiusRef = useRef(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [assemblyPhase, setAssemblyPhase] = useState<AssemblyPreviewPhase>('ready')
  const [assemblyPoseReady, setAssemblyPoseReady] = useState(false)
  const [assemblyPoseError, setAssemblyPoseError] = useState('')
  const preview = partPreviewPath(part)
  const mount = typeof part.mount === 'object' ? part.mount : null
  const calibrationReady = Boolean(mount?.anchors.length && Number.isFinite(mount.contactZ))
  const assemblyAvailable = calibrationReady && assemblyPoseReady
  const slideDistance = Math.max(0, mount?.slideY ?? 0)

  useEffect(() => {
    const host = hostRef.current
    if (!host || !preview) return
    assemblyPoseRef.current = null
    setAssemblyPoseReady(false)
    setAssemblyPoseError('')
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
    let referenceBoard: THREE.Group | null = null
    let cancelled = false
    loadPartModel(`/partLibrary/${preview}`, part.model).then(object => {
      if (cancelled) { disposeObject(object); return }
      model = object
      modelRef.current = object
      scene.add(object)
      object.updateWorldMatrix(true, true)
      const box = new THREE.Box3().setFromObject(object)
      const center = box.getCenter(new THREE.Vector3())
      modelCenterRef.current.copy(center)
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

      referenceBoard = createCalibrationReferenceBoard()
      // 与标定器使用完全相同的参考板定位、孔位目标和 2D 刚体配准。
      // 预览不能只把板面移到 contactZ 后再做相对位移，否则模型会落到拼缝或错误孔位。
      referenceBoard.position.set(center.x - 200, center.y - 200, box.min.z - 4.8)
      referenceBoard.updateMatrixWorld(true)
      referenceBoard.visible = false
      boardRef.current = referenceBoard
      scene.add(referenceBoard)
      const activeMount = typeof part.mount === 'object' ? part.mount : null
      const activeAnchors = (activeMount?.anchors ?? []).map(anchor => anchor.accepts.includes('slot')
        ? { ...anchor, axis: [0, 1] as [number, number] }
        : anchor)
      if (activeMount && activeAnchors.length && Number.isFinite(activeMount.contactZ)) {
        const definitions = referenceBoard.userData.mountTargets as Array<{ kind: 'slot' | 'round'; x: number; y: number }> | undefined
        const thickness = Number(referenceBoard.userData.thickness ?? 5)
        const targets: AssemblyTarget[] = (definitions ?? []).map((target, index) => {
          const world = new THREE.Vector3(target.x, target.y, thickness).applyMatrix4(referenceBoard!.matrixWorld)
          return {
            id: `preview:${target.kind}:${index}`,
            panelId: 'preview-board',
            kind: target.kind,
            x: world.x,
            y: world.y,
            z: world.z,
            ...(target.kind === 'slot' ? { axis: [0, 1] as [number, number] } : {}),
          }
        })
        const boardCenter = new THREE.Box3().setFromObject(referenceBoard).getCenter(new THREE.Vector3())
        const fit = fitPartAnchors(activeAnchors, targets, boardCenter, 180, 4, 0, undefined, activeMount.contactZ, 0)
        if (fit) {
          const inserted = new THREE.Vector3(...fit.position)
          const locked = inserted.clone().add(new THREE.Vector3(0, -slideDistance, 0))
          assemblyPoseRef.current = {
            inserted,
            locked,
            rotationZ: fit.rotationZ,
            focus: center.clone().add(locked),
          }
          setAssemblyPoseReady(true)
        } else {
          setAssemblyPoseError('锚点间距无法匹配参考板孔位，请重新检查装配标定。')
        }
      }
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
      if (assemblyAnimationRef.current !== null) cancelAnimationFrame(assemblyAnimationRef.current)
      cancelAnimationFrame(raf)
      observer.disconnect()
      controls.dispose()
      if (model) disposeObject(model)
      if (referenceBoard) disposeObject(referenceBoard)
      renderer.dispose()
      if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement)
      cameraRef.current = null
      controlsRef.current = null
      modelRef.current = null
      boardRef.current = null
      assemblyPoseRef.current = null
      assemblyAnimationRef.current = null
    }
  }, [part, preview, slideDistance])

  const applyPreset = (direction: [number, number, number]) => {
    const camera = cameraRef.current
    const controls = controlsRef.current
    if (!camera || !controls) return
    camera.position.copy(controls.target).addScaledVector(new THREE.Vector3(...direction).normalize(), radiusRef.current * 3.1)
    camera.lookAt(controls.target)
    controls.update()
  }

  const animateModelPosition = (from: THREE.Vector3, to: THREE.Vector3, duration: number) => new Promise<void>(resolve => {
    const model = modelRef.current
    if (!model) { resolve(); return }
    model.position.copy(from)
    const startedAt = performance.now()
    const step = (now: number) => {
      const t = Math.min(1, (now - startedAt) / Math.max(1, duration))
      const eased = t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
      model.position.lerpVectors(from, to, eased)
      model.updateMatrixWorld(true)
      if (t < 1) assemblyAnimationRef.current = requestAnimationFrame(step)
      else {
        assemblyAnimationRef.current = null
        resolve()
      }
    }
    assemblyAnimationRef.current = requestAnimationFrame(step)
  })

  const resetAssemblyPreview = () => {
    if (assemblyAnimationRef.current !== null) cancelAnimationFrame(assemblyAnimationRef.current)
    assemblyAnimationRef.current = null
    modelRef.current?.position.set(0, 0, 0)
    modelRef.current?.rotation.set(0, 0, 0)
    modelRef.current?.updateMatrixWorld(true)
    if (boardRef.current) boardRef.current.visible = false
    if (controlsRef.current) {
      controlsRef.current.enabled = true
      controlsRef.current.target.copy(modelCenterRef.current)
      controlsRef.current.update()
    }
    setAssemblyPhase('ready')
  }

  const playAssemblyPreview = async () => {
    const model = modelRef.current
    const board = boardRef.current
    const controls = controlsRef.current
    const pose = assemblyPoseRef.current
    if (!assemblyAvailable || !model || !board || !pose || assemblyPhase === 'inserting' || assemblyPhase === 'sliding') return
    board.visible = true
    model.rotation.set(0, 0, pose.rotationZ)
    model.updateMatrixWorld(true)
    if (controls) {
      controls.enabled = false
      controls.target.copy(pose.focus)
      controls.update()
    }
    applyPreset(PRESETS[0].direction)
    const insertionTravel = Math.max(18, Math.min(60, radiusRef.current * .82))
    setAssemblyPhase('inserting')
    await animateModelPosition(pose.inserted.clone().add(new THREE.Vector3(0, 0, insertionTravel)), pose.inserted, 720)
    setAssemblyPhase('sliding')
    if (slideDistance > .01) {
      await animateModelPosition(pose.inserted, pose.locked, 520)
    }
    setAssemblyPhase('locked')
    if (controls) controls.enabled = true
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

  if (embedded) return <section className="part-inline-preview" aria-label="配件三维预览">
    <div ref={hostRef} className="part-preview-canvas" />
    <div className="part-inline-preview-actions"><small>拖动旋转 · 滚轮缩放</small><button type="button" onClick={onExpand}>放大查看</button></div>
    <b data-i18n-ignore="true">{part.name}</b><small>{dimensions}</small>
    {!preview && <small>当前配件没有可用的三维预览</small>}
    {error && <p role="alert">{error}</p>}
  </section>

  return createPortal(
    <div className="part-preview-backdrop" role="presentation" onPointerDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <section className="part-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="part-preview-title">
        <header>
          <span><b id="part-preview-title" data-i18n-ignore="true">{part.name}</b><small>拖动旋转 · 滚轮缩放 · 双指操作</small></span>
          <button type="button" onClick={onClose} aria-label="关闭">×</button>
        </header>
        <div className="part-preview-layout">
          <div className="part-preview-stage">
            <div ref={hostRef} className="part-preview-canvas" />
            <div className="part-preview-assembly-toolbar">
              <div className="part-preview-assembly-control">
                {assemblyAvailable ? <>
                  <button type="button" className="primary" disabled={assemblyPhase === 'inserting' || assemblyPhase === 'sliding'} onClick={() => void playAssemblyPreview()}>{assemblyPhase === 'locked' ? '↻ 重播装配' : assemblyPhase === 'ready' ? '▶ 装配演示' : '正在装配…'}</button>
                  {assemblyPhase !== 'ready' && <button type="button" onClick={resetAssemblyPreview}>返回模型</button>}
                </> : calibrationReady && !assemblyPoseError
                  ? <button type="button" className="primary" disabled>正在匹配参考孔位…</button>
                  : <button type="button" className="primary" onClick={onCalibrate}>{assemblyPoseError ? '重新检查装配标定' : '先完成装配标定'}</button>}
              </div>
              {assemblyPhase !== 'ready' && <div className="part-preview-assembly-progress" aria-live="polite">
                <b>{assemblyPhase === 'locked' ? '装配完成' : '自动装配演示'}</b>
                <div><span className="done"><i>1</i>对准孔位</span><span className={assemblyPhase !== 'inserting' ? 'done' : 'active'}><i>2</i>插入贴面</span><span className={assemblyPhase === 'locked' ? 'done' : assemblyPhase === 'sliding' ? 'active' : ''}><i>3</i>{slideDistance > .01 ? `下滑 ${slideDistance.toFixed(1)} mm` : '零偏移锁止'}</span></div>
              </div>}
            </div>
            <div className="part-preview-presets" aria-label="常用展示视角">
              {PRESETS.map(preset => <button key={preset.id} type="button" onClick={() => applyPreset(preset.direction)}>{preset.label}</button>)}
            </div>
          </div>
          <aside className="part-preview-details">
            <div className="part-preview-meta"><span>模型尺寸</span><b>{dimensions}</b></div>
            <div className="part-preview-meta"><span>格式与状态</span><b>{part.model.format?.toUpperCase() ?? '模型'} · {part.model.renderNode ? '仅显示主体' : '完整模型'}</b></div>
            <div className={`part-preview-meta assembly-${assemblyAvailable ? 'ready' : 'pending'}`}><span>装配演示</span><b>{assemblyAvailable ? `${mount?.anchors.length ?? 0} 个锚点 · ${slideDistance > .01 ? `下滑 ${slideDistance.toFixed(1)} mm` : '仅插入，偏移 0'}` : assemblyPoseError || '待完成锚点与接触面标定'}</b></div>
            <p data-i18n-ignore={part.description ? 'true' : undefined}>{part.description || '暂未填写用途说明。'}</p>
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
