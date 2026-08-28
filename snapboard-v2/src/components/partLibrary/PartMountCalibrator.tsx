import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { loadPartModel } from '../../utils/glbLoader'
import { deriveSlotAxis } from '../../utils/slotAxisProbe'
import { recoverLegacyContactSelection } from '../../utils/mountCalibrationRepair'
import { stabilizeSlotAxis } from '../../utils/mountAxis.js'
import { partPreviewPath, type MountHoleKind, type PartDefinition, type PartMountAnchor } from '../../partLibrary/types'
import { createCalibrationReferenceBoard, createRotationGizmo } from './calibrationReferenceBoard'

interface Props {
  part: PartDefinition
  onClose(): void
  onSaved(): void
}

interface PatchPick {
  center: THREE.Vector3
  normal: THREE.Vector3
  triangles: number[]
}

const round3 = (value: number) => Math.round(value * 1000) / 1000

function capsuleMarkerGeometry(width = 5.4, length = 15.4): THREE.ShapeGeometry {
  const radius = width / 2
  const straight = Math.max(0, length / 2 - radius)
  const shape = new THREE.Shape()
  shape.moveTo(-radius, -straight)
  shape.lineTo(-radius, straight)
  shape.absarc(0, straight, radius, Math.PI, 0, true)
  shape.lineTo(radius, -straight)
  shape.absarc(0, -straight, radius, 0, Math.PI, true)
  shape.closePath()
  return new THREE.ShapeGeometry(shape, 28)
}

/** 在模型局部安装面上画出明确的胶囊/圆形标记，避免长圆孔侧看时退化成一条线。 */
function createAnchorMarker(anchor: PartMountAnchor, color: number): THREE.Mesh {
  const isRound = anchor.accepts.includes('round')
  const geometry = isRound ? new THREE.CircleGeometry(3.1, 32) : capsuleMarkerGeometry()
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.9,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const marker = new THREE.Mesh(geometry, material)
  marker.position.set(...anchor.position)
  const normal = new THREE.Vector3(...(anchor.normal ?? [0, 0, 1])).normalize()
  if (!isRound) {
    const stableAxis = stabilizeSlotAxis(anchor.axis ?? [0, 1])
    const axis = new THREE.Vector3(stableAxis[0], stableAxis[1], 0).normalize()
    const shortAxis = axis.clone().cross(normal).normalize()
    const basis = new THREE.Matrix4().makeBasis(shortAxis, axis, normal)
    marker.quaternion.setFromRotationMatrix(basis)
  } else {
    marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal)
  }
  marker.position.addScaledVector(normal, 0.12)
  return marker
}

