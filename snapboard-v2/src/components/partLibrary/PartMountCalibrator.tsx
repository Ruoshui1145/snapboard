import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { loadPartModel } from '../../utils/glbLoader'
import { recoverLegacyContactSelection } from '../../utils/mountCalibrationRepair'
import { stabilizeSlotAxis } from '../../utils/mountAxis.js'
import { estimateSlotLockTravel, fitPartAnchors, type AssemblyTarget } from '../../utils/assemblySnap'
import { partPreviewPath, type MountHoleKind, type PartDefinition, type PartMountAnchor } from '../../partLibrary/types'
import { createCalibrationReferenceBoard, createRotationGizmo, setRotationGizmoAngle, setRotationGizmoAngles } from './calibrationReferenceBoard'

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

/** 把点选端面的世界坐标三角形投回模型安装坐标，生成轻量代理碰撞尺寸。 */
function patchCollisionProfile(triangles: number[], root: THREE.Object3D): { width: number; length: number; axis?: [number, number] } | undefined {
  if (triangles.length < 9) return undefined
  const inverse = root.matrixWorld.clone().invert()
  const points: THREE.Vector3[] = []
  for (let i = 0; i + 2 < triangles.length; i += 3) {
    points.push(new THREE.Vector3(triangles[i], triangles[i + 1], triangles[i + 2]).applyMatrix4(inverse))
  }
  const center = points.reduce((sum, point) => sum.add(point), new THREE.Vector3()).multiplyScalar(1 / points.length)
  let xx = 0, yy = 0, xy = 0
  points.forEach(point => {
    const x = point.x - center.x, y = point.y - center.y
    xx += x * x
    yy += y * y
    xy += x * y
  })
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy)
  const major = new THREE.Vector2(Math.cos(angle), Math.sin(angle)).normalize()
  const minor = new THREE.Vector2(-major.y, major.x)
  const majorProjection = points.map(point => point.x * major.x + point.y * major.y)
  const minorProjection = points.map(point => point.x * minor.x + point.y * minor.y)
  let length = Math.max(...majorProjection) - Math.min(...majorProjection)
  let width = Math.max(...minorProjection) - Math.min(...minorProjection)
  let axis: [number, number] = [round3(major.x), round3(major.y)]
  if (width > length) {
    ;[width, length] = [length, width]
    axis = [round3(minor.x), round3(minor.y)]
  }
  if (!Number.isFinite(width) || !Number.isFinite(length) || width < 0.1 || length < 0.1) return undefined
  const elongated = length / Math.max(width, 1e-6) >= 1.2
  return { width: round3(width), length: round3(length), ...(elongated ? { axis } : {}) }
}

