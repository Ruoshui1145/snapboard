import * as THREE from 'three'
import { generateSplitPanelMesh } from '../../utils/boardMesh'
import { PEGBOARD_DEFAULT_CONFIG, splitOrthogonalPolygon } from '../../utils/pegboardSplit'

const COLORS = [0x3c82bb, 0x46a88f, 0xd3a83b, 0x8c78b7]

/**
 * 直接调用正式分割引擎，把 400×400 外轮廓切成四块 200×200 标准板。
 * 孔阵列、边缘固定孔、拼缝直角和外角 R8 与主视图/导出模型共用同一实现。
 */
export function createCalibrationReferenceBoard(): THREE.Group {
  const cfg = {
    ...PEGBOARD_DEFAULT_CONFIG,
    bedW: 200,
    bedH: 200,
    minW: 200,
    minH: 200,
  thickness: 5,
    lidThickness: 0.3,
  }
  const result = splitOrthogonalPolygon({
    points: [
      { x: 0, y: 0 },
      { x: 400, y: 0 },
      { x: 400, y: 400 },
      { x: 0, y: 400 },
    ],
  }, cfg)
  const group = new THREE.Group()
  group.name = 'calibration-reference-board'
  for (const [index, panel] of result.panels.entries()) {
    const mesh = generateSplitPanelMesh({ panel, cfg, color: COLORS[index % COLORS.length] })
    mesh.name = `calibration-reference-panel-${panel.id}`
    mesh.traverse(object => {
      const renderable = object as THREE.Mesh
      const materials = Array.isArray(renderable.material)
        ? renderable.material
        : renderable.material ? [renderable.material] : []
      for (const material of materials) {
        material.transparent = true
        material.opacity = 0.34
        material.depthWrite = false
        material.needsUpdate = true
      }
      renderable.renderOrder = -3
    })
    group.add(mesh)
  }
  // 分割引擎输出为 0..400 全局坐标，移到四象限中心。
  group.position.set(-200, -200, 0)
  group.userData.referenceSize = 400
  group.userData.panelCount = result.panels.length
  return group
}

const axisLabel = (text: 'X' | 'Y' | 'Z', color: string, size: number) => {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 128
  const context = canvas.getContext('2d')
  if (context) {
    context.beginPath()
    context.arc(64, 64, 44, 0, Math.PI * 2)
    context.fillStyle = 'rgba(16,19,31,.86)'
    context.fill()
    context.lineWidth = 7
    context.strokeStyle = color
    context.stroke()
    context.fillStyle = color
    context.font = '700 58px system-ui, sans-serif'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(text, 64, 67)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false })
  const sprite = new THREE.Sprite(material)
  sprite.name = `rotation-axis-label-${text.toLowerCase()}`
  sprite.scale.setScalar(size)
  sprite.renderOrder = 44
  return sprite
}

