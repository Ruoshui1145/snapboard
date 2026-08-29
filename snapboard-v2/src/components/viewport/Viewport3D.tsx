// ============ 3D 视口 — 板子 + 配件 + 拖放吸附 ============
import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { OutlinePass } from 'three/examples/jsm/postprocessing/OutlinePass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { useAppStore } from '../../store/useAppStore'
import { generateBoardMesh, generateSplitPanelMesh, makePanelLabel } from '../../utils/boardMesh'
import { findNearestHole, boardHoles, type BoardGeometry } from '../../utils/snapToHole'
import { loadPartModel } from '../../utils/glbLoader'
import { MovePartCommand, PlacePartCommand, RemovePartCommand } from '../../commands/BoardCommands'
import { usePartLibrary } from '../../hooks/usePartLibrary'
import { playHoleTapSound } from '../../utils/interactionSound'
import { mountNeedsCalibration, partPreviewPath, type PartDefinition, type PartMountAnchor, type PlacedPart } from '../../partLibrary/types'
import { anchorsForSide, contactZForSide, fitPartAnchors, openCoveredAssemblyTargets, splitPanelTargets, type AssemblyFit, type AssemblyTarget } from '../../utils/assemblySnap'
import { subscribePartDrag, type PartDragPayload } from '../../utils/partDragSession'
import { applyBoardTexture, createBoardTextureCanvas, getSplitPanelTextureBounds } from '../../utils/boardTexture'
import { stabilizeSlotAxis } from '../../utils/mountAxis.js'
import { assemblySideForView, type AssemblySide } from '../../utils/assemblySide.js'
import type { BoardTextureConfig } from '../../types/geometry'

const SPLIT_PANEL_COLORS = [0x3ec6b0, 0xffd166, 0xb39ddb, 0x5ea4ff]
const SPLIT_PANEL_HEX = ['#3ec6b0', '#ffd166', '#b39ddb', '#5ea4ff']
type ViewPreset = 'free' | 'front' | 'back'

/** 已被其他装配件占用的孔位 id 集合。孔为穿板贯通孔, 正/背面共用同一组孔:
 *  一件正面件 + 一件背面固定件不能同时占一个孔。移动/旋转自身时排除自己占的孔。 */
function occupiedTargetIds(exceptPartId?: string): Set<string> {
  const ids = new Set<string>()
  for (const p of useAppStore.getState().placedParts) {
    if (p.id === exceptPartId) continue
    for (const targetId of p.placement?.targetIds ?? []) ids.add(targetId)
  }
  return ids
}

interface DragPreviewState {
  x: number
  y: number
  valid: boolean
  text: string
}

interface MovingPartState {
  partId: string
  original: PlacedPart
  object: THREE.Object3D
  pointerId: number
  startX: number
  startY: number
  moved: boolean
  fit: AssemblyFit | null
}

interface TextureMoveState {
  pointerId: number
  startPoint: THREE.Vector3
  originOffsetX: number
  originOffsetY: number
  deltaX: number
  deltaY: number
}