function facePatch(hit: THREE.Intersection<THREE.Object3D>): PatchPick | null {
  const mesh = hit.object as THREE.Mesh<THREE.BufferGeometry>
  const geometry = mesh.geometry
  const position = geometry.getAttribute('position') as THREE.BufferAttribute | undefined
  if (!position || hit.faceIndex == null) return null
  const index = geometry.index
  const triCount = index ? index.count / 3 : position.count / 3
  const vertexIndex = (triangle: number, corner: number) => index ? index.getX(triangle * 3 + corner) : triangle * 3 + corner
  const vertex = (triangle: number, corner: number) => {
    const i = vertexIndex(triangle, corner)
    return new THREE.Vector3(position.getX(i), position.getY(i), position.getZ(i))
  }
  const seedA = vertex(hit.faceIndex, 0)
  const seedB = vertex(hit.faceIndex, 1)
  const seedC = vertex(hit.faceIndex, 2)
  const seedNormal = new THREE.Vector3().crossVectors(
    new THREE.Vector3().subVectors(seedB, seedA),
    new THREE.Vector3().subVectors(seedC, seedA),
  ).normalize()
  const planeConstant = seedNormal.dot(seedA)
  const candidate = new Set<number>()
  const byVertex = new Map<string, number[]>()
  const triKeys = new Map<number, string[]>()
  const keyOf = (point: THREE.Vector3) => `${round3(point.x)},${round3(point.y)},${round3(point.z)}`
  for (let triangle = 0; triangle < triCount; triangle++) {
    const a = vertex(triangle, 0), b = vertex(triangle, 1), c = vertex(triangle, 2)
    const normal = new THREE.Vector3().crossVectors(
      new THREE.Vector3().subVectors(b, a),
      new THREE.Vector3().subVectors(c, a),
    )
    if (normal.lengthSq() < 1e-12) continue
    normal.normalize()
    if (normal.dot(seedNormal) < 0.9995) continue
    if (Math.max(
      Math.abs(seedNormal.dot(a) - planeConstant),
      Math.abs(seedNormal.dot(b) - planeConstant),
      Math.abs(seedNormal.dot(c) - planeConstant),
    ) > 0.03) continue
    candidate.add(triangle)
    const keys = [keyOf(a), keyOf(b), keyOf(c)]
    triKeys.set(triangle, keys)
    keys.forEach(key => byVertex.set(key, [...(byVertex.get(key) ?? []), triangle]))
  }

  // 只沿共享顶点扩张，避免把同一高度上四个互不相连的柱端面误合成一个大面。
  const connected = new Set<number>()
  const queue = [hit.faceIndex]
  while (queue.length) {
    const triangle = queue.pop()!
    if (connected.has(triangle) || !candidate.has(triangle)) continue
    connected.add(triangle)
    for (const key of triKeys.get(triangle) ?? []) {
      for (const next of byVertex.get(key) ?? []) if (!connected.has(next)) queue.push(next)
    }
  }
  if (!connected.size) return null
  const weighted = new THREE.Vector3()
  let totalArea = 0
  const triangles: number[] = []
  for (const triangle of connected) {
    const a = vertex(triangle, 0), b = vertex(triangle, 1), c = vertex(triangle, 2)
    const area = new THREE.Triangle(a, b, c).getArea()
    weighted.addScaledVector(new THREE.Vector3().add(a).add(b).add(c).multiplyScalar(1 / 3), area)
    totalArea += area
    for (const point of [a, b, c]) {
      point.applyMatrix4(mesh.matrixWorld)
      triangles.push(point.x, point.y, point.z)
    }
  }
  const center = weighted.multiplyScalar(1 / Math.max(totalArea, 1e-9)).applyMatrix4(mesh.matrixWorld)
  const normal = seedNormal.applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld)).normalize()
  return { center, normal, triangles }
}

/**
 * 长圆孔锚点长轴探测由 slotAxisProbe.ts 提供(详见 deriveSlotAxis):
 * 沿端面法向环形采样, 找边界半径最大的方向 = 槽孔长轴 (即两个半圆弧圆心连线方向)。
 */