const createAxisRing = (axis: 0 | 1 | 2, color: number, radius: number) => {
  const root = new THREE.Group()
  root.name = `rotation-axis-${axis}`
  root.userData.rotationRadius = radius
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(radius, Math.max(0.32, radius * 0.012), 8, 128),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.27,
      depthTest: false,
      depthWrite: false,
    }),
  )
  ring.name = `rotation-ring-${axis}`
  ring.userData.rotationAxis = axis
  ring.userData.baseOpacity = 0.27
  ring.renderOrder = 40 + axis
  root.add(ring)

  // 15°短刻度、45°长刻度、90°最长刻度。
  const tickPositions: number[] = []
  for (let degrees = 0; degrees < 360; degrees += 15) {
    const radians = THREE.MathUtils.degToRad(degrees)
    const is90 = degrees % 90 === 0
    const is45 = degrees % 45 === 0
    const length = radius * (is90 ? 0.13 : is45 ? 0.085 : 0.045)
    const inner = radius - length * 0.45
    const outer = radius + length * 0.55
    tickPositions.push(
      Math.cos(radians) * inner, Math.sin(radians) * inner, 0,
      Math.cos(radians) * outer, Math.sin(radians) * outer, 0,
    )
  }
  const tickGeometry = new THREE.BufferGeometry()
  tickGeometry.setAttribute('position', new THREE.Float32BufferAttribute(tickPositions, 3))
  const ticks = new THREE.LineSegments(tickGeometry, new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 0.58,
    depthTest: false,
    depthWrite: false,
  }))
  ticks.name = `rotation-ticks-${axis}`
  ticks.renderOrder = 43
  root.add(ticks)

  // 每个旋转环增加一个独立的拖动箭头。它跟随当前吸附刻度移动，
  // 比在三条重叠圆环的交点上找鼠标命中更容易理解。
  const handleSize = Math.max(1.8, radius * 0.075)
  const handle = new THREE.Mesh(
    new THREE.ConeGeometry(handleSize * 0.72, handleSize * 1.55, 4),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
    }),
  )
  handle.name = `rotation-handle-${axis}`
  handle.userData.rotationAxis = axis
  handle.userData.rotationHandle = true
  handle.userData.baseOpacity = 0.95
  handle.renderOrder = 45 + axis
  handle.position.set(radius * 1.04, 0, 0)
  handle.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0))
  root.add(handle)

  if (axis === 0) root.rotation.y = Math.PI / 2 // YZ 平面，法向 +X
  if (axis === 1) root.rotation.x = -Math.PI / 2 // XZ 平面，法向 +Y
  return root
}

/** 更新某条旋转环上的箭头位置；angle 使用该圆环自身的局部平面角度。 */
export function setRotationGizmoAngle(gizmo: THREE.Group, axis: 0 | 1 | 2, angle: number): void {
  const root = gizmo.getObjectByName(`rotation-axis-${axis}`)
  const handle = root?.getObjectByName(`rotation-handle-${axis}`) as THREE.Mesh | undefined
  const radius = Number(root?.userData.rotationRadius ?? gizmo.userData.radius ?? 0)
  if (!handle || !Number.isFinite(radius) || radius <= 0) return
  const x = Math.cos(angle) * radius * 1.04
  const y = Math.sin(angle) * radius * 1.04
  handle.position.set(x, y, 0)
  handle.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0),
  )
  handle.userData.rotationAngle = angle
}

export function setRotationGizmoAngles(gizmo: THREE.Group, orientation: [number, number, number]): void {
  // 修正 Y 环法向后，三个局部圆环角度都与 +X/+Y/+Z 右手方向一致。
  const signs = [1, 1, 1] as const
  for (const axis of [0, 1, 2] as const) {
    setRotationGizmoAngle(gizmo, axis, THREE.MathUtils.degToRad(orientation[axis]) * signs[axis])
  }
}

/** Bambu Studio 风格三轴旋转环；环上的 rotationAxis 用于射线命中和拖动。 */
export function createRotationGizmo(radius: number): THREE.Group {
  const group = new THREE.Group()
  group.name = 'calibration-rotation-gizmo'
  group.add(createAxisRing(0, 0xff6b72, radius))
  group.add(createAxisRing(1, 0x65d58a, radius))
  group.add(createAxisRing(2, 0x62a8ff, radius))

  const labelSize = Math.max(5.5, radius * 0.15)
  const x = axisLabel('X', '#ff6b72', labelSize)
  const y = axisLabel('Y', '#65d58a', labelSize)
  const z = axisLabel('Z', '#62a8ff', labelSize)
  // 标签不要再放在三个轴的端点：端点是三条圆环的交错区域，容易让人误以为
  // 那里是“坐标原点/交点”。把每个标签放到对应旋转平面的圆弧中点：
  // X → YZ 圆弧，Y → XZ 圆弧，Z → XY 圆弧。diag 让标签中心略微落在圆环外侧。
  const diag = radius * 0.82
  x.position.set(0, diag, diag)
  y.position.set(diag, 0, diag)
  z.position.set(diag, diag, 0)
  group.add(x, y, z)
  group.userData.radius = radius
  return group
}