export function Viewport3D() {
  const containerRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const boards = useAppStore(s => s.boards)
  const placedParts = useAppStore(s => s.placedParts)
  const splitResult = useAppStore(s => s.splitResult)
  const splitCfg = useAppStore(s => s.splitConfig)
  const boardTexture = useAppStore(s => s.boardTexture)
  const textureStudioOpen = useAppStore(s => s.ui.textureStudioOpen)
  const setBoardTexture = useAppStore(s => s.setBoardTexture)
  const toggleEdgeHole = useAppStore(s => s.toggleEdgeHole)
  const openEdgeHole = useAppStore(s => s.openEdgeHole)
  const execute = useAppStore(s => s.execute)
  const selectedPartId = useAppStore(s => s.ui.selectedPartId)
  const setUI = useAppStore(s => s.setUI)
  const selectedPartIdRef = useRef<string | null>(null)
  const { index: libIndex } = usePartLibrary()
  const partDefsRef = useRef<PartDefinition[]>([])
  partDefsRef.current = libIndex?.parts ?? []
  const [dragPreview, setDragPreview] = useState<DragPreviewState | null>(null)
  const [assemblyMessage, setAssemblyMessage] = useState<string | null>(null)
  const [highlightRevision, setHighlightRevision] = useState(0)
  const [viewPreset, setViewPreset] = useState<ViewPreset>('free')
  const viewPresetRef = useRef<ViewPreset>('free')
  const dragDataRef = useRef<PartDragPayload | null>(null)
  const dragModelRef = useRef<THREE.Object3D | null>(null)
  const dragLoadTokenRef = useRef(0)
  const movingPartRef = useRef<MovingPartState | null>(null)
  const textureMoveRef = useRef<TextureMoveState | null>(null)
  const textureWheelScaleRef = useRef(boardTexture.scale)
  const textureWheelTimerRef = useRef<number | null>(null)
  const [textureDragging, setTextureDragging] = useState(false)
  const freeViewRef = useRef<{ position: THREE.Vector3; target: THREE.Vector3 } | null>(null)
  const panelClickStartRef = useRef<{ x: number; y: number; button: number } | null>(null)
  // 不包含 knocked/manual 等交互状态；仅板件几何布局改变时才允许自动取景。
  const splitLayoutKeyRef = useRef<string | null>(null)
  viewPresetRef.current = viewPreset
  selectedPartIdRef.current = selectedPartId
  const textureMappingMode = textureStudioOpen && boardTexture.enabled && boardTexture.source === 'image' && Boolean(boardTexture.imageDataUrl)

  useEffect(() => {
    if (textureWheelTimerRef.current === null) textureWheelScaleRef.current = boardTexture.scale
  }, [boardTexture.scale])

  useEffect(() => () => {
    if (textureWheelTimerRef.current !== null) window.clearTimeout(textureWheelTimerRef.current)
  }, [])

  useEffect(() => {
    const overlay = sceneRef.current?.userData.textureBoundsOverlay as THREE.LineLoop | undefined
    if (overlay) overlay.visible = textureMappingMode
  }, [textureMappingMode])

  // 场景初始化 (一次性)
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x1a1a2e)
    sceneRef.current = scene
    splitLayoutKeyRef.current = null // 新建场景/相机后允许首次自动取景

    const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 5000)
    camera.position.set(300, 250, 300)
    camera.lookAt(0, 100, 0)
    scene.userData.camera = camera  // 供 drop 时 raycast 使用

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setSize(container.clientWidth, container.clientHeight)
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.05
    container.appendChild(renderer.domElement)

    const composer = new EffectComposer(renderer)
    composer.setPixelRatio(window.devicePixelRatio)
    composer.setSize(container.clientWidth, container.clientHeight)
    composer.addPass(new RenderPass(scene, camera))
    const outlinePass = new OutlinePass(
      new THREE.Vector2(container.clientWidth, container.clientHeight),
      scene,
      camera,
    )
    outlinePass.edgeStrength = 5.5
    outlinePass.edgeGlow = 0.75
    outlinePass.edgeThickness = 1.4
    outlinePass.pulsePeriod = 1.8
    outlinePass.visibleEdgeColor.set(0x62e6cf)
    outlinePass.hiddenEdgeColor.set(0x176e66)
    composer.addPass(outlinePass)
    composer.addPass(new OutputPass())
    scene.userData.composer = composer
    scene.userData.outlinePass = outlinePass

    const snapHighlights = new THREE.Group()
    snapHighlights.name = 'snap-target-highlights'
    scene.userData.snapHighlights = snapHighlights
    scene.add(snapHighlights)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.screenSpacePanning = true
    controls.target.set(0, 100, 0)
    scene.userData.controls = controls  // 供分割面板自动取景使用

    scene.add(new THREE.AmbientLight(0xffffff, 0.7))
    const dir = new THREE.DirectionalLight(0xffffff, 1.2)
    dir.position.set(200, 400, 200)
    scene.add(dir)
    const dir2 = new THREE.DirectionalLight(0xffffff, 0.4)
    dir2.position.set(-200, 100, -200)
    scene.add(dir2)

    const grid = new THREE.GridHelper(2000, 50, 0x0f3460, 0x16213e)
    scene.add(grid)

    let raf = 0
    const animate = () => {
      raf = requestAnimationFrame(animate)
      controls.update()
      const pulse = 0.48 + Math.sin(performance.now() * 0.008) * 0.22
      snapHighlights.traverse(object => {
        const material = (object as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined
        if (material?.userData.snapHighlight) material.opacity = pulse
      })
      composer.render()
    }
    animate()

    const onResize = () => {
      const width = Math.max(1, container.clientWidth)
      const height = Math.max(1, container.clientHeight)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      renderer.setSize(width, height)
      composer.setSize(width, height)
    }
    const resizeObserver = new ResizeObserver(onResize)
    resizeObserver.observe(container)
    window.addEventListener('resize', onResize)

    return () => {
      cancelAnimationFrame(raf)
      resizeObserver.disconnect()
      window.removeEventListener('resize', onResize)
      outlinePass.dispose()
      composer.dispose()
      renderer.dispose()
      container.removeChild(renderer.domElement)
      if (sceneRef.current === scene) sceneRef.current = null
    }
  }, [])

  /** 递归释放子树的 geometry / material (重建网格前调用) */
  const disposeSubtree = (root: THREE.Object3D) => {
    root.traverse(o => {
      const mesh = o as THREE.Mesh
      if (mesh.geometry) mesh.geometry.dispose()
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined
      const disposeMaterial = (material: THREE.Material) => {
        const map = (material as THREE.MeshStandardMaterial).map
        if (map?.userData.snapboardTexture) map.dispose()
        material.dispose()
      }
      if (Array.isArray(mat)) mat.forEach(disposeMaterial)
      else if (mat) disposeMaterial(mat)
    })
  }

  // 配件库拖拽会话：隐藏 HTML 卡片拖影，在 Three.js 场景中加载半透明真实模型。
  useEffect(() => subscribePartDrag(payload => {
    dragDataRef.current = payload
    const scene = sceneRef.current
    const token = ++dragLoadTokenRef.current
    if (dragModelRef.current && scene) {
      scene.remove(dragModelRef.current)
      disposeSubtree(dragModelRef.current)
      dragModelRef.current = null
    }
    if (!payload || !scene) {
      setDragPreview(null)
      setHighlightRevision(revision => revision + 1)
      return
    }
    const def = partDefsRef.current.find(part => part.id === payload.defId)
    const previewPath = def && partPreviewPath(def)
    if (!def || !previewPath) return
    loadPartModel(`/partLibrary/${previewPath}`, def.model)
      .then(model => {
        if (token !== dragLoadTokenRef.current || !sceneRef.current) {
          disposeSubtree(model)
          return
        }
        model.name = 'drag-part-preview'
        model.visible = false
        stylePartPreview(model, false)
        attachPreviewAnchorMarkers(model, def)
        dragModelRef.current = model
        sceneRef.current.add(model)
      })
      .catch(error => setAssemblyMessage(`无法预览配件：${error instanceof Error ? error.message : String(error)}`))
  }), [libIndex])

  // 渲染板子 (boards 变化时重建)
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return

    // 移除旧的板子网格 (name=board-mesh) — 正确释放 geometry + material
    for (const child of [...scene.children]) {
      if ((child as THREE.Mesh).name === 'board-mesh') {
        scene.remove(child)
        disposeSubtree(child)
      }
    }

    for (const b of boards) {
      // 像素→mm: board.contour 已是 mm (设计时约定)
      // 这里把 contour 视作 mm 直接生成网格
      const mesh = generateBoardMesh({
        contourPts: b.contour,
        pixelToMM: 1,           // contour 已是 mm
        thickness: b.thickness,
        holePattern: b.holePattern,
      })
      mesh.name = 'board-mesh'
      // 竖直挂墙: 板面 = 世界 XY 平面 (局部 x→世界 x, 局部 y(板面向上)→世界 y,
      // 厚度沿 +z 朝前), 板底边落在地面 y = position.y 上
      mesh.position.set(b.position.x, b.position.y, b.position.z)
      scene.add(mesh)
    }
  }, [boards])

  // ---- 渲染分割面板 (splitResult 变化时重建): 圆角板 + 长圆孔 + 拼接孔 + 编号 ----
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    let cancelled = false

    const rebuildPanels = async () => {
      let texture: THREE.CanvasTexture | null = null
      const panels = splitResult?.panels ?? []
      if (panels.length && boardTexture.enabled) {
        try {
          const textureBounds = getSplitPanelTextureBounds(panels)
          const canvas = await createBoardTextureCanvas(boardTexture, textureBounds.width / textureBounds.height)
          if (cancelled) return
          if (canvas) {
            texture = new THREE.CanvasTexture(canvas)
            texture.colorSpace = THREE.SRGBColorSpace
            texture.wrapS = THREE.ClampToEdgeWrapping
            texture.wrapT = THREE.ClampToEdgeWrapping
            texture.userData.snapboardTexture = true
            texture.needsUpdate = true
          }
        } catch (error) {
          console.warn('纹理预览生成失败', error)
        }
      }
      if (cancelled) {
        texture?.dispose()
        return
      }

      // 新纹理准备好后再替换旧装配，滑动参数时不会短暂闪回纯色板。
      scene.userData.boardTexturePreview = null
      scene.userData.textureBoundsOverlay = null
      for (const child of [...scene.children]) {
        if ((child as THREE.Object3D).name?.startsWith('split-panel') ||
            (child as THREE.Object3D).name?.startsWith('split-assembly') ||
            child.name === 'texture-image-bounds') {
          scene.remove(child)
          disposeSubtree(child)
        }
      }
      if (!panels.length) {
        splitLayoutKeyRef.current = null
        texture?.dispose()
        return
      }

      const layoutKey = JSON.stringify(panels.map(p => ({
        id: p.id,
        x: p.x, y: p.y, w: p.w, h: p.h,
        contour: p.contour,
      })))
      const shouldAutoFrame = splitLayoutKeyRef.current !== layoutKey
      splitLayoutKeyRef.current = layoutKey
      const textureBounds = getSplitPanelTextureBounds(panels)

      // 装配组: 所有面板/标签以【全局 mm】放入组内, 组整体平移到原点居中。
      const assembly = new THREE.Group()
      assembly.name = 'split-assembly'

      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      panels.forEach((p, i) => {
        const color = SPLIT_PANEL_COLORS[i % SPLIT_PANEL_COLORS.length]
        let mesh: THREE.Object3D
        if (texture) {
          const structuralThickness = Math.max(0.2, splitCfg.thickness - boardTexture.textureThickness)
          const textureThickness = Math.max(0.08, splitCfg.thickness - structuralThickness)
          mesh = new THREE.Group()
          const body = generateSplitPanelMesh({
            panel: p,
            cfg: { ...splitCfg, thickness: structuralThickness },
            color: 0x334b55,
            includeGuides: false,
            manufacturingChamfer: splitCfg.manufacturingChamfer,
          })
          body.name = `split-panel-body-${p.id}`
          const surface = generateSplitPanelMesh({
            panel: p,
            cfg: { ...splitCfg, thickness: textureThickness },
            color,
            includeGuides: true,
            manufacturingChamfer: splitCfg.manufacturingChamfer,
          })
          surface.name = `split-panel-texture-${p.id}`
          surface.position.z = structuralThickness
          applyBoardTexture(surface, texture, textureBounds)
          mesh.add(body, surface)
        } else {
          mesh = generateSplitPanelMesh({ panel: p, cfg: splitCfg, color })
        }
        mesh.name = 'split-panel-' + p.id
        assembly.add(mesh)

        const label = makePanelLabel(p.id, texture ? '#f4f7fb' : SPLIT_PANEL_HEX[i % SPLIT_PANEL_HEX.length])
        label.name = 'split-panel-' + p.id
        label.visible = viewPresetRef.current !== 'back'
        label.position.set(p.x + p.w / 2, p.y + p.h / 2, splitCfg.thickness + 6)
        assembly.add(label)

        minX = Math.min(minX, p.x)
        maxX = Math.max(maxX, p.x + p.w)
        minY = Math.min(minY, p.y)
        maxY = Math.max(maxY, p.y + p.h)
      })

      const cx = (minX + maxX) / 2
      const midY = (minY + maxY) / 2
      assembly.position.set(-cx, -minY, 0)
      scene.add(assembly)
      scene.userData.boardTexturePreview = texture
      scene.userData.textureMapping = {
        minX: minX - cx,
        maxX: maxX - cx,
        minY: 0,
        maxY: maxY - minY,
        width: Math.max(1, maxX - minX),
        height: Math.max(1, maxY - minY),
      }
      const imageBounds = createTextureBoundsOverlay(
        boardTexture,
        scene.userData.textureMapping,
        splitCfg.thickness + 1.1,
      )
      imageBounds.visible = useAppStore.getState().ui.textureStudioOpen && boardTexture.enabled && boardTexture.source === 'image'
      scene.userData.textureBoundsOverlay = imageBounds
      scene.add(imageBounds)
      scene.userData.assemblyView = {
        centerY: midY - minY,
        size: Math.max(maxX - minX, maxY - minY, 300),
      }

      const camera = scene.userData.camera as THREE.PerspectiveCamera | undefined
      const controls = scene.userData.controls as OrbitControls | undefined
      if (camera && controls && shouldAutoFrame && viewPresetRef.current === 'free') {
        const size = Math.max(maxX - minX, maxY - minY, 300)
        controls.target.set(0, midY - minY, 0)
        camera.position.set(size * 0.85, (midY - minY) + size * 0.45, size * 0.95)
        camera.near = 1
        camera.far = Math.max(5000, size * 10)
        camera.updateProjectionMatrix()
      }
    }

    void rebuildPanels()
    return () => { cancelled = true }
  }, [splitResult, splitCfg, boardTexture])

  // 渲染配件 (placedParts 变化时重建)
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return

    // 移除旧配件 — 释放 geometry/material
    for (const child of [...scene.children]) {
      if ((child as THREE.Object3D).name?.startsWith('part-')) {
        scene.remove(child)
        disposeSubtree(child)
      }
    }

    for (const p of placedParts) {
      const def = partDefsRef.current?.find(d => d.id === p.defId)
      if (!def) continue
      const previewPath = partPreviewPath(def)
      if (!previewPath) continue
      const partId = p.id

      if (p.placement) {
        loadPartModel(`/partLibrary/${previewPath}`, def.model)
          .then(obj => {
            const stillPlaced = useAppStore.getState().placedParts.find(x => x.id === partId)
            if (!stillPlaced?.placement || !sceneRef.current) return
            obj.name = `part-${partId}`
            applyAssemblyTransform(
              obj,
              stillPlaced.placement.position,
              stillPlaced.placement.rotationZ,
              stillPlaced.placement.side ?? 'front',
            )
            obj.userData.placedPartId = partId
            sceneRef.current.add(obj)
            if (selectedPartIdRef.current === partId) {
              const outline = sceneRef.current.userData.outlinePass as OutlinePass | undefined
              if (outline) outline.selectedObjects = [obj]
            }
          })
          .catch(error => setAssemblyMessage(`配件模型加载失败：${error instanceof Error ? error.message : String(error)}`))
        continue
      }

      const board = boards.find(b => b.id === p.boardId)
      if (!board || !p.holePos) continue
      const holePos = p.holePos

      // 计算孔心世界坐标 (晶体错列阵列, 与 3D 挖孔完全一致)
      const { holePattern } = board
      const bw = board.contour.reduce((m, pt) => Math.max(m, pt.x), 0)
      const bh = board.contour.reduce((m, pt) => Math.max(m, pt.y), 0)
      const hole = boardHoles(bw, bh, holePattern).find(h => h.row === holePos.row && h.col === holePos.col)
      if (!hole) continue
      const hx = hole.x
      const hy = hole.y

      // 加载 GLB (从 public/partLibrary/index.json 获取定义)
      loadPartModel(`/partLibrary/${previewPath}`, def.model)
        .then(obj => {
          // 异步竞态保护: 若配件已被移除/板子已变, 不添加
          const stillPlaced = useAppStore.getState().placedParts.find(x => x.id === partId)
          if (!stillPlaced || !sceneRef.current) return
          const sceneNow = sceneRef.current
          obj.name = `part-${partId}`
          obj.userData.placedPartId = partId
          obj.position.set(board.position.x + hx, board.position.y + hy, board.position.z + board.thickness)
          obj.rotation.y = p.rotation
          sceneNow.add(obj)
          if (selectedPartIdRef.current === partId) {
            const outline = sceneNow.userData.outlinePass as OutlinePass | undefined
            if (outline) outline.selectedObjects = [obj]
          }
        })
        .catch(error => setAssemblyMessage(`配件模型加载失败：${error instanceof Error ? error.message : String(error)}`))
    }
  }, [placedParts, boards, libIndex])

  // 单选轮廓 + 已占用孔位反馈；模型异步加载完成时上方回调会补挂 outline。
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    const outline = scene.userData.outlinePass as OutlinePass | undefined
    const highlightGroup = scene.userData.snapHighlights as THREE.Group | undefined
    const selectedRoot = selectedPartId
      ? scene.children.find(child => child.userData.placedPartId === selectedPartId)
      : undefined
    if (outline) outline.selectedObjects = selectedRoot ? [selectedRoot] : []
    if (!highlightGroup) return
    const selected = selectedPartId ? placedParts.find(part => part.id === selectedPartId) : undefined
    if (!selected?.placement || !splitResult?.panels.length) {
      clearSnapHighlights(highlightGroup)
      return
    }
    const side = selected.placement.side ?? 'front'
    const occupied = new Set(selected.placement.targetIds)
    const targets = splitPanelTargets(splitResult.panels, splitCfg, side).filter(target => occupied.has(target.id))
    renderSnapHighlights(highlightGroup, targets, side, 0x62e6cf)
  }, [selectedPartId, placedParts, splitResult, splitCfg, highlightRevision])

  const rayAt = (clientX: number, clientY: number): THREE.Raycaster | null => {
    const scene = sceneRef.current
    const container = containerRef.current
    const camera = scene?.userData.camera as THREE.PerspectiveCamera | undefined
    if (!scene || !container || !camera) return null
    const rect = container.getBoundingClientRect()
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    ), camera)
    return raycaster
  }

  const pointOnAssemblyPlane = (clientX: number, clientY: number, side: AssemblySide): THREE.Vector3 | null => {
    const raycaster = rayAt(clientX, clientY)
    if (!raycaster) return null
    const surfaceZ = side === 'front' ? splitCfg.thickness : 0
    return raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -surfaceZ), new THREE.Vector3())
  }

  /** 自由视角可从板前或板后拖入；锁定视角则严格服从“正面/背面”按钮。 */
  const assemblySideAtView = (): AssemblySide => {
    const camera = sceneRef.current?.userData.camera as THREE.PerspectiveCamera | undefined
    return assemblySideForView(viewPresetRef.current, camera?.position.z ?? splitCfg.thickness, splitCfg.thickness)
  }

  const resolveSplitFit = (
    def: PartDefinition,
    clientX: number,
    clientY: number,
    side: AssemblySide,
    occupiedIds?: ReadonlySet<string>,
  ): { fit: AssemblyFit | null; point: THREE.Vector3 | null } => {
    const point = pointOnAssemblyPlane(clientX, clientY, side)
    const mount = typeof def.mount === 'object' ? def.mount : null
    if (!point || !splitResult?.panels.length || !mount || mountNeedsCalibration(def)) {
      return { fit: null, point }
    }
    const targets = splitPanelTargets(splitResult.panels, splitCfg, side)
    const anchors = anchorsForSide(mount.anchors, side)
    return { fit: fitPartAnchors(anchors, targets, point, 35, 4, undefined, occupiedIds, contactZForSide(mount.contactZ, side)), point }
  }

  /** 即使整组锚点尚未匹配，也把光标附近可用孔显示出来，让用户能看见应靠近的位置。 */
  const nearbyCompatibleTargets = (
    def: PartDefinition,
    point: THREE.Vector3 | null,
    side: AssemblySide,
    occupiedIds: ReadonlySet<string>,
  ): AssemblyTarget[] => {
    const mount = typeof def.mount === 'object' ? def.mount : null
    const first = mount?.anchors[0]
    if (!point || !first || !splitResult?.panels.length) return []
    return splitPanelTargets(splitResult.panels, splitCfg, side)
      .filter(target => !occupiedIds.has(target.id))
      .filter(target => first.accepts.includes('either') || first.accepts.includes(target.kind))
      .map(target => ({ target, distance: Math.hypot(target.x - point.x, target.y - point.y) }))
      .filter(item => item.distance <= 55)
      .sort((a, b) => a.distance - b.distance)
      // 这里只显示一个最近引导孔；完整匹配成功后再一次性显示真实锚点数量的孔组。
      .slice(0, 1)
      .map(item => item.target)
  }

  const previewFreePosition = (
    def: PartDefinition,
    point: THREE.Vector3,
    side: AssemblySide,
  ): [number, number, number] => {
    const mount = typeof def.mount === 'object' ? def.mount : null
    const first = mount?.anchors.length ? anchorsForSide(mount.anchors, side)[0] : null
    return first
      ? [point.x - first.position[0], point.y - first.position[1], point.z - first.position[2]]
      : [point.x, point.y, point.z]
  }

  // 拖放: 吸附到最近孔位
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    let data = dragDataRef.current
    const transfer = e.dataTransfer.getData('application/snapboard-part')
    if (transfer) {
      try { data = JSON.parse(transfer) } catch { /* 下方会按无数据处理 */ }
    }
    if (!data) return
    const rect = containerRef.current!.getBoundingClientRect()
    const mouse = { x: e.clientX - rect.left, y: e.clientY - rect.top }

    // 屏幕 → 世界 (简化: 投影到 y=0 平面, 实际应 raycast)
    // 这里用相机射线求交 (Three.js 标准做法)
    const scene = sceneRef.current!
    const camera = findCamera(scene)
    if (!camera) return

    const ndc = new THREE.Vector2(
      (mouse.x / rect.width) * 2 - 1,
      -(mouse.y / rect.height) * 2 + 1,
    )
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(ndc, camera)
    const intersections = raycaster.intersectObjects(scene.children, true)
    const def = partDefsRef.current.find(d => d.id === data.defId)
    if (!def) {
      setAssemblyMessage('找不到该配件定义，请等待资源包刷新后重试。')
      return
    }

    // 新版自动分割板：长圆孔 + 板内圆形敲落孔统一为装配目标，多锚点保持真实孔距配准。
    if (splitResult?.panels.length) {
      const mount = typeof def.mount === 'object' ? def.mount : null
      if (!mount || mountNeedsCalibration(def)) {
        setAssemblyMessage('该配件尚未标定吸附端面，请点击配件卡片右侧的设置按钮。')
        return
      }
      const side = assemblySideAtView()
      const { fit } = resolveSplitFit(def, e.clientX, e.clientY, side, occupiedTargetIds())
      if (!fit) {
        setAssemblyMessage('附近孔型或孔距与配件锚点不匹配，请靠近正确的一组孔位。')
        return
      }
      const primaryPanel = fit.targets[0]?.panelId
      const placedId = `part-${Date.now()}`
      execute(new PlacePartCommand({
        id: placedId,
        defId: data.defId,
        rotation: fit.rotationZ,
        params: data.params,
        placement: {
          surface: 'split-panel',
          side,
          panelId: primaryPanel,
          position: fit.position,
          rotationZ: fit.rotationZ,
          targetIds: fit.targets.map(target => target.id),
        },
      }))
      // 装配到尚未打孔的候选位置时，按已经选定的目标直接切换为贯通孔。
      openCoveredAssemblyTargets(fit.targets, openEdgeHole)
      setAssemblyMessage(`已在${side === 'front' ? '正面' : '背面'}吸附 ${fit.targets.length} 个锚点${fit.targets.some(target => target.covered) ? '，并打通所需圆孔' : ''}。`)
      setUI({ selectedPartId: placedId })
      dragDataRef.current = null
      setDragPreview(null)
      playHoleTapSound()
      return
    }

    // 孔网格参数: 按板子轮廓 + 晶体错列孔阵列实际计算 (修复: 此前写死 1×1 导致永远吸附 (0,0))
    const boardsGeo: BoardGeometry[] = boards.map(b => {
      const w = b.contour.reduce((m, pt) => Math.max(m, pt.x), 0)
      const h = b.contour.reduce((m, pt) => Math.max(m, pt.y), 0)
      return {
        boardId: b.id,
        origin: { x: b.position.x, y: b.position.y, z: b.position.z },
        holePattern: b.holePattern,
        holes: boardHoles(w, h, b.holePattern),
      }
    })
    // 只接受落在板子网格上的命中 (忽略地面网格/其他物件)
    const hit = intersections.find(o => o.object.name === 'board-mesh')
    if (!hit) return

    // 找到命中板子的最近孔位 (竖直板面 = 世界 XY, 直接取命中点的 x/y)
    const hitPt = hit.point
    const nearest = findNearestHole({ x: hitPt.x, y: hitPt.y }, boardsGeo, 100)
    if (!nearest) return

    const board = boards.find(b => b.id === nearest.boardId)!

    const placedId = `part-${Date.now()}`
    execute(new PlacePartCommand({
      id: placedId,
      defId: data.defId,
      boardId: board.id,
      holePos: { row: nearest.row, col: nearest.col },
      rotation: 0,
      params: data.params,
    }))
    setUI({ selectedPartId: placedId })
    dragDataRef.current = null
    setDragPreview(null)
  }

  // 拖拽悬停: 显示吸附预览
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    const rect = containerRef.current?.getBoundingClientRect()
    const data = dragDataRef.current
    const def = data && partDefsRef.current.find(part => part.id === data.defId)
    if (!rect || !def) return
    const side = assemblySideAtView()
    const { fit, point } = resolveSplitFit(def, e.clientX, e.clientY, side, occupiedTargetIds())
    const previewModel = dragModelRef.current
    if (previewModel && point) {
      previewModel.visible = true
      if (fit) applyAssemblyTransform(previewModel, fit.position, fit.rotationZ, side)
      else applyAssemblyTransform(previewModel, previewFreePosition(def, point, side), 0, side)
      stylePartPreview(previewModel, !!fit)
    }
    const highlightGroup = sceneRef.current?.userData.snapHighlights as THREE.Group | undefined
    if (highlightGroup) {
      if (fit) renderSnapHighlights(highlightGroup, fit.targets, side, 0x62e6cf)
      else {
        const nearby = nearbyCompatibleTargets(def, point, side, occupiedTargetIds())
        if (nearby.length) renderSnapHighlights(highlightGroup, nearby, side, 0xffd166)
        else clearSnapHighlights(highlightGroup)
      }
    }
    setDragPreview({
      x: e.clientX - rect.left + 12,
      y: e.clientY - rect.top + 12,
      valid: !!fit,
      text: fit
        ? `${side === 'front' ? '正面' : '背面'} · ${fit.targets.length} 个锚点已匹配`
        : `${side === 'front' ? '正面' : '背面'} · 靠近匹配孔位`,
    })
  }

  const texturePoint = (clientX: number, clientY: number): { point: THREE.Vector3; mapping: { minX: number; maxX: number; minY: number; maxY: number; width: number; height: number } } | null => {
    if (!textureMappingMode || viewPresetRef.current === 'back') return null
    const point = pointOnAssemblyPlane(clientX, clientY, 'front')
    const mapping = sceneRef.current?.userData.textureMapping as { minX: number; maxX: number; minY: number; maxY: number; width: number; height: number } | undefined
    if (!point || !mapping || point.x < mapping.minX || point.x > mapping.maxX || point.y < mapping.minY || point.y > mapping.maxY) return null
    return { point, mapping }
  }

  const beginTextureMove = (e: React.PointerEvent<HTMLDivElement>): boolean => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return false
    const hit = texturePoint(e.clientX, e.clientY)
    if (!hit) return false
    textureMoveRef.current = {
      pointerId: e.pointerId,
      startPoint: hit.point.clone(),
      originOffsetX: boardTexture.offsetX,
      originOffsetY: boardTexture.offsetY,
      deltaX: 0,
      deltaY: 0,
    }
    const controls = sceneRef.current?.userData.controls as OrbitControls | undefined
    if (controls) controls.enabled = false
    panelClickStartRef.current = null
    e.currentTarget.setPointerCapture(e.pointerId)
    setTextureDragging(true)
    setAssemblyMessage('正在板面上移动图片 · 松开后保存位置')
    e.preventDefault()
    return true
  }

  const moveTexture = (e: React.PointerEvent<HTMLDivElement>): boolean => {
    const moving = textureMoveRef.current
    if (!moving || moving.pointerId !== e.pointerId) return false
    const hit = texturePoint(e.clientX, e.clientY)
    if (!hit) return true
    moving.deltaX = hit.point.x - moving.startPoint.x
    moving.deltaY = hit.point.y - moving.startPoint.y
    updateTextureBoundsOverlay(sceneRef.current, {
      ...boardTexture,
      offsetX: moving.originOffsetX + moving.deltaX / hit.mapping.width * 100,
      offsetY: moving.originOffsetY + moving.deltaY / hit.mapping.height * 100,
    })
    e.preventDefault()
    return true
  }

  const finishTextureMove = (e: React.PointerEvent<HTMLDivElement>): boolean => {
    const moving = textureMoveRef.current
    if (!moving || moving.pointerId !== e.pointerId) return false
    textureMoveRef.current = null
    const mapping = sceneRef.current?.userData.textureMapping as { width: number; height: number } | undefined
    if (mapping) setBoardTexture({
      offsetX: Math.max(-100, Math.min(100, moving.originOffsetX + moving.deltaX / mapping.width * 100)),
      offsetY: Math.max(-100, Math.min(100, moving.originOffsetY + moving.deltaY / mapping.height * 100)),
    })
    const controls = sceneRef.current?.userData.controls as OrbitControls | undefined
    if (controls) controls.enabled = true
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    setTextureDragging(false)
    setAssemblyMessage('图片位置已更新 · 可继续拖动或用滚轮缩放')
    e.preventDefault()
    return true
  }

  const handleTextureWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const hit = texturePoint(e.clientX, e.clientY)
    if (!hit) return
    e.preventDefault()
    e.stopPropagation()
    const current = textureWheelScaleRef.current || boardTexture.scale
    const next = Math.max(20, Math.min(400, current * Math.exp(-e.deltaY * 0.0012)))
    textureWheelScaleRef.current = next
    updateTextureBoundsOverlay(sceneRef.current, { ...boardTexture, scale: next })
    if (textureWheelTimerRef.current !== null) window.clearTimeout(textureWheelTimerRef.current)
    textureWheelTimerRef.current = window.setTimeout(() => {
      // 保留当前临时纹理矩阵，直到 boardTexture 更新后的新纹理真正替换它。
      // 旧逻辑先把 repeat 重置为 1，再等待场景重建，会产生“缩小→弹回→再缩小”的闪跳。
      setBoardTexture({ scale: textureWheelScaleRef.current })
      textureWheelTimerRef.current = null
      setAssemblyMessage(`图片缩放 ${Math.round(textureWheelScaleRef.current)}%`)
    }, 150)
  }

  const handleAssemblyPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) {
      panelClickStartRef.current = null
      return
    }
    if (beginTextureMove(e)) return
    panelClickStartRef.current = { x: e.clientX, y: e.clientY, button: e.button }
    if (e.button !== 0) return
    const raycaster = rayAt(e.clientX, e.clientY)
    const scene = sceneRef.current
    if (!raycaster || !scene) return
    let partRoot: THREE.Object3D | null = null
    for (const hit of raycaster.intersectObjects(scene.children, true)) {
      const candidate = findPlacedPartAncestor(hit.object)
      if (candidate) {
        partRoot = candidate
        break
      }
      // 板先挡住了零件，说明零件位于当前观察面的另一侧，不应隔板抓取。
      if (!(hit.object as THREE.Sprite).isSprite && findNamedAncestor(hit.object, 'split-panel-')) break
    }
    const partId = partRoot?.userData.placedPartId as string | undefined
    const part = partId ? placedParts.find(item => item.id === partId) : undefined
    if (!partRoot || !part?.placement) {
      if (selectedPartIdRef.current) setUI({ selectedPartId: null })
      return
    }
    setUI({ selectedPartId: part.id })
    movingPartRef.current = {
      partId: part.id,
      original: structuredClone(part),
      object: partRoot,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      fit: null,
    }
    const controls = scene.userData.controls as OrbitControls | undefined
    if (controls) controls.enabled = false
    panelClickStartRef.current = null
    e.currentTarget.setPointerCapture(e.pointerId)
    e.preventDefault()
  }

  const handleAssemblyPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (moveTexture(e)) return
    const moving = movingPartRef.current
    if (!moving || moving.pointerId !== e.pointerId) return
    if (Math.hypot(e.clientX - moving.startX, e.clientY - moving.startY) > 3) moving.moved = true
    if (!moving.moved) return
    const def = partDefsRef.current.find(part => part.id === moving.original.defId)
    if (!def) return
    const side = moving.original.placement?.side ?? 'front'
    // 正在移动的模型不能遮挡自身的射线/平面交互。
    moving.object.visible = false
    const { fit, point } = resolveSplitFit(def, e.clientX, e.clientY, side, occupiedTargetIds(moving.partId))
    moving.object.visible = true
    moving.fit = fit
    const highlightGroup = sceneRef.current?.userData.snapHighlights as THREE.Group | undefined
    if (highlightGroup) {
      if (fit) renderSnapHighlights(highlightGroup, fit.targets, side, 0x62e6cf)
      else {
        const nearby = nearbyCompatibleTargets(def, point, side, occupiedTargetIds(moving.partId))
        if (nearby.length) renderSnapHighlights(highlightGroup, nearby, side, 0xffd166)
        else clearSnapHighlights(highlightGroup)
      }
    }
    if (point) {
      if (fit) applyAssemblyTransform(moving.object, fit.position, fit.rotationZ, side)
      else applyAssemblyTransform(moving.object, previewFreePosition(def, point, side), 0, side)
      const rect = containerRef.current?.getBoundingClientRect()
      if (rect) setDragPreview({
        x: e.clientX - rect.left + 12,
        y: e.clientY - rect.top + 12,
        valid: !!fit,
        text: fit ? `${fit.targets.length} 个锚点已匹配 · 松开移动` : '自由移动中 · 当前不能吸附',
      })
    }
    e.preventDefault()
  }

  const finishMovingPart = (e: React.PointerEvent<HTMLDivElement>): boolean => {
    const moving = movingPartRef.current
    if (!moving || moving.pointerId !== e.pointerId) return false
    movingPartRef.current = null
    const controls = sceneRef.current?.userData.controls as OrbitControls | undefined
    if (controls) controls.enabled = true
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    setDragPreview(null)
    const originalPlacement = moving.original.placement!
    if (!moving.moved) {
      applyAssemblyTransform(
        moving.object,
        originalPlacement.position,
        originalPlacement.rotationZ,
        originalPlacement.side ?? 'front',
      )
      setAssemblyMessage('已选中配件：可拖动重新吸附，按 Delete 删除。')
      setHighlightRevision(revision => revision + 1)
      return true
    }
    if (!moving.fit) {
      applyAssemblyTransform(
        moving.object,
        originalPlacement.position,
        originalPlacement.rotationZ,
        originalPlacement.side ?? 'front',
      )
      setAssemblyMessage('当前位置没有匹配的孔组，零件已返回原位置。')
      setHighlightRevision(revision => revision + 1)
      return true
    }
    const fit = moving.fit
    const after: PlacedPart = {
      ...moving.original,
      rotation: fit.rotationZ,
      placement: {
        ...originalPlacement,
        panelId: fit.targets[0]?.panelId,
        position: fit.position,
        rotationZ: fit.rotationZ,
        targetIds: fit.targets.map(target => target.id),
      },
    }
    execute(new MovePartCommand(moving.partId, after))
    openCoveredAssemblyTargets(fit.targets, openEdgeHole)
    setAssemblyMessage(`零件已移动并重新吸附 ${fit.targets.length} 个锚点。`)
    playHoleTapSound()
    return true
  }

  /** 3D 中按屏幕投影命中圆形敲落孔; 通孔没有可射线命中的表面, 因此不能只 raycast 网格。 */
  const handlePanelPointerUp = (e: React.PointerEvent) => {
    const start = panelClickStartRef.current
    panelClickStartRef.current = null
    if (!start || start.button !== 0 || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 5) return
    if (!splitResult || splitResult.panels.length === 0 || !containerRef.current) return
    const camera = sceneRef.current?.userData.camera as THREE.PerspectiveCamera | undefined
    if (!camera) return
    const rect = containerRef.current.getBoundingClientRect()
    let minX = Infinity, maxX = -Infinity, minY = Infinity
    for (const p of splitResult.panels) {
      minX = Math.min(minX, p.x)
      maxX = Math.max(maxX, p.x + p.w)
      minY = Math.min(minY, p.y)
    }
    const cx = (minX + maxX) / 2
    let best: {
      panelId: string; panelX: number; panelY: number; holeX: number; holeY: number; distance: number
    } | null = null
    for (const panel of splitResult.panels) {
      for (const hole of panel.edge_holes) {
        const onBoundary = Math.abs(hole.x - panel.x) < 0.5 || Math.abs(hole.x - (panel.x + panel.w)) < 0.5 ||
          Math.abs(hole.y - panel.y) < 0.5 || Math.abs(hole.y - (panel.y + panel.h)) < 0.5
        if (onBoundary) continue
        const projected = new THREE.Vector3(
          hole.x - cx,
          hole.y - minY,
          viewPresetRef.current === 'back' ? -0.5 : splitCfg.thickness + 0.5,
        ).project(camera)
        if (projected.z < -1 || projected.z > 1) continue
        const sx = rect.left + (projected.x + 1) * rect.width / 2
        const sy = rect.top + (1 - projected.y) * rect.height / 2
        const distance = Math.hypot(e.clientX - sx, e.clientY - sy)
        if (distance <= 12 && (!best || distance < best.distance)) {
          best = {
            panelId: panel.id, panelX: panel.x, panelY: panel.y,
            holeX: hole.x, holeY: hole.y, distance,
          }
        }
      }
    }
    if (best) {
      toggleEdgeHole(best.panelId, best.panelX, best.panelY, best.holeX, best.holeY)
      playHoleTapSound()
    }
  }

  const handleViewportPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (finishTextureMove(e)) return
    if (finishMovingPart(e)) {
      panelClickStartRef.current = null
      return
    }
    handlePanelPointerUp(e)
  }

  const selectViewPreset = (preset: ViewPreset) => {
    const scene = sceneRef.current
    const camera = scene?.userData.camera as THREE.PerspectiveCamera | undefined
    const controls = scene?.userData.controls as OrbitControls | undefined
    if (!scene || !camera || !controls) return
    if (preset !== 'free' && viewPresetRef.current === 'free') {
      freeViewRef.current = { position: camera.position.clone(), target: controls.target.clone() }
    }
    if (preset === 'free') {
      controls.enableRotate = true
      controls.enablePan = true
      controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE
      controls.mouseButtons.RIGHT = THREE.MOUSE.PAN
      controls.touches.ONE = THREE.TOUCH.ROTATE
      controls.touches.TWO = THREE.TOUCH.DOLLY_PAN
      const saved = freeViewRef.current
      if (saved) {
        camera.position.copy(saved.position)
        controls.target.copy(saved.target)
      }
    } else {
      const view = scene.userData.assemblyView as { centerY: number; size: number } | undefined
      const centerY = view?.centerY ?? controls.target.y
      const size = view?.size ?? 500
      const distance = Math.max(250, size / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.15)
      controls.enableRotate = false
      controls.enablePan = true
      // 固定视角下左键不再尝试“旋转一个被锁定的相机”，而是直接平移板面。
      controls.mouseButtons.LEFT = THREE.MOUSE.PAN
      controls.mouseButtons.RIGHT = THREE.MOUSE.PAN
      controls.touches.ONE = THREE.TOUCH.PAN
      controls.touches.TWO = THREE.TOUCH.DOLLY_PAN
      controls.target.set(0, centerY, splitCfg.thickness / 2)
      camera.up.set(0, 1, 0)
      camera.position.set(0, centerY, preset === 'front' ? distance : -distance)
      camera.lookAt(controls.target)
    }
    scene.traverse(object => {
      if ((object as THREE.Sprite).isSprite && object.name.startsWith('split-panel-')) {
        object.visible = preset !== 'back'
      }
    })
    controls.update()
    viewPresetRef.current = preset
    setViewPreset(preset)
    setAssemblyMessage(preset === 'front'
      ? '已锁定正面 · 当前用于安装配件。'
      : preset === 'back'
        ? '已锁定背面 · 当前用于安装固定件。'
        : '已恢复自由视角 · 可旋转检查整体装配。')
  }

  const selectedPart = selectedPartId ? placedParts.find(part => part.id === selectedPartId) : undefined
  const selectedPartDef = selectedPart && partDefsRef.current.find(def => def.id === selectedPart.defId)
  const deleteSelectedPart = () => {
    if (!selectedPartId) return
    execute(new RemovePartCommand(selectedPartId))
    setUI({ selectedPartId: null })
    setAssemblyMessage('已删除配件；可按 Ctrl+Z 撤销。')
  }

  const rotateSelectedPart = (degrees: number) => {
    if (!selectedPart?.placement || !selectedPartDef || !splitResult?.panels.length) return
    const mount = typeof selectedPartDef.mount === 'object' ? selectedPartDef.mount : null
    if (!mount?.anchors.length || mountNeedsCalibration(selectedPartDef)) {
      setAssemblyMessage('该配件尚未标定锚点，不能保持孔位约束旋转。')
      return
    }
    const side = selectedPart.placement.side ?? 'front'
    const targets = splitPanelTargets(splitResult.panels, splitCfg, side)
    const occupied = new Set(selectedPart.placement.targetIds)
    const pivot = targets.find(target => occupied.has(target.id))
    if (!pivot) {
      setAssemblyMessage('找不到当前吸附孔，请重新拖动配件完成吸附。')
      return
    }
    const desired = selectedPart.placement.rotationZ + THREE.MathUtils.degToRad(degrees)
    const fit = fitPartAnchors(anchorsForSide(mount.anchors, side), targets, pivot, 8, 4, desired, occupiedTargetIds(selectedPart.id), contactZForSide(mount.contactZ, side))
    const angleError = fit
      ? Math.abs(Math.atan2(Math.sin(fit.rotationZ - desired), Math.cos(fit.rotationZ - desired)))
      : Infinity
    if (!fit || angleError > THREE.MathUtils.degToRad(2)) {
      setAssemblyMessage('这个方向没有与锚点间距匹配的孔组，请尝试其他角度。')
      return
    }
    execute(new MovePartCommand(selectedPart.id, {
      ...selectedPart,
      rotation: fit.rotationZ,
      placement: {
        ...selectedPart.placement,
        panelId: fit.targets[0]?.panelId,
        position: fit.position,
        rotationZ: fit.rotationZ,
        targetIds: fit.targets.map(target => target.id),
      },
    }))
    // 旋转后可能落到尚未打孔的候选圆孔上: 同样自动打通。
    openCoveredAssemblyTargets(fit.targets, openEdgeHole)
    setHighlightRevision(revision => revision + 1)
    playHoleTapSound()
    const applied = THREE.MathUtils.radToDeg(fit.rotationZ)
    setAssemblyMessage(`已手动旋转到 ${Math.round(applied * 10) / 10}°，并重新校验 ${fit.targets.length} 个吸附孔。`)
  }

  return (
    <div
      ref={containerRef}
      className={`viewport3d${textureMappingMode ? ' texture-mapping-mode' : ''}${textureDragging ? ' is-moving-texture' : ''}`}
      style={{ width: '100%', height: '100%', position: 'relative' }}
      onPointerDownCapture={handleAssemblyPointerDown}
      onPointerMoveCapture={handleAssemblyPointerMove}
      onPointerUpCapture={handleViewportPointerUp}
      onWheelCapture={handleTextureWheel}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={e => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setDragPreview(null)
          if (dragModelRef.current) dragModelRef.current.visible = false
          const highlights = sceneRef.current?.userData.snapHighlights as THREE.Group | undefined
          if (highlights) clearSnapHighlights(highlights)
        }
      }}
      onDragEnter={e => {
        const data = e.dataTransfer.getData('application/snapboard-part')
        if (data) {
          try { dragDataRef.current = JSON.parse(data) } catch { /* ignore */ }
        }
      }}
    >
      <div className="view-preset-switch" aria-label="3D 视角锁定">
        <button className={viewPreset === 'front' ? 'on' : ''} onClick={() => selectViewPreset('front')}
          data-tip="安装配件" aria-label="正面视角：安装配件">正面</button>
        <button className={viewPreset === 'back' ? 'on' : ''} onClick={() => selectViewPreset('back')}
          data-tip="安装固定件" aria-label="背面视角：安装固定件">背面</button>
        <button className={viewPreset === 'free' ? 'on' : ''} onClick={() => selectViewPreset('free')}
          data-tip="旋转检查整体" aria-label="自由视角：旋转检查整体装配">自由</button>
      </div>
      {textureMappingMode && (
        <div className="texture-map-hud">
          <span><b>图片定位</b><small>虚线框=完整图片范围 · 板面拖动 · 滚轮缩放</small></span>
          <div>
            <button onClick={() => setBoardTexture({ scale: Math.max(20, boardTexture.scale - 10) })} title="缩小图片">−</button>
            <strong>{Math.round(boardTexture.scale)}%</strong>
            <button onClick={() => setBoardTexture({ scale: Math.min(400, boardTexture.scale + 10) })} title="放大图片">＋</button>
            <button onClick={() => setBoardTexture({ offsetX: 0, offsetY: 0, scale: 100, rotation: 0 })} title="图片居中并恢复 100%">居中</button>
            <button onClick={() => selectViewPreset('front')} title="切换到适合图片定位的正视图">正视</button>
          </div>
        </div>
      )}
      {selectedPart && (
        <div className="part-selection-toolbar">
          <span><b>{selectedPartDef?.name ?? '已选配件'}</b><small>拖动可重新吸附 · 手动旋转保持孔位约束</small></span>
          <div className="part-manual-rotate" aria-label="手动旋转配件">
            <button onClick={() => rotateSelectedPart(-90)} title="逆时针旋转 90°">−90°</button>
            <button onClick={() => rotateSelectedPart(-15)} title="逆时针微调 15°">−15°</button>
            <b>{selectedPart.placement ? `${Math.round(THREE.MathUtils.radToDeg(selectedPart.placement.rotationZ))}°` : '—'}</b>
            <button onClick={() => rotateSelectedPart(15)} title="顺时针微调 15°">+15°</button>
            <button onClick={() => rotateSelectedPart(90)} title="顺时针旋转 90°">+90°</button>
          </div>
          <button className="delete" onClick={deleteSelectedPart} title="删除配件（Delete / Backspace）">删除</button>
        </div>
      )}
      {dragPreview && (
        <div style={{
          position: 'absolute', left: dragPreview.x, top: dragPreview.y,
          background: dragPreview.valid ? 'rgba(62,198,176,.22)' : 'rgba(233,69,96,0.24)',
          border: `1px solid ${dragPreview.valid ? '#3ec6b0' : '#e94560'}`,
          borderRadius: 4, padding: '2px 8px', fontSize: 11, color: '#fff',
          pointerEvents: 'none',
        }}>
          {dragPreview.valid ? '✓' : '↔'} {dragPreview.text}
        </div>
      )}
      {splitResult && splitResult.panels.length > 0 && (
        <div style={{
          position: 'absolute', left: 12, bottom: 12, padding: '5px 9px',
          color: 'rgba(255,255,255,0.72)', background: 'rgba(20,22,36,0.72)',
          borderRadius: 4, fontSize: 11, pointerEvents: 'none',
        }}>
          单击虚线圆：切换为贯通孔 · 再次单击恢复完整板面 · 拖入配件：实时预览
        </div>
      )}
      {assemblyMessage && (
        <button
          className="assembly-toast"
          onClick={() => setAssemblyMessage(null)}
          title="点击关闭"
        >{assemblyMessage}</button>
      )}
    </div>
  )
}