export function PartMountCalibrator({ part, onClose, onSaved }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const modelRef = useRef<THREE.Object3D | null>(null)
  const markerGroupRef = useRef<THREE.Group | null>(null)
  const referenceBoardRef = useRef<THREE.Group | null>(null)
  const rotationGizmoRef = useRef<THREE.Group | null>(null)
  const patchMeshesRef = useRef<THREE.Mesh[]>([])
  const contactPatchRef = useRef<THREE.Mesh | null>(null)
  const anchorsRef = useRef<PartMountAnchor[]>([])
  const holeKindRef = useRef<MountHoleKind>('slot')
  const recoveredInitial = recoverLegacyContactSelection(part.mount)
  const [anchors, setAnchors] = useState<PartMountAnchor[]>(() => recoveredInitial.anchors.map(anchor => ({
    ...anchor,
    axis: anchor.axis ? stabilizeSlotAxis(anchor.axis) : undefined,
  })))
  const [holeKind, setHoleKind] = useState<MountHoleKind>('slot')
  const [contactMode, setContactMode] = useState(false)
  const contactModeRef = useRef(false)
  const [contactZ, setContactZ] = useState<number | null>(recoveredInitial.contactZ)
  const [orientation, setOrientation] = useState<[number, number, number]>(part.model.orientation ?? [0, 0, 0])
  const [message, setMessage] = useState(recoveredInitial.recoveredLegacyContact
    ? '已修复旧版误记数据：最后一个圆孔已恢复为接触面；请检查后保存。'
    : '旋转观察模型，然后单击安装柱的水平端面。')
  const [saving, setSaving] = useState(false)
  const [modelReady, setModelReady] = useState(false)
  const orientationRef = useRef<[number, number, number]>(orientation)
  const preview = partPreviewPath(part)
  anchorsRef.current = anchors
  holeKindRef.current = holeKind
  contactModeRef.current = contactMode
  orientationRef.current = orientation

  const clearVisualPatches = () => {
    for (const patch of patchMeshesRef.current) {
      patch.removeFromParent()
      patch.geometry.dispose()
      ;(patch.material as THREE.Material).dispose()
    }
    patchMeshesRef.current = []
    const contactPatch = contactPatchRef.current
    if (contactPatch) {
      contactPatch.removeFromParent()
      contactPatch.geometry.dispose()
      ;(contactPatch.material as THREE.Material).dispose()
      contactPatchRef.current = null
    }
  }

  useEffect(() => {
    const host = hostRef.current
    if (!host || !preview) return
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x151826)
    const camera = new THREE.PerspectiveCamera(42, host.clientWidth / host.clientHeight, 0.05, 5000)
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(host.clientWidth, host.clientHeight)
    host.appendChild(renderer.domElement)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    scene.add(new THREE.HemisphereLight(0xffffff, 0x26304a, 1.6))
    const light = new THREE.DirectionalLight(0xffffff, 2.2)
    light.position.set(80, 120, 100)
    scene.add(light)
    const markerGroup = new THREE.Group()
    markerGroupRef.current = markerGroup
    scene.add(markerGroup)
    let disposed = false
    let frame = 0
    loadPartModel(`/partLibrary/${preview}`, { ...part.model, orientation })
      .then(model => {
        if (disposed) return
        modelRef.current = model
        setModelReady(true)
        model.name = 'calibration-model'
        scene.add(model)
        scene.updateMatrixWorld(true)
        const box = new THREE.Box3().setFromObject(model)
        const center = box.getCenter(new THREE.Vector3())
        const dimensions = box.getSize(new THREE.Vector3())
        const referenceBoard = createCalibrationReferenceBoard()
        referenceBoard.position.set(center.x - 200, center.y - 200, box.min.z - 4.8)
        referenceBoardRef.current = referenceBoard
        scene.add(referenceBoard)

        const gizmoRadius = Math.max(18, Math.max(dimensions.x, dimensions.y, dimensions.z) * 0.72)
        const rotationGizmo = createRotationGizmo(gizmoRadius)
        rotationGizmo.position.copy(center)
        rotationGizmoRef.current = rotationGizmo
        scene.add(rotationGizmo)

        const size = Math.max(400, dimensions.length(), 20)
        controls.target.copy(center)
        camera.position.set(center.x + size * 0.75, center.y + size * 0.55, center.z + size * 0.95)
        camera.near = Math.max(0.01, size / 1000)
        camera.far = size * 50
        camera.updateProjectionMatrix()
      })
      .catch(error => setMessage(`模型加载失败：${error instanceof Error ? error.message : String(error)}`))

    let down: { x: number; y: number } | null = null
    let rotationDrag: {
      axis: 0 | 1 | 2
      startX: number
      startY: number
      startOrientation: [number, number, number]
    } | null = null
    const canvas = renderer.domElement
    const rayFromEvent = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      const mouse = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      )
      const raycaster = new THREE.Raycaster()
      raycaster.setFromCamera(mouse, camera)
      return raycaster
    }
    const ringHit = (event: PointerEvent) => {
      const gizmo = rotationGizmoRef.current
      if (!gizmo) return null
      return rayFromEvent(event).intersectObject(gizmo, true)
        .find(hit => Number.isInteger(hit.object.userData.rotationAxis)) ?? null
    }
    const updateRingHover = (axis: number | null) => {
      rotationGizmoRef.current?.traverse(object => {
        if (!Number.isInteger(object.userData.rotationAxis)) return
        const material = (object as THREE.Mesh).material as THREE.MeshBasicMaterial
        material.opacity = object.userData.rotationAxis === axis ? 0.92 : Number(object.userData.baseOpacity ?? 0.27)
      })
      canvas.style.cursor = axis === null ? 'crosshair' : 'grab'
    }
    const applyDraggedOrientation = (axis: 0 | 1 | 2, value: number) => {
      const next = [...orientationRef.current] as [number, number, number]
      next[axis] = ((value + 180) % 360 + 360) % 360 - 180
      orientationRef.current = next
      setOrientation(next)
      const model = modelRef.current
      const node = model?.userData.orientationNode as THREE.Object3D | undefined
      node?.rotation.set(...next.map(THREE.MathUtils.degToRad) as [number, number, number])
      model?.updateMatrixWorld(true)
      if (model) {
        const box = new THREE.Box3().setFromObject(model)
        const center = box.getCenter(new THREE.Vector3())
        referenceBoardRef.current?.position.set(center.x - 200, center.y - 200, box.min.z - 4.8)
        rotationGizmoRef.current?.position.copy(center)
      }
      if (anchorsRef.current.length) {
        setAnchors([])
        clearVisualPatches()
      }
      setMessage(`${['X', 'Y', 'Z'][axis]} 轴 ${Math.round(next[axis])}° · 松开旋转环后可继续选择端面。`)
    }
    const onDown = (event: PointerEvent) => {
      const hit = ringHit(event)
      if (hit) {
        const axis = hit.object.userData.rotationAxis as 0 | 1 | 2
        rotationDrag = {
          axis,
          startX: event.clientX,
          startY: event.clientY,
          startOrientation: [...orientationRef.current],
        }
        controls.enabled = false
        canvas.style.cursor = 'grabbing'
        canvas.setPointerCapture(event.pointerId)
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }
      down = { x: event.clientX, y: event.clientY }
    }
    const onMove = (event: PointerEvent) => {
      if (rotationDrag) {
        const delta = (event.clientX - rotationDrag.startX - (event.clientY - rotationDrag.startY)) * 0.55
        applyDraggedOrientation(
          rotationDrag.axis,
          rotationDrag.startOrientation[rotationDrag.axis] + delta,
        )
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }
      const hit = ringHit(event)
      updateRingHover(hit ? hit.object.userData.rotationAxis as number : null)
    }
    const onUp = (event: PointerEvent) => {
      if (rotationDrag) {
        rotationDrag = null
        controls.enabled = true
        updateRingHover(null)
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }
      if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5 || !modelRef.current) return
      down = null
      const hit = rayFromEvent(event).intersectObject(modelRef.current, true).find(item => (item.object as THREE.Mesh).isMesh)
      if (!hit) return
      const patch = facePatch(hit)
      if (!patch) return
      const root = modelRef.current
      // 接触面模式: 单击与板面贴合的端面 → 记录该端面局部 z, 装配时接触面与板面贴合。
      if (contactModeRef.current) {
        const contactCenter = root.worldToLocal(patch.center.clone())
        const contactNormal = patch.normal.clone().transformDirection(root.matrixWorld.clone().invert()).normalize()
        if (Math.abs(contactNormal.z) < 0.95) {
          setMessage('接触面应是与板面近乎平行的端面 (法向 ±Z)。请先调整朝向，再点选安装面。')
          return
        }
        const nextZ = round3(contactCenter.z)
        setContactZ(nextZ)
        setMessage(`接触面已设置 (局部 z = ${nextZ})：装配时该端面与板面贴合，锚点只负责孔位对齐。`)
        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(patch.triangles, 3))
        const overlay = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
          color: 0x7fe3c1,
          transparent: true,
          opacity: 0.5,
          side: THREE.DoubleSide,
          depthTest: false,
        }))
        overlay.renderOrder = 20
        const previousContact = contactPatchRef.current
        if (previousContact) {
          previousContact.removeFromParent()
          previousContact.geometry.dispose()
          ;(previousContact.material as THREE.Material).dispose()
        }
        scene.add(overlay)
        contactPatchRef.current = overlay
        return
      }
      const localCenter = root.worldToLocal(patch.center.clone())
      const localNormal = patch.normal.clone().transformDirection(root.matrixWorld.clone().invert()).normalize()
      if (anchorsRef.current.some(anchor => Math.hypot(
        anchor.position[0] - localCenter.x,
        anchor.position[1] - localCenter.y,
        anchor.position[2] - localCenter.z,
      ) < 0.8)) {
        setMessage('这个端面已经选过了，请选择另一个安装柱端面。')
        return
      }
      const next: PartMountAnchor = {
        id: `a${anchorsRef.current.length + 1}`,
        label: `吸附点 ${anchorsRef.current.length + 1}`,
        accepts: [holeKindRef.current],
        position: [round3(localCenter.x), round3(localCenter.y), round3(localCenter.z)],
        normal: [round3(localNormal.x), round3(localNormal.y), round3(localNormal.z)],
        required: true,
      }
      // 长圆孔锚点: 探测孔/柱端面边界, 记录长轴方向 (装配时用于定向吸附)
      if (next.accepts[0] === 'slot' && modelRef.current) {
        const axis = deriveSlotAxis(modelRef.current, next)
        if (axis) next.axis = axis
      }
      setAnchors(current => [...current, next])
      setMessage(`已识别端面中心，新增${holeKindRef.current === 'slot' ? '长圆孔' : '圆孔'}锚点。`)
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(patch.triangles, 3))
      const overlay = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
        color: holeKindRef.current === 'slot' ? 0x3ec6b0 : 0xffd166,
        transparent: true,
        opacity: 0.52,
        side: THREE.DoubleSide,
        depthTest: false,
      }))
      overlay.renderOrder = 20
      scene.add(overlay)
      patchMeshesRef.current.push(overlay)
    }
    const onCancel = (event: PointerEvent) => {
      rotationDrag = null
      down = null
      controls.enabled = true
      updateRingHover(null)
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
    }
    canvas.addEventListener('pointerdown', onDown, true)
    canvas.addEventListener('pointermove', onMove, true)
    canvas.addEventListener('pointerup', onUp, true)
    canvas.addEventListener('pointercancel', onCancel, true)
    const resize = new ResizeObserver(() => {
      camera.aspect = host.clientWidth / host.clientHeight
      camera.updateProjectionMatrix()
      renderer.setSize(host.clientWidth, host.clientHeight)
    })
    resize.observe(host)
    const animate = () => {
      frame = requestAnimationFrame(animate)
      controls.update()
      renderer.render(scene, camera)
    }
    animate()
    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      resize.disconnect()
      canvas.removeEventListener('pointerdown', onDown, true)
      canvas.removeEventListener('pointermove', onMove, true)
      canvas.removeEventListener('pointerup', onUp, true)
      canvas.removeEventListener('pointercancel', onCancel, true)
      controls.dispose()
      clearVisualPatches()
      renderer.dispose()
      renderer.domElement.remove()
      modelRef.current = null
      markerGroupRef.current = null
      referenceBoardRef.current = null
      rotationGizmoRef.current = null
    }
    // 标定会话内只加载一次；朝向按钮直接旋转现有根节点。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [part.id, preview])

  useEffect(() => {
    const group = markerGroupRef.current
    const model = modelRef.current
    if (!group || !model) return
    for (const child of [...group.children]) {
      group.remove(child)
      const mesh = child as THREE.Mesh
      mesh.geometry?.dispose()
      ;(mesh.material as THREE.Material | undefined)?.dispose()
    }
    model.updateMatrixWorld(true)
    anchors.forEach((anchor, index) => {
      const position = new THREE.Vector3(...anchor.position).applyMatrix4(model.matrixWorld)
      const color = anchor.accepts.includes('round') ? 0xffd166 : 0x3ec6b0
      const marker = createAnchorMarker(anchor, color)
      marker.position.copy(position)
      // createAnchorMarker 生成的是模型局部朝向；这里把朝向也转换到世界空间。
      marker.quaternion.premultiply(model.getWorldQuaternion(new THREE.Quaternion()))
      marker.renderOrder = 30 + index
      group.add(marker)
    })
  }, [anchors, modelReady])

  // 旧标定数据没有长轴字段: 模型就绪后为既有长圆孔锚点自动补算 (点击新锚点时也会即时计算)。
  // 这样无需重新点选, 打开标定器并保存一次即可让定向吸附生效。
  useEffect(() => {
    const model = modelRef.current
    if (!model || !modelReady) return
    let changed = false
    const upgraded = anchors.map(anchor => {
      if (!anchor.accepts.includes('slot') || anchor.axis) return anchor
      const axis = deriveSlotAxis(model, anchor)
      if (!axis) return anchor
      changed = true
      return { ...anchor, axis }
    })
    if (changed) setAnchors(upgraded)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelReady])

  const updateReferenceBoardPosition = () => {
    const model = modelRef.current
    const board = referenceBoardRef.current
    if (!model || !board) return
    model.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(model)
    const center = box.getCenter(new THREE.Vector3())
    board.position.set(center.x - 200, center.y - 200, box.min.z - 4.8)
    rotationGizmoRef.current?.position.copy(center)
  }

  const normalizeAngle = (value: number) => ((value + 180) % 360 + 360) % 360 - 180

  const setDefaultOrientation = (next: [number, number, number]) => {
    orientationRef.current = next
    setOrientation(next)
    const model = modelRef.current
    const orientationNode = model?.userData.orientationNode as THREE.Object3D | undefined
    if (orientationNode) {
      orientationNode.rotation.set(
        THREE.MathUtils.degToRad(next[0]),
        THREE.MathUtils.degToRad(next[1]),
        THREE.MathUtils.degToRad(next[2]),
      )
      model?.updateMatrixWorld(true)
      updateReferenceBoardPosition()
    }
    if (anchorsRef.current.length) {
      setAnchors([])
      clearVisualPatches()
    }
    setContactZ(null)
    setMessage('默认朝向已手动调整；请确认安装面朝向参考洞洞板，再重新选择端面。')
  }

  const rotateDefault = (axis: 0 | 1 | 2, delta: number) => {
    const next = [...orientation] as [number, number, number]
    next[axis] = normalizeAngle(next[axis] + delta)
    setDefaultOrientation(next)
  }

  const setOrientationAxis = (axis: 0 | 1 | 2, value: number) => {
    if (!Number.isFinite(value)) return
    const next = [...orientation] as [number, number, number]
    next[axis] = THREE.MathUtils.clamp(value, -180, 180)
    setDefaultOrientation(next)
  }

  const removeLast = () => {
    setAnchors(current => current.slice(0, -1))
    const patch = patchMeshesRef.current.pop()
    if (patch) {
      patch.removeFromParent()
      patch.geometry.dispose()
      ;(patch.material as THREE.Material).dispose()
    }
  }

  const save = async () => {
    if (!anchors.length || !part.packageId || !part.localId) return
    setSaving(true)
    setMessage('正在写入资源包并刷新配件索引…')
    try {
      const response = await fetch('/api/part-library/calibration', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packageId: part.packageId, localId: part.localId, anchors, orientation, contactZ }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`)
      setMessage('标定已保存。')
      onSaved()
    } catch (error) {
      setMessage(`保存失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setSaving(false)
    }
  }

  return createPortal(
    <div className="calib-backdrop" role="dialog" aria-modal="true" aria-label={`${part.name} 装配标定`}>
      <div className="calib-modal">
        <header className="calib-head">
          <div>
            <strong>配件装配标定</strong>
            <span>{part.name} · {part.model.format?.toUpperCase()}</span>
          </div>
          <button onClick={onClose} aria-label="关闭">×</button>
        </header>
        <div className="calib-body">
          <div className="calib-viewport" ref={hostRef}>
            <div className="calib-gizmo-hint">
              拖动旋转环
              <span className="x">X</span><span className="y">Y</span><span className="z">Z</span>
              · 15° / 45° / 90° 刻度
            </div>
          </div>
          <aside className="calib-panel">
            <section>
              <h4>1. 默认朝向</h4>
              <p>拖动模型周围带刻度的 X/Y/Z 旋转环，或用下面的按钮和数值精调。让安装柱端面朝向 200×200 参考板；改变朝向会清空旧锚点。</p>
              <div className="calib-rotate-grid">
                <button onClick={() => rotateDefault(0, -90)}>X −90°</button><button onClick={() => rotateDefault(0, 90)}>X +90°</button>
                <button onClick={() => rotateDefault(1, -90)}>Y −90°</button><button onClick={() => rotateDefault(1, 90)}>Y +90°</button>
                <button onClick={() => rotateDefault(2, -90)}>Z −90°</button><button onClick={() => rotateDefault(2, 90)}>Z +90°</button>
              </div>
              <div className="calib-manual-rotate">
                {(['X', 'Y', 'Z'] as const).map((label, axis) => (
                  <label key={label}>
                    <b>{label}</b>
                    <input
                      type="range"
                      min={-180}
                      max={180}
                      step={1}
                      value={normalizeAngle(orientation[axis])}
                      onChange={event => setOrientationAxis(axis as 0 | 1 | 2, Number(event.target.value))}
                    />
                    <input
                      type="number"
                      min={-180}
                      max={180}
                      step={1}
                      value={Math.round(normalizeAngle(orientation[axis]) * 10) / 10}
                      onChange={event => setOrientationAxis(axis as 0 | 1 | 2, Number(event.target.value))}
                    />
                    <span>°</span>
                  </label>
                ))}
                <button onClick={() => setDefaultOrientation([0, 0, 0])}>恢复模型原始朝向</button>
              </div>
              <code>{orientation.map(v => `${Math.round(v * 10) / 10}°`).join(' / ')}</code>
            </section>
            <section>
              <h4>2. 选择端面</h4>
              <p>选择孔型后单击安装柱端面添加锚点；或选「接触面」后单击与板面贴合的端面（装配时由该端面定位插入深度）。这里只定义零件安装面，3D 装配时会根据观察侧自动判断正面或背面。</p>
              <div className="calib-kind">
                <button className={!contactMode && holeKind === 'slot' ? 'on' : ''} onClick={() => { setContactMode(false); setHoleKind('slot') }}>长圆孔</button>
                <button className={!contactMode && holeKind === 'round' ? 'on' : ''} onClick={() => { setContactMode(false); setHoleKind('round') }}>圆孔</button>
                <button className={contactMode ? 'on' : ''} onClick={() => setContactMode(true)}>接触面</button>
              </div>
              <p className="calib-contact-status">
                {contactMode
                  ? '单击与板面贴合的端面即可设置接触面。'
                  : contactZ !== null
                    ? `接触面已设置：局部 z = ${contactZ} mm（装配时贴合板面）`
                    : '接触面：未设置（默认锚点平面贴合板面）'}
              </p>
            </section>
            <section className="calib-anchor-list">
              <h4>3. 已选定位 ({anchors.length + (contactZ !== null ? 1 : 0)})</h4>
              {anchors.length === 0 && contactZ === null && <p>尚未选择端面。</p>}
              {anchors.map((anchor, index) => (
                <div key={anchor.id}>
                  <span className={anchor.accepts.includes('round') ? 'round' : 'slot'}>{index + 1}</span>
                  <b>{anchor.accepts.includes('round') ? '圆孔' : '长圆孔'}</b>
                  <code>{anchor.position.map(v => v.toFixed(2)).join(', ')}</code>
                </div>
              ))}
              {contactZ !== null && (
                <div className="contact">
                  <span className="contact">面</span>
                  <b>接触面</b>
                  <code>局部 z = {contactZ.toFixed(2)} mm</code>
                </div>
              )}
              <div className="calib-list-actions">
                <button disabled={!anchors.length} onClick={removeLast}>撤销上一个</button>
                <button disabled={!anchors.length} onClick={() => { setAnchors([]); clearVisualPatches() }}>清空</button>
              </div>
            </section>
          </aside>
        </div>
        <footer className="calib-foot">
          <span>{message}</span>
          <div>
            <button onClick={onClose}>取消</button>
            <button className="primary" disabled={!anchors.length || saving} onClick={save}>{saving ? '保存中…' : '保存标定'}</button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