/** 正式板长圆孔固定竖直；标定通过插入、贴面、下滑模拟验证，不再从三角网格猜测方向。 */

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
  const [contactSource, setContactSource] = useState<'none' | 'auto' | 'manual'>(recoveredInitial.contactZ === null ? 'none' : 'manual')
  const [selectionCommitted, setSelectionCommitted] = useState(false)
  // 5×15 长孔配合约 5 mm 安装柱时，从中心插入到底部的理论行程为 (15-5)/2 = 5 mm。
  const [slideY, setSlideY] = useState(Math.max(0, part.mount && typeof part.mount === 'object' ? part.mount.slideY ?? 5 : 5))
  const [simulationPhase, setSimulationPhase] = useState<'idle' | 'inserted' | 'locked'>('idle')
  const [simulationBusy, setSimulationBusy] = useState(false)
  const [autoSimulation, setAutoSimulation] = useState(true)
  const [manualSlideOverride, setManualSlideOverride] = useState(false)
  const [detectedSlideY, setDetectedSlideY] = useState<number | null>(null)
  const [orientation, setOrientation] = useState<[number, number, number]>(part.model.orientation ?? [0, 0, 0])
  const [message, setMessage] = useState(recoveredInitial.recoveredLegacyContact
    ? '已修复旧版误记数据：最后一个圆孔已恢复为接触面；请检查后保存。'
    : '旋转观察模型，然后单击安装柱的水平端面。')
  const [saving, setSaving] = useState(false)
  const [modelReady, setModelReady] = useState(false)
  const orientationRef = useRef<[number, number, number]>(orientation)
  const simulationPositionRef = useRef<{ inserted: THREE.Vector3; locked: THREE.Vector3; rotationZ: number; slideDistance: number } | null>(null)
  const simulationAnimationRef = useRef<number | null>(null)
  const preview = partPreviewPath(part)
  anchorsRef.current = anchors
  holeKindRef.current = holeKind
  contactModeRef.current = contactMode
  orientationRef.current = orientation

  const modelPivotWorld = () => {
    const model = modelRef.current
    const node = model?.userData.orientationNode as THREE.Object3D | undefined
    if (!node) return null
    const pivot = new THREE.Vector3()
    node.getWorldPosition(pivot)
    return pivot
  }

  /** SolidWorks 风格首孔定向：端面法向朝向板面，长孔主轴自动转为竖直。
   *  长轴无正负之分，因此选择最小的面内转角；上下手性由用户之后显式翻转。 */
  const autoOrientFirstAnchor = (anchor: PartMountAnchor): { anchor: PartMountAnchor; rotated: boolean; degrees: number } => {
    const model = modelRef.current
    const node = model?.userData.orientationNode as THREE.Object3D | undefined
    if (!model || !node || anchorsRef.current.length > 0 || !anchor.normal) return { anchor, rotated: false, degrees: 0 }
    const normal = new THREE.Vector3(...anchor.normal).normalize()
    const normalCorrection = new THREE.Quaternion().setFromUnitVectors(normal, new THREE.Vector3(0, 0, -1))
    let inPlaneAngle = 0
    if (anchor.accepts.includes('slot') && anchor.profile?.axis) {
      const detectedAxis = new THREE.Vector3(anchor.profile.axis[0], anchor.profile.axis[1], 0)
        .applyQuaternion(normalCorrection)
      const currentAngle = Math.atan2(detectedAxis.y, detectedAxis.x)
      inPlaneAngle = Math.PI / 2 - currentAngle
      // 胶囊长轴的 +/− 方向等价，选择绝对值不超过 90° 的最近解，避免无谓翻面。
      while (inPlaneAngle > Math.PI / 2) inPlaneAngle -= Math.PI
      while (inPlaneAngle < -Math.PI / 2) inPlaneAngle += Math.PI
    }
    const inPlaneCorrection = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), inPlaneAngle)
    const correction = inPlaneCorrection.multiply(normalCorrection)
    const correctionAngle = THREE.MathUtils.radToDeg(2 * Math.acos(THREE.MathUtils.clamp(Math.abs(correction.w), -1, 1)))
    if (correctionAngle < 0.5) return { anchor: { ...anchor, axis: anchor.accepts.includes('slot') ? [0, 1] : anchor.axis }, rotated: false, degrees: 0 }

    const pivot = node.position.clone()
    const position = new THREE.Vector3(...anchor.position).sub(pivot).applyQuaternion(correction).add(pivot)
    const correctedNormal = normal.applyQuaternion(correction).normalize()
    node.quaternion.premultiply(correction)
    node.updateMatrixWorld(true)
    model.updateMatrixWorld(true)
    const nextOrientation = [node.rotation.x, node.rotation.y, node.rotation.z]
      .map(value => normalizeAngle(THREE.MathUtils.radToDeg(value))) as [number, number, number]
    orientationRef.current = nextOrientation
    setOrientation(nextOrientation)
    const box = new THREE.Box3().setFromObject(model)
    const center = modelPivotWorld() ?? box.getCenter(new THREE.Vector3())
    referenceBoardRef.current?.position.set(center.x - 200, center.y - 200, box.min.z - 4.8)
    const gizmo = rotationGizmoRef.current
    if (gizmo) {
      gizmo.position.copy(center)
      setRotationGizmoAngles(gizmo, nextOrientation)
    }
    return {
      anchor: {
        ...anchor,
        position: [round3(position.x), round3(position.y), round3(position.z)],
        normal: [round3(correctedNormal.x), round3(correctedNormal.y), round3(correctedNormal.z)],
        axis: anchor.accepts.includes('slot') ? [0, 1] : anchor.axis,
        profile: anchor.profile ? { ...anchor.profile, ...(anchor.accepts.includes('slot') ? { axis: [0, 1] as [number, number] } : {}) } : undefined,
      },
      rotated: true,
      degrees: correctionAngle,
    }
  }

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
        const pivot = modelPivotWorld() ?? center
        referenceBoard.position.set(pivot.x - 200, pivot.y - 200, box.min.z - 4.8)
        referenceBoardRef.current = referenceBoard
        scene.add(referenceBoard)

        const gizmoRadius = Math.max(18, Math.max(dimensions.x, dimensions.y, dimensions.z) * 0.72)
        const rotationGizmo = createRotationGizmo(gizmoRadius)
        rotationGizmo.position.copy(pivot)
        setRotationGizmoAngles(rotationGizmo, orientation)
        rotationGizmoRef.current = rotationGizmo
        scene.add(rotationGizmo)

        const size = Math.max(400, dimensions.length(), 20)
        // 相机和旋转环共享固定枢轴；不要以旋转后的包围盒中心为目标，
        // 否则非对称零件每次改角度都会产生“相机在追模型”的错觉。
        controls.target.copy(pivot)
        camera.position.set(pivot.x + size * 0.75, pivot.y + size * 0.55, pivot.z + size * 0.95)
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
      startAngle: number
      cameraPosition: THREE.Vector3
      cameraTarget: THREE.Vector3
      cameraZoom: number
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
      const hits = rayFromEvent(event).intersectObject(gizmo, true)
        .filter(hit => Number.isInteger(hit.object.userData.rotationAxis))
      // 箭头是每条环的明确抓手；重叠位置才回退到圆环本体，减少误选相邻轴。
      return hits.find(hit => hit.object.userData.rotationHandle) ?? hits[0] ?? null
    }
    const ringAngle = (event: PointerEvent, axis: 0 | 1 | 2): number | null => {
      const gizmo = rotationGizmoRef.current
      const root = gizmo?.getObjectByName(`rotation-axis-${axis}`)
      if (!gizmo || !root) return null
      const quaternion = root.getWorldQuaternion(new THREE.Quaternion())
      const u = new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion).normalize()
      const v = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion).normalize()
      const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion).normalize()
      const center = gizmo.getWorldPosition(new THREE.Vector3())
      const point = rayFromEvent(event).ray.intersectPlane(
        new THREE.Plane().setFromNormalAndCoplanarPoint(normal, center),
        new THREE.Vector3(),
      )
      if (!point) return null
      const relative = point.sub(center)
      return Math.atan2(relative.dot(v), relative.dot(u))
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
        const center = modelPivotWorld() ?? box.getCenter(new THREE.Vector3())
        referenceBoardRef.current?.position.set(center.x - 200, center.y - 200, box.min.z - 4.8)
        rotationGizmoRef.current?.position.copy(center)
      }
      const ringSign = 1
      const rotationGizmo = rotationGizmoRef.current
      if (rotationGizmo) {
        setRotationGizmoAngle(
          rotationGizmo,
          axis,
          THREE.MathUtils.degToRad(next[axis]) * ringSign,
        )
      }
      if (anchorsRef.current.length) {
        setAnchors([])
        clearVisualPatches()
      }
      simulationPositionRef.current = null
      setSelectionCommitted(false)
      setDetectedSlideY(null)
      setContactZ(null)
      setContactSource('none')
      setSimulationPhase('idle')
      setMessage(`${['X', 'Y', 'Z'][axis]} 轴 ${Math.round(next[axis])}° · 已吸附到 15° 刻度 · 松开旋转环后可继续选择端面。`)
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
          startAngle: ringAngle(event, axis) ?? 0,
          cameraPosition: camera.position.clone(),
          cameraTarget: controls.target.clone(),
          cameraZoom: camera.zoom,
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
        // OrbitControls 可能已经排队了上一帧的阻尼变化；每一帧恢复快照，
        // 确保旋转环只改变模型姿态，不改变相机位置、目标或缩放。
        camera.position.copy(rotationDrag.cameraPosition)
        controls.target.copy(rotationDrag.cameraTarget)
        camera.zoom = rotationDrag.cameraZoom
        camera.updateProjectionMatrix()
        const currentAngle = ringAngle(event, rotationDrag.axis)
        const ringSign = 1
        const delta = currentAngle === null
          ? (event.clientX - rotationDrag.startX - (event.clientY - rotationDrag.startY)) * 0.55
          : THREE.MathUtils.radToDeg(THREE.MathUtils.euclideanModulo(
            currentAngle - rotationDrag.startAngle + Math.PI,
            Math.PI * 2,
          ) - Math.PI)
        const raw = rotationDrag.startOrientation[rotationDrag.axis] + ringSign * delta
        // 旋转环刻度是 15° 一格；拖到刻度附近时吸附，形成明确的“卡点”反馈。
        const snapped = Math.round(raw / 15) * 15
        applyDraggedOrientation(rotationDrag.axis, snapped)
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }
      const hit = ringHit(event)
      updateRingHover(hit ? hit.object.userData.rotationAxis as number : null)
    }
    const onUp = (event: PointerEvent) => {
      if (rotationDrag) {
        camera.position.copy(rotationDrag.cameraPosition)
        controls.target.copy(rotationDrag.cameraTarget)
        camera.zoom = rotationDrag.cameraZoom
        camera.updateProjectionMatrix()
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
        setContactSource('manual')
        setSelectionCommitted(false)
        simulationPositionRef.current = null
        setDetectedSlideY(null)
        setSimulationPhase('idle')
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
      let next: PartMountAnchor = {
        id: `a${anchorsRef.current.length + 1}`,
        label: `吸附点 ${anchorsRef.current.length + 1}`,
        accepts: [holeKindRef.current],
        position: [round3(localCenter.x), round3(localCenter.y), round3(localCenter.z)],
        normal: [round3(localNormal.x), round3(localNormal.y), round3(localNormal.z)],
        profile: patchCollisionProfile(patch.triangles, root),
        required: true,
      }
      // 标定页面中的正确装配朝向以参考板为准：长孔必须竖直才能插入板孔。
      // 不再从端面三角网格猜测 15°/90° 方向，避免采样误差把整件旋转。
      if (next.accepts[0] === 'slot') next.axis = [0, 1]
      const autoOrientation = autoOrientFirstAnchor(next)
      next = autoOrientation.anchor
      simulationPositionRef.current = null
      setDetectedSlideY(null)
      setSelectionCommitted(false)
      if (autoOrientation.rotated) {
        setContactZ(null)
        setContactSource('none')
        clearVisualPatches()
      }
      setSimulationPhase('idle')
      setAnchors(current => [...current, next])
      setMessage(`${autoOrientation.rotated ? `已根据首孔自动转向 ${autoOrientation.degrees.toFixed(1)}°；` : ''}已新增${holeKindRef.current === 'slot' ? '长圆孔' : '圆孔'}锚点${next.profile ? `，代理尺寸 ${next.profile.width}×${next.profile.length} mm` : ''}。继续选择其余孔，完成后再执行装配。`)
      if (autoOrientation.rotated) return
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
      if (rotationDrag) {
        camera.position.copy(rotationDrag.cameraPosition)
        controls.target.copy(rotationDrag.cameraTarget)
        camera.zoom = rotationDrag.cameraZoom
        camera.updateProjectionMatrix()
      }
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
      if (!rotationDrag) controls.update()
      renderer.render(scene, camera)
    }
    animate()
    return () => {
      disposed = true
      if (simulationAnimationRef.current !== null) cancelAnimationFrame(simulationAnimationRef.current)
      simulationAnimationRef.current = null
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

  // 正确朝向下长孔统一为板面竖直方向；打开旧数据时直接修正并等待用户用模拟装配验证。
  useEffect(() => {
    if (!modelReady) return
    let changed = false
    const upgraded = anchors.map(anchor => {
      if (!anchor.accepts.includes('slot')) return anchor
      const axis = stabilizeSlotAxis(anchor.axis ?? [0, 1])
      if (axis[0] === 0 && axis[1] === 1) return anchor.axis ? anchor : { ...anchor, axis }
      changed = true
      return { ...anchor, axis: [0, 1] as [number, number] }
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
      const center = modelPivotWorld() ?? box.getCenter(new THREE.Vector3())
      board.position.set(center.x - 200, center.y - 200, box.min.z - 4.8)
      rotationGizmoRef.current?.position.copy(center)
  }

  const normalizeAngle = (value: number) => ((value + 180) % 360 + 360) % 360 - 180

  const setDefaultOrientation = (next: [number, number, number]) => {
    simulationPositionRef.current = null
    setSelectionCommitted(false)
    setDetectedSlideY(null)
    setManualSlideOverride(false)
    setSimulationPhase('idle')
    orientationRef.current = next
    setOrientation(next)
    const model = modelRef.current
    const orientationNode = model?.userData.orientationNode as THREE.Object3D | undefined
    if (orientationNode) {
      model?.position.set(0, 0, 0)
      model?.rotation.set(0, 0, 0)
      orientationNode.rotation.set(
        THREE.MathUtils.degToRad(next[0]),
        THREE.MathUtils.degToRad(next[1]),
        THREE.MathUtils.degToRad(next[2]),
      )
      model?.updateMatrixWorld(true)
      updateReferenceBoardPosition()
      const gizmo = rotationGizmoRef.current
      if (gizmo) setRotationGizmoAngles(gizmo, next)
    }
    if (anchorsRef.current.length) {
      setAnchors([])
      clearVisualPatches()
    }
    setContactZ(null)
    setContactSource('none')
    setSlideY(5)
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

  const animateModelPosition = (to: THREE.Vector3, duration = 420) => new Promise<void>(resolve => {
    const model = modelRef.current
    if (!model) { resolve(); return }
    if (simulationAnimationRef.current !== null) cancelAnimationFrame(simulationAnimationRef.current)
    const from = model.position.clone()
    const startedAt = performance.now()
    const step = (now: number) => {
      const t = Math.min(1, (now - startedAt) / Math.max(1, duration))
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
      model.position.lerpVectors(from, to, eased)
      model.updateMatrixWorld(true)
      if (t < 1) simulationAnimationRef.current = requestAnimationFrame(step)
      else {
        simulationAnimationRef.current = null
        resolve()
      }
    }
    simulationAnimationRef.current = requestAnimationFrame(step)
  })

  const setEditingVisualsVisible = (visible: boolean) => {
    if (markerGroupRef.current) markerGroupRef.current.visible = visible
    if (rotationGizmoRef.current) rotationGizmoRef.current.visible = visible
    patchMeshesRef.current.forEach(patch => { patch.visible = visible })
    if (contactPatchRef.current) contactPatchRef.current.visible = visible
  }

  const setBoardColliderState = (state: 'idle' | 'sweeping' | 'hit') => {
    const collider = referenceBoardRef.current?.getObjectByName('calibration-board-collider') as THREE.Mesh | undefined
    const material = collider?.material as THREE.MeshBasicMaterial | undefined
    if (!material) return
    material.color.setHex(state === 'hit' ? 0x65d58a : 0x62a8ff)
    material.opacity = state === 'idle' ? 0.035 : state === 'sweeping' ? 0.11 : 0.2
    material.needsUpdate = true
  }

  /** 从安装柱端面沿其内法向投射双面三角形射线，寻找最近的贴板平面。 */
  const detectContactFace = (): { z: number; spread: number } | null => {
    const model = modelRef.current
    if (!model || !anchors.length) return null
    model.updateMatrixWorld(true)
    const rootInverse = model.matrixWorld.clone().invert()
    const hits: number[] = []
    for (const anchor of anchors) {
      const outward = new THREE.Vector3(...(anchor.normal ?? [0, 0, -1])).normalize()
      const inward = outward.clone().negate()
      const origin = new THREE.Vector3(...anchor.position).addScaledVector(inward, 0.2)
      const ray = new THREE.Ray(origin, inward)
      const nearest = { distance: Number.POSITIVE_INFINITY, z: Number.NaN }
      model.traverse(object => {
        const mesh = object as THREE.Mesh<THREE.BufferGeometry>
        if (!mesh.isMesh || !mesh.geometry) return
        const position = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined
        if (!position) return
        const index = mesh.geometry.index
        const transform = rootInverse.clone().multiply(mesh.matrixWorld)
        const triangleCount = index ? index.count / 3 : position.count / 3
        const vertex = (triangle: number, corner: number) => {
          const offset = triangle * 3 + corner
          const i = index ? index.getX(offset) : offset
          return new THREE.Vector3(position.getX(i), position.getY(i), position.getZ(i)).applyMatrix4(transform)
        }
        for (let triangle = 0; triangle < triangleCount; triangle++) {
          const a = vertex(triangle, 0), b = vertex(triangle, 1), c = vertex(triangle, 2)
          const normal = new THREE.Vector3().crossVectors(
            new THREE.Vector3().subVectors(b, a),
            new THREE.Vector3().subVectors(c, a),
          )
          if (normal.lengthSq() < 1e-10) continue
          normal.normalize()
          if (Math.abs(normal.dot(inward)) < 0.85) continue
          const point = ray.intersectTriangle(a, b, c, false, new THREE.Vector3())
          if (!point) continue
          const distance = point.distanceTo(origin)
          if (distance < 0.6 || distance >= nearest.distance) continue
          nearest.distance = distance
          nearest.z = point.z
        }
      })
      if (Number.isFinite(nearest.z)) hits.push(nearest.z)
    }
    if (!hits.length) return null
    hits.sort((a, b) => a - b)
    const z = hits[Math.floor(hits.length / 2)]
    const spread = Math.max(...hits) - Math.min(...hits)
    return { z: round3(z), spread: round3(spread) }
  }

  const completeSelection = () => {
    if (!anchors.length) {
      setMessage('请先选择全部长圆孔/圆孔安装柱，再完成孔位。')
      return
    }
    let resolvedContactZ = contactZ
    let automatic = false
    if (contactSource !== 'manual' || resolvedContactZ === null) {
      const detected = detectContactFace()
      if (!detected || detected.spread > 1.5) {
        setSelectionCommitted(false)
        setContactMode(true)
        setMessage(detected
          ? `自动接触面在不同安装柱之间相差 ${detected.spread.toFixed(2)} mm；请用“接触面”手动确认。`
          : '没有可靠检测到接触面；已切换到手动接触面，请在模型上点击贴板面后再次完成孔位。')
        return
      }
      resolvedContactZ = detected.z
      automatic = true
      setContactZ(detected.z)
      setContactSource('auto')
      setContactMode(false)
    }
    setSelectionCommitted(true)
    setMessage(`孔位选择已完成；${automatic ? `自动识别接触面 z=${resolvedContactZ?.toFixed(2)} mm，` : '使用手动接触面，'}开始单次装配检测。`)
  }

  /** 长轴没有正负方向，自动转向可能留下 180° 手性歧义；此按钮只翻上下，不改变孔距和接触深度。 */
  const flipHandedness = () => {
    const model = modelRef.current
    const node = model?.userData.orientationNode as THREE.Object3D | undefined
    if (!model || !node) return
    resetSimulation()
    const correction = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI)
    const pivot = node.position.clone()
    const flippedAnchors = anchors.map(anchor => {
      const position = new THREE.Vector3(...anchor.position).sub(pivot).applyQuaternion(correction).add(pivot)
      const normal = new THREE.Vector3(...(anchor.normal ?? [0, 0, -1])).applyQuaternion(correction).normalize()
      return {
        ...anchor,
        position: [round3(position.x), round3(position.y), round3(position.z)] as [number, number, number],
        normal: [round3(normal.x), round3(normal.y), round3(normal.z)] as [number, number, number],
        axis: anchor.accepts.includes('slot') ? [0, 1] as [number, number] : anchor.axis,
      }
    })
    node.quaternion.premultiply(correction)
    node.updateMatrixWorld(true)
    model.updateMatrixWorld(true)
    const nextOrientation = [node.rotation.x, node.rotation.y, node.rotation.z]
      .map(value => normalizeAngle(THREE.MathUtils.radToDeg(value))) as [number, number, number]
    orientationRef.current = nextOrientation
    setOrientation(nextOrientation)
    if (rotationGizmoRef.current) setRotationGizmoAngles(rotationGizmoRef.current, nextOrientation)
    setAnchors(flippedAnchors)
    clearVisualPatches()
    setSelectionCommitted(false)
    setMessage('已将零件上下翻转 180°，正在按相同孔位重新执行装配检测。')
    window.setTimeout(() => setSelectionCommitted(true), 0)
  }

  const resetSimulation = () => {
    if (simulationAnimationRef.current !== null) cancelAnimationFrame(simulationAnimationRef.current)
    simulationAnimationRef.current = null
    simulationPositionRef.current = null
    const model = modelRef.current
    if (model) {
      model.position.set(0, 0, 0)
      model.rotation.set(0, 0, 0)
      model.updateMatrixWorld(true)
    }
    setEditingVisualsVisible(true)
    setBoardColliderState('idle')
    setSimulationPhase('idle')
    setSimulationBusy(false)
  }

  const prepareSimulation = () => {
    const model = modelRef.current
    const board = referenceBoardRef.current
    if (!model || !board || contactZ === null) {
      setMessage(contactZ === null ? '请先选择接触面，再执行模拟装配。' : '模拟板或模型尚未准备完成。')
      return null
    }
    if (!anchors.length) {
      setMessage('请先选择至少一个长圆孔或圆孔锚点。')
      return null
    }
    const normalizedAnchors = anchors.map(anchor => anchor.accepts.includes('slot') ? { ...anchor, axis: [0, 1] as [number, number] } : anchor)
    const anchorZ = normalizedAnchors.filter(anchor => anchor.required !== false).map(anchor => anchor.position[2])
    const anchorPlaneSpread = anchorZ.length ? Math.max(...anchorZ) - Math.min(...anchorZ) : 0
    if (anchorPlaneSpread > 1) {
      setMessage(`安装柱端面没有处在同一插入平面（高差 ${anchorPlaneSpread.toFixed(2)} mm）；请检查是否点错端面。`)
      return null
    }
    board.updateMatrixWorld(true)
    const definitions = board.userData.mountTargets as Array<{ kind: 'slot' | 'round'; x: number; y: number }> | undefined
    const thickness = Number(board.userData.thickness ?? 5)
    const targets: AssemblyTarget[] = (definitions ?? []).map((target, index) => {
      const world = new THREE.Vector3(target.x, target.y, thickness).applyMatrix4(board.matrixWorld)
      return {
        id: `calibration:${target.kind}:${index}`,
        panelId: 'calibration-board',
        kind: target.kind,
        x: world.x,
        y: world.y,
        z: world.z,
        ...(target.kind === 'slot' ? { axis: [0, 1] as [number, number] } : {}),
      }
    })
    const boardCenter = new THREE.Box3().setFromObject(board).getCenter(new THREE.Vector3())
    const fit = fitPartAnchors(normalizedAnchors, targets, boardCenter, 180, 4, 0, undefined, contactZ, 0)
    if (!fit) {
      setMessage('当前锚点间距无法匹配模拟板孔位；请检查是否选错端面或选了镜像孔组。')
      return null
    }
    const angleError = Math.abs(Math.atan2(Math.sin(fit.rotationZ), Math.cos(fit.rotationZ)))
    if (angleError > THREE.MathUtils.degToRad(2)) {
      setMessage(`模拟装配需要额外旋转 ${Math.round(THREE.MathUtils.radToDeg(fit.rotationZ))}°；请先调整默认朝向，正确朝向下长孔应保持竖直。`)
      return null
    }
    const inserted = new THREE.Vector3(...fit.position)
    const automaticTravel = estimateSlotLockTravel(normalizedAnchors)
    const activeTravel = manualSlideOverride ? slideY : automaticTravel
    setDetectedSlideY(automaticTravel)
    if (!manualSlideOverride && Math.abs(slideY - automaticTravel) > 1e-6) setSlideY(automaticTravel)
    const locked = inserted.clone().add(new THREE.Vector3(0, -Math.max(0, activeTravel), 0))
    const prepared = { inserted, locked, rotationZ: fit.rotationZ, slideDistance: activeTravel }
    simulationPositionRef.current = prepared
    return prepared
  }

  const simulateInsert = async (): Promise<boolean> => {
    const prepared = prepareSimulation()
    const model = modelRef.current
    if (!prepared || !model) return false
    setSimulationBusy(true)
    setEditingVisualsVisible(false)
    setBoardColliderState('sweeping')
    model.rotation.set(0, 0, prepared.rotationZ)
    model.position.copy(prepared.inserted).add(new THREE.Vector3(0, 0, 24))
    await animateModelPosition(prepared.inserted, 460)
    setBoardColliderState('hit')
    setSimulationPhase('inserted')
    setSimulationBusy(false)
    setMessage('步骤 1 完成：锚点已沿孔截面插入，接触面与板面贴合。')
    return true
  }

  const simulateLock = async () => {
    let prepared = simulationPositionRef.current
    if (!prepared) {
      const inserted = await simulateInsert()
      if (!inserted) return
      prepared = simulationPositionRef.current
    }
    if (!prepared) return
    prepared.locked.copy(prepared.inserted).add(new THREE.Vector3(0, -Math.max(0, prepared.slideDistance), 0))
    setSimulationBusy(true)
    if (prepared.slideDistance > 0) await animateModelPosition(prepared.locked, 360)
    setSimulationPhase('locked')
    setSimulationBusy(false)
    setMessage(prepared.slideDistance > 0
      ? `步骤 2 完成：安装柱代理体向下滑移 ${prepared.slideDistance.toFixed(2)} mm 后碰到长孔底部并停止。`
      : '步骤 2 完成：当前为纯圆孔或无可下滑余量的安装，偏移量为 0 mm，贴面后即完成。')
  }

  const runFullSimulation = async () => {
    if (simulationBusy) return
    const inserted = await simulateInsert()
    if (!inserted) return
    await new Promise<void>(resolve => window.setTimeout(resolve, 180))
    await simulateLock()
  }

  const updateSlideDistance = (value: number) => {
    const next = THREE.MathUtils.clamp(Number.isFinite(value) ? value : 0, 0, 12)
    setManualSlideOverride(true)
    setSlideY(next)
    const prepared = simulationPositionRef.current
    if (!prepared) return
    prepared.slideDistance = next
    prepared.locked.copy(prepared.inserted).add(new THREE.Vector3(0, -next, 0))
    if (simulationPhase === 'locked' && modelRef.current) {
      modelRef.current.position.copy(prepared.locked)
      modelRef.current.updateMatrixWorld(true)
    }
  }

  const setSlideOverrideEnabled = (enabled: boolean) => {
    setManualSlideOverride(enabled)
    if (enabled || detectedSlideY === null) return
    setSlideY(detectedSlideY)
    const prepared = simulationPositionRef.current
    if (prepared) {
      prepared.slideDistance = detectedSlideY
      prepared.locked.copy(prepared.inserted).add(new THREE.Vector3(0, -detectedSlideY, 0))
      if (simulationPhase === 'locked' && modelRef.current) {
        modelRef.current.position.copy(prepared.locked)
        modelRef.current.updateMatrixWorld(true)
      }
    }
  }

  useEffect(() => {
    if (!autoSimulation || !selectionCommitted || !modelReady || contactZ === null || !anchors.length) return
    const timer = window.setTimeout(() => { void runFullSimulation() }, 900)
    return () => window.clearTimeout(timer)
    // 只有用户明确完成孔位后才播放一次；逐个新增锚点绝不能触发装配动画。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSimulation, selectionCommitted, modelReady, contactZ, anchors])

  const removeLast = () => {
    simulationPositionRef.current = null
    setSelectionCommitted(false)
    setDetectedSlideY(null)
    setSimulationPhase('idle')
    setAnchors(current => current.slice(0, -1))
    const patch = patchMeshesRef.current.pop()
    if (patch) {
      patch.removeFromParent()
      patch.geometry.dispose()
      ;(patch.material as THREE.Material).dispose()
    }
  }

  const clearAnchors = () => {
    simulationPositionRef.current = null
    setSelectionCommitted(false)
    setDetectedSlideY(null)
    setManualSlideOverride(false)
    setSlideY(5)
    setSimulationPhase('idle')
    setAnchors([])
    clearVisualPatches()
  }

  const save = async () => {
    if (!anchors.length || !part.packageId || !part.localId) return
    const savedSlideY = manualSlideOverride ? slideY : estimateSlotLockTravel(anchors)
    setSaving(true)
    setMessage('正在写入资源包并刷新配件索引…')
    try {
      const response = await fetch('/api/part-library/calibration', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packageId: part.packageId, localId: part.localId, anchors, orientation, contactZ, slideY: savedSlideY }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`)
      setMessage('标定已保存。')
      onSaved()
    } catch (error) {
      const message = error instanceof TypeError && /fetch/i.test(error.message)
        ? '无法连接本地开发服务（请确认 5173 仍在运行；资源包同步会自动排队后重试）'
        : error instanceof Error ? error.message : String(error)
      setMessage(`保存失败：${message}`)
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
              拖动旋转环 · XYZ 标签位于对应圆弧中点
              <span className="x">X</span><span className="y">Y</span><span className="z">Z</span>
              · 15° / 45° / 90° 刻度
            </div>
          </div>
          <aside className="calib-panel">
            <section className="calib-core-setup">
              <h4>1. 标定安装位置</h4>
              <p>选择孔型并点击安装柱端面；最后选择接触面。端面齐全后会自动开始碰撞装配检测。</p>
              <div className="calib-kind">
                <button className={!contactMode && holeKind === 'slot' ? 'on' : ''} onClick={() => { setContactMode(false); setHoleKind('slot') }}>长圆孔</button>
                <button className={!contactMode && holeKind === 'round' ? 'on' : ''} onClick={() => { setContactMode(false); setHoleKind('round') }}>圆孔</button>
                <button className={contactMode ? 'on' : ''} onClick={() => setContactMode(true)}>接触面</button>
              </div>
              <div className="calib-selection-summary">
                <span className={anchors.length ? 'done' : ''}>孔位 <b>{anchors.length}</b></span>
                <span className={contactZ !== null ? 'done' : ''}>接触面 <b>{contactZ !== null ? contactSource === 'auto' ? '自动' : '手动' : '待识别'}</b></span>
              </div>
              <p className="calib-contact-status">{contactMode ? '请在左侧模型上点击与板面贴合的端面；手动结果会优先保留。' : '可连续选择全部长孔或圆孔；选孔期间不会播放装配动画。'}</p>
              <div className="calib-list-actions">
                <button disabled={!anchors.length} onClick={removeLast}>撤销上一个</button>
                <button disabled={!anchors.length} onClick={clearAnchors}>清空孔位</button>
              </div>
            </section>
            <section className="calib-simulation calib-auto-assembly">
              <h4>2. 自动装配检测</h4>
              <p>板面代理碰撞体会自动控制运动：插入碰到接触面即停；长孔继续向下到安装柱碰底，纯圆孔的下滑量自动为 0。</p>
              <div className="calib-auto-steps">
                <span className={selectionCommitted ? 'done' : ''}><i>1</i>完成选孔</span>
                <span className={simulationPhase !== 'idle' ? 'done' : ''}><i>2</i>插入贴面</span>
                <span className={simulationPhase === 'locked' ? 'done' : ''}><i>3</i>{slideY > 0 ? '下滑碰底' : '零偏移'}</span>
              </div>
              <button type="button" className="calib-auto-run" disabled={simulationBusy || !anchors.length} onClick={completeSelection}>
                {simulationBusy ? '正在检测碰撞…' : selectionCommitted ? '重新识别并装配' : '孔位选择完成 · 自动装配'}
              </button>
              <div className="calib-collision-result">
                {detectedSlideY === null
                  ? '等待孔位与接触面'
                  : detectedSlideY > 0
                    ? `自动停止距离：插入至板面 · 下滑 ${detectedSlideY.toFixed(2)} mm`
                    : '自动停止距离：插入至板面 · 下滑 0 mm（纯圆孔/无余量）'}
              </div>
              <div className="calib-sim-status">
                {simulationPhase === 'idle' ? '等待检测' : simulationPhase === 'inserted' ? '接触面已碰到板面并停止' : '自动装配检测完成'}
                <div><button type="button" disabled={simulationBusy || !anchors.length} onClick={flipHandedness}>上下翻转并重装</button><button type="button" onClick={resetSimulation}>返回标定位置</button></div>
              </div>
            </section>
            <details className="calib-advanced">
              <summary><span>⚙ 高级设置</span><small>朝向、坐标与手动微调</small></summary>
              <div className="calib-advanced-body">
                <h5>默认朝向</h5>
                <p>通常直接拖动左侧旋转环即可；只有自动检测提示需要额外旋转时再调整。</p>
                <div className="calib-rotate-grid">
                  <button onClick={() => rotateDefault(0, -90)}>X −90°</button><button onClick={() => rotateDefault(0, 90)}>X +90°</button>
                  <button onClick={() => rotateDefault(1, -90)}>Y −90°</button><button onClick={() => rotateDefault(1, 90)}>Y +90°</button>
                  <button onClick={() => rotateDefault(2, -90)}>Z −90°</button><button onClick={() => rotateDefault(2, 90)}>Z +90°</button>
                </div>
                <div className="calib-manual-rotate">
                  {(['X', 'Y', 'Z'] as const).map((label, axis) => (
                    <label key={label}>
                      <b>{label}</b>
                      <input type="range" min={-180} max={180} step={1} value={normalizeAngle(orientation[axis])} onChange={event => setOrientationAxis(axis as 0 | 1 | 2, Number(event.target.value))} />
                      <input type="number" min={-180} max={180} step={1} value={Math.round(normalizeAngle(orientation[axis]) * 10) / 10} onChange={event => setOrientationAxis(axis as 0 | 1 | 2, Number(event.target.value))} />
                      <span>°</span>
                    </label>
                  ))}
                  <button onClick={() => setDefaultOrientation([0, 0, 0])}>恢复模型原始朝向</button>
                </div>
                <code>{orientation.map(v => `${Math.round(v * 10) / 10}°`).join(' / ')}</code>

                <h5>定位数据</h5>
                <div className="calib-anchor-list calib-anchor-list-advanced">
                  {anchors.map((anchor, index) => (
                    <div key={anchor.id}>
                      <span className={anchor.accepts.includes('round') ? 'round' : 'slot'}>{index + 1}</span>
                      <b>{anchor.accepts.includes('round') ? '圆孔' : '长圆孔'}</b>
                      <code>{anchor.position.map(v => v.toFixed(2)).join(', ')}{anchor.profile ? ` · ${anchor.profile.width}×${anchor.profile.length}` : ''}</code>
                    </div>
                  ))}
                  {contactZ !== null && <div className="contact"><span className="contact">面</span><b>接触面</b><code>z = {contactZ.toFixed(2)}</code></div>}
                </div>

                <h5>手动检测与覆盖</h5>
                <label className="calib-auto-sim">
                  <input type="checkbox" checked={autoSimulation} onChange={event => setAutoSimulation(event.target.checked)} />
                  <span>完成孔位后自动播放装配动画</span>
                </label>
                <div className="calib-sim-actions">
                  <button type="button" disabled={simulationBusy || contactZ === null || !anchors.length} onClick={() => void simulateInsert()}>仅插入贴面</button>
                  <button type="button" disabled={simulationBusy || contactZ === null || !anchors.length} onClick={() => void simulateLock()}>仅执行下滑</button>
                </div>
                <label className="calib-auto-sim">
                  <input type="checkbox" checked={manualSlideOverride} onChange={event => setSlideOverrideEnabled(event.target.checked)} />
                  <span>手动覆盖自动碰撞距离</span>
                </label>
                <label className="calib-slide-distance">
                  <span>下滑距离</span>
                  <input type="range" min={0} max={12} step={0.25} value={slideY} disabled={!manualSlideOverride} onChange={event => updateSlideDistance(Number(event.target.value))} />
                  <input type="number" min={0} max={12} step={0.25} value={slideY} disabled={!manualSlideOverride} onChange={event => updateSlideDistance(Number(event.target.value))} />
                  <b>mm</b>
                </label>
              </div>
            </details>
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