interface TextureMappingBounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
  width: number
  height: number
}

function textureImageFrame(config: BoardTextureConfig, mapping: TextureMappingBounds) {
  const targetAspect = mapping.width / Math.max(1e-6, mapping.height)
  const sourceAspect = Math.max(0.05, config.imageAspect ?? targetAspect)
  let width = mapping.width
  let height = mapping.height
  if (config.fit !== 'stretch' && config.fit !== 'tile') {
    const useWidth = config.fit === 'cover' ? sourceAspect < targetAspect : sourceAspect > targetAspect
    if (useWidth) height = mapping.width / sourceAspect
    else width = mapping.height * sourceAspect
  }
  const scale = Math.max(0.1, config.scale / 100)
  return {
    width: width * scale,
    height: height * scale,
    x: (mapping.minX + mapping.maxX) / 2 + config.offsetX / 100 * mapping.width,
    y: (mapping.minY + mapping.maxY) / 2 + config.offsetY / 100 * mapping.height,
    rotation: THREE.MathUtils.degToRad(config.rotation),
  }
}

function createTextureBoundsOverlay(config: BoardTextureConfig, mapping: TextureMappingBounds, z: number): THREE.LineLoop {
  const geometry = new THREE.BufferGeometry()
  const material = new THREE.LineDashedMaterial({
    color: 0x8ff4e2,
    transparent: true,
    opacity: 0.9,
    depthTest: false,
    dashSize: 5,
    gapSize: 3,
  })
  const line = new THREE.LineLoop(geometry, material)
  line.name = 'texture-image-bounds'
  line.position.z = z
  line.renderOrder = 90
  line.userData.mapping = mapping
  updateTextureBoundsGeometry(line, config)
  return line
}

function updateTextureBoundsGeometry(line: THREE.LineLoop, config: BoardTextureConfig): void {
  const mapping = line.userData.mapping as TextureMappingBounds | undefined
  if (!mapping) return
  const frame = textureImageFrame(config, mapping)
  const hw = frame.width / 2
  const hh = frame.height / 2
  line.geometry.dispose()
  line.geometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-hw, -hh, 0),
    new THREE.Vector3(hw, -hh, 0),
    new THREE.Vector3(hw, hh, 0),
    new THREE.Vector3(-hw, hh, 0),
  ])
  line.position.x = frame.x
  line.position.y = frame.y
  line.rotation.z = frame.rotation
  line.computeLineDistances()
}

function updateTextureBoundsOverlay(scene: THREE.Scene | null, config: BoardTextureConfig): void {
  const line = scene?.userData.textureBoundsOverlay as THREE.LineLoop | undefined
  if (line) updateTextureBoundsGeometry(line, config)
}

/** 从场景中找到相机 (存储在 userData) */
function findCamera(scene: THREE.Scene): THREE.Camera | null {
  // 场景初始化时相机未存储, 这里从 renderer 获取 — 简化: 用场景默认
  return scene.userData.camera ?? null
}

function findNamedAncestor(object: THREE.Object3D, prefix: string): THREE.Object3D | null {
  let current: THREE.Object3D | null = object
  while (current) {
    if (current.name.startsWith(prefix)) return current
    current = current.parent
  }
  return null
}

function findPlacedPartAncestor(object: THREE.Object3D): THREE.Object3D | null {
  let current: THREE.Object3D | null = object
  while (current) {
    if (typeof current.userData.placedPartId === 'string') return current
    current = current.parent
  }
  return null
}

function applyAssemblyTransform(
  object: THREE.Object3D,
  position: [number, number, number],
  rotationZ: number,
  side: AssemblySide,
): void {
  const aroundZ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), rotationZ)
  const sideFlip = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    side === 'back' ? Math.PI : 0,
  )
  // 先翻到板背面，再在板面内旋转，与 anchorsForSide 的配准顺序一致。
  object.quaternion.copy(aroundZ).multiply(sideFlip)
  object.position.set(...position)
}

function stylePartPreview(object: THREE.Object3D, valid: boolean): void {
  const tint = new THREE.Color(valid ? 0x3ec6b0 : 0xe94560)
  const carbon = new THREE.Color(0x252c35)
  object.traverse(node => {
    if (node.name.startsWith('drag-anchor-')) return
    const mesh = node as THREE.Mesh
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []
    for (const material of materials) {
      material.transparent = true
      material.opacity = 0.42
      material.depthWrite = false
      const standard = material as THREE.MeshStandardMaterial
      if (standard.color) {
        const saved = material.userData.previewBaseColor as number | undefined
        if (saved === undefined) material.userData.previewBaseColor = standard.color.getHex()
        standard.color.copy(carbon).lerp(tint, valid ? 0.25 : 0.12)
      }
      if (standard.emissive) standard.emissive.copy(tint).multiplyScalar(0.18)
      material.needsUpdate = true
    }
  })
}

function previewCapsuleGeometry(): THREE.ShapeGeometry {
  const radius = 2.7
  const straight = 5
  const shape = new THREE.Shape()
  shape.moveTo(-radius, -straight)
  shape.lineTo(-radius, straight)
  shape.absarc(0, straight, radius, Math.PI, 0, true)
  shape.lineTo(radius, -straight)
  shape.absarc(0, -straight, radius, 0, Math.PI, true)
  shape.closePath()
  return new THREE.ShapeGeometry(shape, 28)
}

function makePreviewAnchorMarker(anchor: PartMountAnchor): THREE.Mesh {
  const isRound = anchor.accepts.includes('round')
  const marker = new THREE.Mesh(
    isRound ? new THREE.CircleGeometry(3.2, 32) : previewCapsuleGeometry(),
    new THREE.MeshBasicMaterial({
      color: isRound ? 0xffd166 : 0x62e6cf,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    }),
  )
  marker.name = `drag-anchor-${anchor.id}`
  marker.position.set(...anchor.position)
  const normal = new THREE.Vector3(...(anchor.normal ?? [0, 0, 1])).normalize()
  if (isRound) {
    marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal)
  } else {
    const stableAxis = stabilizeSlotAxis(anchor.axis ?? [0, 1])
    const longAxis = new THREE.Vector3(stableAxis[0], stableAxis[1], 0).normalize()
    const shortAxis = longAxis.clone().cross(normal).normalize()
    marker.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(shortAxis, longAxis, normal))
  }
  marker.position.addScaledVector(normal, 0.35)
  marker.renderOrder = 80
  return marker
}

/** 半透明模型上独立显示已标定锚点；长圆孔始终以胶囊形显示，不再退化成点/直线。 */
function attachPreviewAnchorMarkers(object: THREE.Object3D, def: PartDefinition): void {
  const mount = typeof def.mount === 'object' ? def.mount : null
  if (!mount?.anchors.length) return
  const group = new THREE.Group()
  group.name = 'drag-anchor-markers'
  for (const anchor of mount.anchors) group.add(makePreviewAnchorMarker(anchor))
  object.add(group)
}

function clearSnapHighlights(group: THREE.Group): void {
  for (const child of [...group.children]) {
    group.remove(child)
    const mesh = child as THREE.Mesh
    mesh.geometry?.dispose()
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined
    if (Array.isArray(material)) material.forEach(item => item.dispose())
    else material?.dispose()
  }
}

function renderSnapHighlights(
  group: THREE.Group,
  targets: AssemblyTarget[],
  side: AssemblySide,
  color: number,
): void {
  clearSnapHighlights(group)
  for (const target of targets) {
    let geometry: THREE.BufferGeometry
    if (target.kind === 'slot') {
      const shape = new THREE.Shape()
      const radius = 4.5
      const straight = 9.5 - radius
      shape.moveTo(-radius, -straight)
      shape.lineTo(-radius, straight)
      shape.absarc(0, straight, radius, Math.PI, 0, true)
      shape.lineTo(radius, -straight)
      shape.absarc(0, -straight, radius, 0, Math.PI, true)
      shape.closePath()
      geometry = new THREE.ShapeGeometry(shape, 20)
    } else {
      geometry = new THREE.CircleGeometry(5.2, 32)
    }
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.65,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    })
    material.userData.snapHighlight = true
    const marker = new THREE.Mesh(geometry, material)
    marker.name = `snap-highlight-${target.id}`
    marker.position.set(target.x, target.y, target.z + (side === 'front' ? 0.75 : -0.75))
    if (target.kind === 'slot' && target.axis) {
      marker.rotation.z = Math.atan2(target.axis[1], target.axis[0]) - Math.PI / 2
    }
    marker.renderOrder = 50
    group.add(marker)
  }
}
