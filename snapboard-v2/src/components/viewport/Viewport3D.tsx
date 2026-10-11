// ============ 3D 视口 — 板子 + 配件 + 拖放吸附 ============
import { useEffect, useMemo, useRef, useState } from 'react'
import {createPortal} from 'react-dom'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { OutlinePass } from 'three/examples/jsm/postprocessing/OutlinePass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { useAppStore } from '../../store/useAppStore'
import { generateBoardMesh, generateSplitPanelMesh, makeBackEngravingPreview, makeBackSeamGuide, makeClosedHoleGuide, makePanelLabel } from '../../utils/boardMesh'
import { isPlainRetainedFront } from '../../utils/latticeFaceMesh'
import {createLatticeFacePreview as createLatticeFaceMeshes} from '../../utils/latticeFacePreview'
import { createLatticeReveal } from '../../utils/latticeReveal'
import { findNearestHole, boardHoles, type BoardGeometry } from '../../utils/snapToHole'
import { loadPartModel } from '../../utils/glbLoader'
import { appendPreviewResource, capturePreviewReplay, claimPreviewBuildState, disposePreviewResources, invalidatePreviewReplay } from '../../utils/previewResources'
import { MovePartCommand, PlacePartCommand, RemovePartCommand } from '../../commands/BoardCommands'
import { usePartLibrary } from '../../hooks/usePartLibrary'
import { playHoleTapSound } from '../../utils/interactionSound'
import { mountNeedsCalibration, partPreviewPath, type PartDefinition, type PartMountAnchor, type PlacedPart } from '../../partLibrary/types'
import { anchorsForSide, contactZForSide, fitPartAnchors, openCoveredAssemblyTargets, splitPanelTargets, type AssemblyFit, type AssemblyTarget } from '../../utils/assemblySnap'
import { subscribePartDrag, type PartDragPayload } from '../../utils/partDragSession'
import { applyBoardTexture, backTextureForRendering, boardTextureForSide, createLayoutTextureCanvas, getSplitPanelTextureBounds, texturePanelsForSide, editableTextureComposition, textureCanvasKey } from '../../utils/boardTexture'
import { stabilizeSlotAxis } from '../../utils/mountAxis.js'
import { assemblySideForView, type AssemblySide } from '../../utils/assemblySide.js'
import type { BoardTextureConfig, SplitPanel } from '../../types/geometry'
import { normalizeTextureComposition, type TextureCompositionPlacedLayer, type TextureCompositionTransform, type TextureFreePlacement, type TextureRepeatPlacement } from '../../utils/textureComposition'
import { getAssemblyHostPreset } from '../../assembly/hostCatalog'
import { createAssemblyHostPreview } from '../../utils/assemblyHostPreview'
import { useAssemblyLibrary } from '../../hooks/useAssemblyLibrary'
import { computeOcclusionReport } from '../../utils/occlusionModel'
import { createOcclusionOverlay, disposeOcclusionOverlay } from '../../utils/occlusionOverlay'
import { adviseLayoutTargets } from '../../utils/layoutAdvisor'
import { createLayoutSuggestionOverlay, disposeLayoutSuggestionOverlay } from '../../utils/layoutSuggestionOverlay'
import { buildSurfaceMarkingPlan, detectAssemblySeams } from '../../utils/assemblyMarking'
import { sideOrderNumberEngravings } from '../../utils/orderEngraving'
import { SIDE_PREVIEW_REQUEST_EVENT, publishManufacturingFeedback, type OrderExportRequest } from '../../utils/manufacturingFeedback'
import { resolveSpatialManufacturing } from '../../utils/spatialManufacturingPlan'
import { engraveSideLogoPreview, engraveBackMarkPreview, applyPanelNumberPreview, engraveSideOrderNumberPreview } from '../../utils/sideLogo'
import { createSpatialPanels, spatialConnectorMountsOpen, spatialHoleKey, splitSpatialHeight } from '../../utils/spatialPanels'
import { createSpatialLayout, faceAxes, faceToWorld, type SpatialFace, type SpatialLayout } from '../../utils/spatialLayout'
import { panelHoleEntries, type HoleGroup } from '../../utils/holeEditing'

const SPLIT_PANEL_COLORS = [0x3ec6b0, 0xffd166, 0xb39ddb, 0x5ea4ff]
const SPLIT_PANEL_HEX = ['#3ec6b0', '#ffd166', '#b39ddb', '#5ea4ff']
type ViewPreset = 'free' | 'front' | 'back'
type SpatialHoleTarget = { face: SpatialFace; panel: SplitPanel; x: number; y: number; localY: number; offsetY: number; knocked: boolean; group: HoleGroup }

function projectedHoleHit(e: { clientX: number; clientY: number }, camera: THREE.Camera, rect: DOMRect,
  center: THREE.Vector3, start: THREE.Vector3, end: THREE.Vector3, rim: THREE.Vector3) {
  const project = (point: THREE.Vector3) => { const p = point.clone().project(camera)
    return { x: rect.left + (p.x + 1) * rect.width / 2, y: rect.top + (1 - p.y) * rect.height / 2 } }
  const a = project(start), b = project(end), c = project(center), r = project(rim)
  const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy
  const t = length ? Math.max(0, Math.min(1, ((e.clientX - a.x) * dx + (e.clientY - a.y) * dy) / length)) : 0
  return { distance: Math.hypot(e.clientX - a.x - t * dx, e.clientY - a.y - t * dy),
    limit: Math.max(8, Math.hypot(r.x - c.x, r.y - c.y) + 5) }
}

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

type SpatialDimension = 'width' | 'depth'
type DimensionAxis = { dx: number; dy: number; pxPerMm: number }

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
  controlsWasEnabled: boolean
  layerId?: string
  originXmm?: number
  originYmm?: number
}

/**
 * 纹理工作室只临时借用相机。保存完整控制状态，关闭后恢复进入工作室前的
 * 自由/正面/背面视角，避免把编辑用正视图误当成用户的新装配视角。
 */
interface TextureViewSessionSnapshot {
  scene: THREE.Scene
  preset: ViewPreset
  position: THREE.Vector3
  quaternion: THREE.Quaternion
  up: THREE.Vector3
  zoom: number
  target: THREE.Vector3
  controlsEnabled: boolean
  enableRotate: boolean
  enablePan: boolean
  enableZoom: boolean
  mouseButtons: OrbitControls['mouseButtons']
  touches: OrbitControls['touches']
}

type EditableTextureImageLayer = TextureCompositionPlacedLayer & {
  placement: TextureFreePlacement | TextureRepeatPlacement
}

const isEditableTextureImageLayer = (layer: ReturnType<typeof normalizeTextureComposition>['layers'][number] | undefined): layer is EditableTextureImageLayer =>
  layer !== undefined && layer.kind !== 'panel-sequence' && (layer.placement.mode === 'free' || layer.placement.mode === 'repeat')

export function Viewport3D({ active = true, onReady, onFrame }: { active?: boolean; onReady?: () => void; onFrame?: () => void }) {
  const activeRef = useRef(active)
  const onReadyRef = useRef(onReady)
  const onFrameRef = useRef(onFrame)
  const readyReportedRef = useRef(false)
  const frameReportedRef = useRef(false)
  const lastPanelInputsRef = useRef<unknown[] | null>(null)
  activeRef.current = active
  onReadyRef.current = onReady
  onFrameRef.current = onFrame
  useEffect(() => { if (active) frameReportedRef.current = false }, [active])
  const containerRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const boards = useAppStore(s => s.boards)
  const placedParts = useAppStore(s => s.placedParts)
  const appliedSplitResult = useAppStore(s => s.splitResult)
  const structurePreview = useAppStore(s => s.ui.structureOpen ? s.ui.structurePreviewPanels : null)
  const splitResult = useMemo(() => appliedSplitResult && structurePreview
    ? { ...appliedSplitResult, panels: structurePreview } : appliedSplitResult, [appliedSplitResult, structurePreview])
  const splitCfg = useAppStore(s => s.splitConfig)
  const spatialLayout = useAppStore(s => s.spatialLayout)
  const boardTexture = useAppStore(s => s.boardTexture)
  const textureSolve = useAppStore(s => s.textureSolve)
  const assemblyMarking = useAppStore(s => s.assemblyMarking)
  const orderLink = useAppStore(s=>s.orderLink)
  const sideOrderNumber = assemblyMarking.orderSideNumber ?? orderLink?.number
  const pendingSidePreview = useRef<OrderExportRequest|null>(null)
  const [sidePreviewTick,setSidePreviewTick]=useState(0)
  useEffect(()=>{
    const listener=(event:Event)=>{
      const request=(event as CustomEvent<OrderExportRequest>).detail
      if(!sceneRef.current || !request?.requestId)return
      request.accepted=true;pendingSidePreview.current=request;setSidePreviewTick(value=>value+1)
      publishManufacturingFeedback({requestId:request.requestId,orderId:request.orderId,orderNumber:request.orderNumber,
        phase:'running',message:'正在将完整订单号应用到板件侧面…',progress:0})
    }
    window.addEventListener(SIDE_PREVIEW_REQUEST_EVENT,listener)
    return()=>window.removeEventListener(SIDE_PREVIEW_REQUEST_EVENT,listener)
  },[])
  const finishSidePreview=(count:number,error?:string)=>{
    const request=pendingSidePreview.current
    if(!request || request.orderNumber!==sideOrderNumber)return
    publishManufacturingFeedback({requestId:request.requestId,orderId:request.orderId,orderNumber:request.orderNumber,
      phase:error?'error':'success',message:error?`侧刻预览失败：${error}`:'已应用订单号，未导出。',panelCount:count,progress:1})
    pendingSidePreview.current=null
  }

  const projectName = useAppStore(s => s.project.metadata.name)
  const assemblyHostPresetId = useAppStore(s => s.assemblyScene.hostPresetId ?? 'snapboard-pegboard-v1')
  const textureStudioOpen = useAppStore(s => s.ui.textureStudioOpen)
  const structureOpen = useAppStore(s => s.ui.structureOpen)
  const editSide = useAppStore(s => s.boardTexture.backEnabled ? s.ui.textureEditSide : 'front')
  const selectedTextureLayerId = useAppStore(s => editSide === 'back' ? s.ui.selectedBackTextureLayerId : s.ui.selectedTextureLayerId)
  const editingTexture = useMemo(() => boardTextureForSide(boardTexture, editSide), [boardTexture, editSide])
  const occlusionOverlayEnabled = useAppStore(s => s.occlusionOverlayEnabled)
  const occlusionAnalysisOpen = useAppStore(s => s.ui.occlusionAnalysisOpen)
  const occlusionMode = useAppStore(s => s.occlusionMode)
  const setBoardTextureSide = useAppStore(s => s.setBoardTextureSide)
  const setEditingTexture = (partial: Partial<BoardTextureConfig>) => setBoardTextureSide(editSide, partial.composition ? { ...partial, source: 'composition', opacity: 1 } : partial)
  const toggleEdgeHole = useAppStore(s => s.toggleEdgeHole)
  const holeEditMode = useAppStore(s => s.holeEditMode)
  const selectedHole = useAppStore(s => s.selectedHole)
  const openEdgeHole = useAppStore(s => s.openEdgeHole)
  const execute = useAppStore(s => s.execute)
  const selectedPartId = useAppStore(s => s.ui.selectedPartId)
  const setUI = useAppStore(s => s.setUI)
  const selectedPartIdRef = useRef<string | null>(null)
  // 打孔开关只改一块板的 knocked 标志, 却会生成新的 splitResult 引用。
  // 按板签名缓存网格/标签, 布局与孔位没变的板直接复用, 避免每次开关全板重建。
  const panelMeshCacheRef = useRef(new Map<string, THREE.Object3D>())
  const panelLabelCacheRef = useRef(new Map<string, THREE.Object3D>())
  const panelCutoutKeyRef = useRef<string | null>(null)
  const displayedTrialRef = useRef<SplitPanel[] | null | undefined>(null)
  // 纹理画布只取决于板件布局与纹理外观; knocked 变化后复用同一画布, 不再整体重算。
  const texturePreviewCacheRef = useRef<{ key: string; canvas: HTMLCanvasElement } | null>(null)
  const backTexturePreviewCacheRef = useRef<{ key: string; canvas: HTMLCanvasElement } | null>(null)
  const { index: libIndex } = usePartLibrary()
  const assemblyLibrary = useAssemblyLibrary()
  const partDefsRef = useRef<PartDefinition[]>([])
  partDefsRef.current = libIndex?.parts ?? []
  const occlusionReport = useMemo(() => {
    const panels = splitResult?.panels ?? []
    if (!panels.length) return null
    return computeOcclusionReport(panels, placedParts, libIndex?.parts ?? [], {
      textureAvoidZones: boardTexture.enabled ? boardTexture.avoidZones : [],
    })
  }, [splitResult, placedParts, libIndex, boardTexture.enabled, boardTexture.avoidZones])
  const layoutSuggestions = useMemo(() => {
    const panels = splitResult?.panels ?? []
    if (!panels.length) return []
    const occupiedTargetIds = new Set(placedParts.flatMap(part => part.placement?.targetIds ?? []))
    return adviseLayoutTargets(panels, splitCfg, { occupiedTargetIds, mode: occlusionMode, limit: 6 })
  }, [splitResult, splitCfg, placedParts, occlusionMode])
  const [dragPreview, setDragPreview] = useState<DragPreviewState | null>(null)
  const [assemblyMessage, setAssemblyMessage] = useState<string | null>(null)
  const [lattice3DStatus, setLattice3DStatus] = useState<string | null>(null)
  const [meshReadyRevision, setMeshReadyRevision] = useState(0)
  const [snapFeedback, setSnapFeedback] = useState(false)
  const [highlightRevision, setHighlightRevision] = useState(0)
  const [viewPreset, setViewPreset] = useState<ViewPreset>('free')
  const viewPresetRef = useRef<ViewPreset>('free')
  const dragDataRef = useRef<PartDragPayload | null>(null)
  const dragModelRef = useRef<THREE.Object3D | null>(null)
  const dragLoadTokenRef = useRef(0)
  const movingPartRef = useRef<MovingPartState | null>(null)
  const textureMoveRef = useRef<TextureMoveState | null>(null)
  const textureWheelScaleRef = useRef(boardTexture.scale)
  const textureWheelTransformRef = useRef<TextureCompositionTransform | null>(null)
  const textureWheelTimerRef = useRef<number | null>(null)
  const textureWheelCommitRef = useRef<(() => void) | null>(null)
  const [textureDragging, setTextureDragging] = useState(false)
  const freeViewRef = useRef<{ position: THREE.Vector3; target: THREE.Vector3 } | null>(null)
  const textureStudioWasOpenRef = useRef(false)
  const textureViewSessionRef = useRef<TextureViewSessionSnapshot | null>(null)
  const panelClickStartRef = useRef<{ x: number; y: number; button: number } | null>(null)
  const spatialDimensionRefs = useRef<Record<SpatialDimension, HTMLButtonElement | null>>({ width: null, depth: null })
  const spatialDimensionAxisRef = useRef<Partial<Record<SpatialDimension, DimensionAxis>>>({})
  const dimensionDragRef = useRef<{
    kind: SpatialDimension; pointerId: number; startX: number; startY: number;
    startValue: number; axis: DimensionAxis; current: number; controlsWasEnabled: boolean
  } | null>(null)
  const [dimensionDraft, setDimensionDraft] = useState<{ kind: SpatialDimension; value: number } | null>(null)
  const snapFeedbackTimerRef = useRef<number | null>(null)
  // 不包含 knocked/manual 等交互状态；仅板件几何布局改变时才允许自动取景。
  const splitLayoutKeyRef = useRef<string | null>(null)
  const spatialFrameKeyRef = useRef<string | null>(null)
  const texturePreviewTokenRef = useRef(0)
  const backPreviewTokenRef = useRef(0)
  const pendingSpatialFaceRef = useRef<string | null>(null)
  const textureDraftFrameRef = useRef<number | null>(null)
  const textureDraftRef = useRef<BoardTextureConfig | null>(null)
  const textureDraftRenderingRef = useRef(false)
  viewPresetRef.current = viewPreset
  selectedPartIdRef.current = selectedPartId
  const textureComposition = useMemo(() => editableTextureComposition(editingTexture, texturePanelsForSide(splitResult?.panels ?? [], editSide)), [editingTexture, splitResult, editSide])
  const selectedTextureLayer = textureComposition.layers.find(layer => layer.id === selectedTextureLayerId) ?? textureComposition.layers.at(-1)
  const selectedEditableTextureLayer = isEditableTextureImageLayer(selectedTextureLayer) ? selectedTextureLayer : null
  const assemblyMarkPlan = useMemo(() => buildSurfaceMarkingPlan(splitResult?.panels ?? [], splitCfg, assemblyMarking, boardTexture, projectName),
    [splitResult, splitCfg, assemblyMarking, boardTexture.backEnabled, boardTexture.enabled, projectName])
  const backTexture = useMemo(() => backTextureForRendering(boardTexture, splitResult?.panels ?? [], splitCfg, assemblyMarking, projectName),
    [boardTexture, splitResult, splitCfg, assemblyMarking, projectName])
  const colorKeys = useMemo(() => {
    const panels = splitResult?.panels ?? [], bounds = getSplitPanelTextureBounds(panels)
    return { front: textureCanvasKey(boardTexture, bounds.width / bounds.height, panels),
      back: backTexture ? textureCanvasKey(backTexture, bounds.width / bounds.height, texturePanelsForSide(panels, 'back')) : null }
  }, [boardTexture, backTexture, splitResult])
  const backAssemblySeams = useMemo(
    () => detectAssemblySeams(splitResult?.panels ?? []),
    [splitResult],
  )
  const textureMappingMode = textureStudioOpen && boardTexture.enabled && (
    Boolean(selectedEditableTextureLayer)
  )
  const usesPegboardHost = assemblyHostPresetId === 'snapboard-pegboard-v1'
  const textureEnabled = boardTexture.enabled
  const textureThickness = boardTexture.textureThickness
  const assemblyHostPreset = assemblyLibrary.hosts.find(item => item.id === assemblyHostPresetId)
    ?? getAssemblyHostPreset(assemblyHostPresetId)

  useEffect(() => {
    if (textureWheelTimerRef.current === null) textureWheelScaleRef.current = editingTexture.scale
  }, [editingTexture.scale, editSide])

  useEffect(() => () => {
    if (textureWheelTimerRef.current !== null) window.clearTimeout(textureWheelTimerRef.current)
    if (snapFeedbackTimerRef.current !== null) window.clearTimeout(snapFeedbackTimerRef.current)
    if (textureDraftFrameRef.current !== null) window.cancelAnimationFrame(textureDraftFrameRef.current)
    texturePreviewTokenRef.current++
    backPreviewTokenRef.current++
  }, [])

  const triggerSnapFeedback = () => {
    setSnapFeedback(true)
    if (snapFeedbackTimerRef.current !== null) window.clearTimeout(snapFeedbackTimerRef.current)
    snapFeedbackTimerRef.current = window.setTimeout(() => {
      snapFeedbackTimerRef.current = null
      setSnapFeedback(false)
    }, 280)
  }

  useEffect(() => {
    const overlay = sceneRef.current?.userData.textureBoundsOverlay as THREE.LineLoop | undefined
    if (overlay) overlay.visible = textureMappingMode
  }, [textureMappingMode])

  // 场景初始化 (一次性)
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x151922)
    sceneRef.current = scene
    // Mesh/material caches belong to this renderer, including hot reloads.
    panelMeshCacheRef.current.clear()
    panelLabelCacheRef.current.clear()
    panelCutoutKeyRef.current = null
    displayedTrialRef.current = null
    lastPanelInputsRef.current = null
    splitLayoutKeyRef.current = null // 新建场景/相机后允许首次自动取景

    const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 5000)
    camera.position.set(300, 250, 300)
    camera.lookAt(0, 100, 0)
    scene.userData.camera = camera  // 供 drop 时 raycast 使用

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setSize(container.clientWidth, container.clientHeight)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.localClippingEnabled = true
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.05
    container.appendChild(renderer.domElement)

    const composer = new EffectComposer(renderer)
    // 后处理从离屏目标读取画面；默认帧缓冲的 antialias 不会覆盖这一步。
    const samples = Math.min(2, renderer.capabilities.maxSamples)
    composer.renderTarget1.samples = samples
    composer.renderTarget2.samples = samples
    composer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
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
    scene.userData.renderer = renderer
    scene.userData.outlinePass = outlinePass
    // Use the same output conversion and MSAA for idle, preparation and reveal.
    // Switching to direct renderer.render makes the background/grid jump in color.
    const renderFrame = () => {
      outlinePass.enabled = outlinePass.selectedObjects.length > 0
      composer.render()
    }
    scene.userData.renderFrame = renderFrame

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

    const grid = new THREE.GridHelper(2000, 50, 0x354052, 0x222b38)
    scene.add(grid)

    let raf = 0
    const animate = () => {
      if (!activeRef.current) { raf = 0; return }
      controls.update()
      const spatialModel = scene.userData.spatialDisplayedLayout as SpatialLayout | undefined
      for (const kind of ['width', 'depth'] as const) {
        const handle = spatialDimensionRefs.current[kind]
        if (!handle) continue
        if (spatialModel?.template !== 'L') { handle.style.display = 'none'; continue }
        const face = spatialModel.faces[kind === 'width' ? 0 : 1]
        const from = new THREE.Vector3(...faceToWorld(face, 0, face.height + 8)).project(camera)
        const to = new THREE.Vector3(...faceToWorld(face, face.width, face.height + 8)).project(camera)
        const dx = (to.x - from.x) * container.clientWidth / 2
        const dy = -(to.y - from.y) * container.clientHeight / 2
        const length = Math.hypot(dx, dy)
        if (length < 8 || from.z > 1 || to.z > 1) { handle.style.display = 'none'; continue }
        const x = (from.x + to.x + 2) * container.clientWidth / 4
        const compact = spatialModel.faces[0].width < 60 && spatialModel.faces[1].width < 60
        const y = (2 - from.y - to.y) * container.clientHeight / 4 +
          (compact ? kind === 'width' ? -42 : 12 : -22)
        handle.style.left = `${Math.max(55, Math.min(container.clientWidth - 55, x))}px`
        handle.style.top = `${Math.max(compact && kind === 'depth' ? 110 : 70,
          Math.min(container.clientHeight - 20, y))}px`
        handle.style.setProperty('--edge-angle', `${Math.atan2(dy, dx)}rad`)
        handle.style.display = 'flex'
        spatialDimensionAxisRef.current[kind] = { dx: dx / length, dy: dy / length, pxPerMm: length / face.width }
      }
      const pulse = 0.48 + Math.sin(performance.now() * 0.008) * 0.22
      snapHighlights.traverse(object => {
        const material = (object as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined
        if (material?.userData.snapHighlight) material.opacity = pulse
      })
      const wipe = scene.userData.latticeWipe as { step: (now: number) => void } | undefined
      wipe?.step(performance.now())
      renderFrame()
      if (readyReportedRef.current && !frameReportedRef.current) {
        frameReportedRef.current = true
        onFrameRef.current?.()
      }
      raf = requestAnimationFrame(animate)
    }
    const startLoop = () => { if (!raf) raf = requestAnimationFrame(animate) }
    const stopLoop = () => { if (raf) cancelAnimationFrame(raf); raf = 0 }
    scene.userData.startLoop = startLoop
    scene.userData.stopLoop = stopLoop
    if (activeRef.current) startLoop()

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
      scene.userData.latticeWipe?.finish?.()
      scene.userData.disposeLatticeReplay?.()
      stopLoop()
      resizeObserver.disconnect()
      window.removeEventListener('resize', onResize)
      controls.dispose()
      for(const pass of composer.passes)pass.dispose()
      disposePreviewResources(scene)
      scene.clear()
      panelMeshCacheRef.current.clear()
      panelLabelCacheRef.current.clear()
      texturePreviewCacheRef.current=null
      backTexturePreviewCacheRef.current=null
      dragModelRef.current=null
      dragLoadTokenRef.current++
      composer.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      container.removeChild(renderer.domElement)
      if (sceneRef.current === scene) sceneRef.current = null
    }
  }, [])

  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    if (active) scene.userData.startLoop?.()
    else scene.userData.stopLoop?.()
  }, [active])

  // Keep the WebGL loop in step with store transitions even when React batches a
  // quick 3D -> 2D -> 3D sequence into one render (no active-prop effect fires).
  useEffect(() => useAppStore.subscribe((state, previous) => {
    if (previous.ui.viewMode === '3d' && state.ui.viewMode === '2d') {
      activeRef.current = false
      sceneRef.current?.userData.stopLoop?.()
    } else if (previous.ui.viewMode === '2d' && state.ui.viewMode === '3d') {
      activeRef.current = true
      sceneRef.current?.userData.startLoop?.()
    }
  }), [])

  // 遮挡分析叠加层使用度量报告，关闭或更新时释放 GPU 资源。
  useEffect(() => {
    const scene = sceneRef.current
    const panels = splitResult?.panels ?? []
    if (!scene || spatialLayout.enabled || !occlusionOverlayEnabled || !occlusionReport || !panels.length || !usesPegboardHost) return
    const overlay = createOcclusionOverlay({
      report: occlusionReport,
      panels,
      surfaceZ: splitCfg.thickness,
    })
    overlay.visible = viewPreset !== 'back'
    scene.userData.occlusionOverlay = overlay
    scene.add(overlay)
    return () => {
      if (scene.userData.occlusionOverlay === overlay) scene.userData.occlusionOverlay = null
      disposeOcclusionOverlay(overlay)
    }
  }, [occlusionOverlayEnabled, occlusionReport, splitResult, splitCfg.thickness, usesPegboardHost, viewPreset, spatialLayout.enabled])

  // 分析工作区打开时显示边缘优先候选；这些标记不参与射线装配与制造输出。
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene || spatialLayout.enabled || !occlusionAnalysisOpen || !layoutSuggestions.length || !usesPegboardHost) return
    const overlay = createLayoutSuggestionOverlay({
      suggestions: layoutSuggestions,
      surfaceZ: splitCfg.thickness,
      options: { maxMarkers: 5 },
    })
    overlay.visible = viewPreset !== 'back'
    scene.userData.layoutSuggestionOverlay = overlay
    scene.add(overlay)
    return () => {
      if (scene.userData.layoutSuggestionOverlay === overlay) scene.userData.layoutSuggestionOverlay = null
      disposeLayoutSuggestionOverlay(overlay)
    }
  }, [occlusionAnalysisOpen, layoutSuggestions, splitCfg.thickness, usesPegboardHost, viewPreset, spatialLayout.enabled])

  // 建议列表点击后只移动相机观察目标，不移动配件、不修改孔位。
  useEffect(() => {
    const focusSuggestion = (event: Event) => {
      const detail = (event as CustomEvent<{ x?: number; y?: number }>).detail
      if (!Number.isFinite(detail?.x) || !Number.isFinite(detail?.y)) return
      const scene = sceneRef.current
      const camera = scene?.userData.camera as THREE.PerspectiveCamera | undefined
      const controls = scene?.userData.controls as OrbitControls | undefined
      if (!camera || !controls) return
      const target = new THREE.Vector3(detail.x!, detail.y!, splitCfg.thickness + 2)
      const direction = camera.position.clone().sub(controls.target)
      const distance = Math.max(180, Math.min(650, direction.length() || 320))
      if (direction.lengthSq() < 1e-6) direction.set(0.7, 0.45, 1)
      controls.target.copy(target)
      camera.position.copy(target).add(direction.normalize().multiplyScalar(distance))
      camera.lookAt(target)
      controls.update()
      setViewPreset('free')
    }
    window.addEventListener('snapboard:focus-layout-suggestion', focusSuggestion)
    return () => window.removeEventListener('snapboard:focus-layout-suggestion', focusSuggestion)
  }, [splitCfg.thickness])

  useEffect(() => {
    const focus = (event: Event) => {
      const faceId = (event as CustomEvent<{ faceId?: string }>).detail?.faceId
      if (!faceId) return
      const scene = sceneRef.current
      const assembly = scene?.getObjectByName('spatial-assembly')
      const face = assembly?.children.find(child => child.userData.spatialFaceId === faceId)
      const camera = scene?.userData.camera as THREE.PerspectiveCamera | undefined
      const controls = scene?.userData.controls as OrbitControls | undefined
      if (!assembly || !camera || !controls) { pendingSpatialFaceRef.current = faceId; return }
      pendingSpatialFaceRef.current = null
      let center: THREE.Vector3, distance: number, normal: THREE.Vector3
      if (face) {
        const box = new THREE.Box3().setFromObject(face)
        center = box.getCenter(new THREE.Vector3())
        distance = Math.max(120, box.getSize(new THREE.Vector3()).length() * 1.2)
        normal = new THREE.Vector3(Math.sin(face.rotation.y), 0, Math.cos(face.rotation.y))
      } else {
        const state = useAppStore.getState()
        const layout = createSpatialLayout({ ...state.spatialLayout, thickness: state.splitConfig.thickness })
        const modelFace = layout.faces.find(item => item.id === faceId)
        if (!modelFace) return
        center = new THREE.Vector3(...faceToWorld(modelFace, modelFace.width / 2, modelFace.height / 2))
        distance = Math.max(120, Math.hypot(modelFace.width, modelFace.height) * 1.2)
        normal = new THREE.Vector3(...faceAxes(modelFace, modelFace.width / 2).normal)
      }
      controls.target.copy(center)
      camera.position.copy(center).add(normal.multiplyScalar(distance)).add(new THREE.Vector3(0, distance * 0.2, 0))
      camera.lookAt(center)
      controls.update()
      setViewPreset('free')
    }
    window.addEventListener('snapboard:focus-spatial-face', focus)
    return () => window.removeEventListener('snapboard:focus-spatial-face', focus)
  }, [])

  const disposeSubtree = (root:THREE.Object3D) => disposePreviewResources(root,sceneRef.current)

  // 非洞洞板场景使用轻量参考宿主。宿主只服务装配规划，不参与 3MF 制造导出。
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    const old = scene.getObjectByName('mount-host-preview')
    if (old) {
      scene.remove(old)
      disposeSubtree(old)
    }
    if (usesPegboardHost || spatialLayout.enabled) return
    if (!assemblyHostPreset) return
    const preview = createAssemblyHostPreview(assemblyHostPreset)
    scene.add(preview.object)
    scene.userData.assemblyView = { centerY: preview.centerY, size: preview.size }
    const camera = scene.userData.camera as THREE.PerspectiveCamera | undefined
    const controls = scene.userData.controls as OrbitControls | undefined
    if (camera && controls) {
      controls.target.set(0, preview.centerY, 0)
      camera.position.set(preview.size * 0.72, preview.centerY + preview.size * 0.26, preview.size * 0.78)
      camera.lookAt(controls.target)
      controls.update()
    }
    return () => {
      if (preview.object.parent) preview.object.parent.remove(preview.object)
      disposeSubtree(preview.object)
    }
    // disposeSubtree 只依赖模块内 Three.js 对象，场景切换时按 preset 重建即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assemblyHostPreset, assemblyHostPresetId, usesPegboardHost, spatialLayout.enabled])

  // 配件库拖拽会话：隐藏 HTML 卡片拖影，在 Three.js 场景中加载半透明真实模型。
  useEffect(() => {
    const unsubscribe=subscribePartDrag(payload => {
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
        if (token !== dragLoadTokenRef.current || sceneRef.current !== scene) {
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
      .catch(error => {if(token===dragLoadTokenRef.current&&sceneRef.current===scene)setAssemblyMessage(`无法预览配件：${error instanceof Error ? error.message : String(error)}`)})
    })
    return ()=>{unsubscribe();dragLoadTokenRef.current++}
  }, [libIndex])

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
      mesh.visible = usesPegboardHost && !spatialLayout.enabled
      scene.add(mesh)
    }
  }, [boards, usesPegboardHost, spatialLayout.enabled])

  // Board geometry changes only with shape/structure, not image placement or LUT state.
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    if (!active) { scene.userData.latticeWipe?.finish?.(); return }
    scene.userData.startLoop?.()
    let cancelled = false
    const controller = new AbortController()
    const inputs = [splitResult, splitCfg, textureEnabled, textureThickness, !!boardTexture.backEnabled,
      boardTexture.baseColor, usesPegboardHost, spatialLayout.enabled, assemblyMarking, assemblyMarkPlan, backAssemblySeams, projectName,sideOrderNumber,sidePreviewTick]
    const reportReady = () => {
      if (readyReportedRef.current) return
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (sceneRef.current !== scene || !activeRef.current || readyReportedRef.current) return
        readyReportedRef.current = true
        onReadyRef.current?.()
      }))
    }
    const previousInputs = lastPanelInputsRef.current
    const previousPanels = (previousInputs?.[0] as typeof splitResult)?.panels
    const currentPanels = splitResult?.panels
    const samePanels = previousPanels && currentPanels && previousPanels.length === currentPanels.length && currentPanels.every((panel, i) => {
      const before = previousPanels[i], keys = Object.keys(panel) as Array<keyof SplitPanel>
      return keys.length === Object.keys(before).length && keys.every(key => panel[key] === before[key])
    })
    // Confirming a trial changes project metadata, not the displayed geometry.
    // Keep its assembly and any running reveal rather than interrupt/rebuild it.
    if (previousInputs && samePanels && inputs.every((value, i) => i === 0 || i === 9 || i === 10 || previousInputs[i] === value) && scene.getObjectByName('split-assembly')) {
      lastPanelInputsRef.current = inputs
      displayedTrialRef.current = structurePreview
      if(!scene.userData.latticeBuilding&&!scene.userData.latticeWipe)setLattice3DStatus(null)
      reportReady()
      return
    }
    const setBuilding = claimPreviewBuildState(scene)
    invalidatePreviewReplay(scene)
    ;(scene.userData.latticeWipe as { finish?: () => void } | undefined)?.finish?.()
    const rebuildPanels = async () => {
      let stagedAssembly:THREE.Group|null=null
      const borrowed=new Map<THREE.Object3D,THREE.Object3D>()
      const loose=new Set<THREE.Object3D>()
      try {
      texturePreviewTokenRef.current++
      backPreviewTokenRef.current++
      if (import.meta.env.DEV) performance.mark('snapboard:board-geometry-rebuild')
      const panels = splitResult?.panels ?? []
      const textured = textureEnabled
      const oldRoots = [...scene.children].filter(child =>
        child.name?.startsWith('split-panel') ||
        child.name?.startsWith('split-assembly') ||
        child.name === 'texture-image-bounds')
      if (!panels.length) {
        scene.userData.disposeLatticeReplay?.()
        for (const child of oldRoots) {
          scene.remove(child)
          disposeSubtree(child)
        }
        panelMeshCacheRef.current.clear()
        panelLabelCacheRef.current.clear()
        panelCutoutKeyRef.current = null
        displayedTrialRef.current = null
        splitLayoutKeyRef.current = null
        setLattice3DStatus(null)
        return
      }

      const cutoutKey = JSON.stringify(panels.map(panel => [panel.latticeCutouts ?? [], panel.latticeFace ?? null]))
      const animateLattice = Boolean(oldRoots.some(root => root.name === 'split-assembly')
        && panelCutoutKeyRef.current !== null && (panelCutoutKeyRef.current !== cutoutKey || (structurePreview && displayedTrialRef.current !== structurePreview)))
      setBuilding(true)
      if (animateLattice) {
        setLattice3DStatus('正在准备三维通孔…')
        await new Promise<void>(resolve => requestAnimationFrame(() => window.setTimeout(resolve, 0)))
        if (cancelled) return
      }

      const layoutKey = JSON.stringify(panels.map(p => ({
        id: p.id,
        x: p.x, y: p.y, w: p.w, h: p.h,
        contour: p.contour,
      })))
      const shouldAutoFrame = splitLayoutKeyRef.current !== layoutKey
      // Keep the old assembly visible until both geometry and source images are ready.
      const textures = textured ? await Promise.all([
        preparedTexture(panels, 'front'), boardTexture.backEnabled ? preparedTexture(panels, 'back') : Promise.resolve(null),
      ]) : []
      if (cancelled) return
      // 装配组: 所有面板/标签以【全局 mm】放入组内, 组整体平移到原点居中。
      const assembly = new THREE.Group()
      stagedAssembly=assembly
      assembly.name = 'split-assembly'
      const deferredChildren:THREE.Object3D[]=[]
      const updateLabels:Array<()=>void>=[]

      // 网格签名: 影响几何的全部输入 (轮廓/孔位/打孔标志/板厚与孔型参数/颜色)。
      const backThickness = boardTexture.backEnabled ? textureThickness : 0
      const structuralThickness = Math.max(0.2, splitCfg.thickness - textureThickness - backThickness)
      const surfaceThickness = textureThickness
      const cfgKey = JSON.stringify([
        splitCfg.thickness, structuralThickness, surfaceThickness,
        splitCfg.slotLength, splitCfg.slotWidth, splitCfg.jointDiameter,
        splitCfg.cornerRadius, splitCfg.manufacturingChamfer,
        textured, !!boardTexture.backEnabled,
        boardTexture.baseColor,
        assemblyMarking.enabled && assemblyMarking.sideLogoEnabled ? assemblyMarking.brand : '',
        assemblyMarking.sideDepth, assemblyMarking.sideTextHeight,
      ])
      const makePanelMesh = async (p: SplitPanel, color: number): Promise<THREE.Object3D> => {
        let mesh: THREE.Object3D
          if (p.latticeFace) {
            mesh = new THREE.Group()
            const retained = isPlainRetainedFront(p)
            const layers = await createLatticeFaceMeshes(p.latticeFace, p.latticeFace.source?.options.sourceLayerId || (textured && retained) ? boardTexture.baseColor : color, p, splitCfg,textured,controller.signal)
            if (textured && retained) for (const layer of layers) {
              if (layer.userData.latticeFaceRole === 'face') layer.name = `split-panel-texture-${p.id}`
              if (boardTexture.backEnabled && layer.userData.latticeFaceRole === 'structure') layer.name = `split-panel-back-texture-${p.id}`
            }
            mesh.add(...layers)
            for (const hole of [...p.edge_holes.filter(h => !h.knocked), ...(p.closed_holes ?? [])])
              mesh.add(makeClosedHoleGuide(hole, splitCfg, splitCfg.thickness + 0.035, 12))
          } else if (textured) {
            mesh = new THREE.Group()
            const body = generateSplitPanelMesh({
              panel: p,
              cfg: { ...splitCfg, thickness: structuralThickness },
              color: 0x334b55,
              includeGuides: false,
              manufacturingChamfer: 0,
              curveSegments: 8,
            })
            body.name = `split-panel-body-${p.id}`
            body.position.z = backThickness
            const surface = generateSplitPanelMesh({
              panel: p,
              cfg: { ...splitCfg, thickness: surfaceThickness },
              color,
              includeGuides: true,
              manufacturingChamfer: splitCfg.manufacturingChamfer,
              manufacturingBevelSide: 'top',
              curveSegments: 8,
            })
            surface.name = `split-panel-texture-${p.id}`
            surface.position.z = backThickness + structuralThickness
            mesh.add(body, surface)
            if (boardTexture.backEnabled) {
              const backSurface = generateSplitPanelMesh({
                panel: p, cfg: { ...splitCfg, thickness: backThickness },
                color, includeGuides: false, manufacturingChamfer: splitCfg.manufacturingChamfer,
                manufacturingBevelSide: 'bottom', curveSegments: 8,
              })
              backSurface.name = `split-panel-back-texture-${p.id}`
              mesh.add(backSurface)
            }
          } else {
            mesh = generateSplitPanelMesh({ panel: p, cfg: splitCfg, color, curveSegments: 8,
              manufacturingChamfer: splitCfg.manufacturingChamfer })
          }
        return mesh
      }
      const nextMeshCache = new Map<string, THREE.Object3D>()
      const nextLabelCache = new Map<string, THREE.Object3D>()

      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      const nextLabels: THREE.Object3D[] = []
      for (let i = 0; i < panels.length; i++) {
        const p = panels[i]
        const color = SPLIT_PANEL_COLORS[i % SPLIT_PANEL_COLORS.length]
        const meshSig = JSON.stringify([
          p.id, p.x, p.y, p.w, p.h, p.contour, p.roundIdx ?? null, p.outerCorners ?? null,
          p.slots, p.round_holes, p.closed_holes ?? null, p.cutouts ?? null, p.latticeCutouts ?? null, p.latticeFace ?? null,
          p.edge_holes?.map(h => [h.x, h.y, !!h.knocked]) ?? [],
          cfgKey, color, boardTexture.backEnabled ? assemblyMarkPlan.panels[i]?.engravingPolygons : null, assemblyMarking.depth, assemblyMarkPlan.panels[i]?.numberMark,sideOrderNumber,
        ])
        let mesh = animateLattice ? undefined : panelMeshCacheRef.current.get(meshSig)
        if (!mesh) {mesh = await makePanelMesh(p, color);loose.add(mesh)}
        if (!panelMeshCacheRef.current.has(meshSig) || animateLattice) {
          const numberPlan=assemblyMarkPlan.panels[i]
          if(numberPlan?.numberMark && (p.latticeFace || numberPlan.numberMark.surface!=='back'))
            await applyPanelNumberPreview(mesh,p,splitCfg,numberPlan,assemblyMarking)
          if (boardTexture.backEnabled && textured && assemblyMarkPlan.panels[i]?.engravingPolygons.length) {
            await engraveBackMarkPreview(mesh, p, assemblyMarkPlan.panels[i].engravingPolygons,
              Math.min(assemblyMarking.depth, backThickness - .12))
          }
          if (!sideOrderNumber && assemblyMarking.enabled && assemblyMarking.sideLogoEnabled) {
            await engraveSideLogoPreview(mesh, p, splitCfg, assemblyMarking.brand,
              assemblyMarking.sideDepth ?? .24, assemblyMarking.sideTextHeight ?? 3.5)
          }
          if(sideOrderNumber){
            if(!await engraveSideOrderNumberPreview(mesh,p,splitCfg,sideOrderNumber,assemblyMarking.sideDepth??.24,assemblyMarking.sideTextHeight??3.5))
              throw new Error(`${p.id} 现有侧壁无法完整刻入 ${sideOrderNumber}`)
            mesh.userData.sideOrderNumber=sideOrderNumber
          }
          if (cancelled) return
        }
        nextMeshCache.set(meshSig, mesh)
        mesh.name = 'split-panel-' + p.id
        if(mesh.parent){borrowed.set(mesh,mesh.parent);deferredChildren.push(mesh)}
        else assembly.add(mesh)
        loose.delete(mesh)

        const labelText = assemblyMarkPlan.panels[i]?.panelId ?? p.id
        const labelColor = textured ? '#f4f7fb' : SPLIT_PANEL_HEX[i % SPLIT_PANEL_HEX.length]
        const labelSig = `${labelText}|${labelColor}`
        const label = (animateLattice ? undefined : panelLabelCacheRef.current.get(labelSig)) ?? makePanelLabel(labelText, labelColor)
        nextLabelCache.set(labelSig, label)
        updateLabels.push(()=>{
          label.name = 'split-panel-' + p.id
          label.userData.latticeFace = Boolean(p.latticeFace || p.latticeCutouts?.length)
          label.visible = !label.userData.latticeFace && !boardTexture.backEnabled && !animateLattice && viewPresetRef.current !== 'back'
          label.position.set(p.x + p.w / 2, p.y + p.h / 2, splitCfg.thickness + 6)
        })
        if(label.parent){borrowed.set(label,label.parent);deferredChildren.push(label)}
        else assembly.add(label)
        nextLabels.push(label)

        if (!boardTexture.backEnabled && assemblyMarking.enabled && assemblyMarkPlan.panels[i]?.engravingPolygons.length) {
          const markingPreview = makeBackEngravingPreview(assemblyMarkPlan.panels[i].engravingPolygons)
          if (markingPreview) {
            markingPreview.name = `split-panel-back-mark-${assemblyMarkPlan.panels[i].panelId}`
            assembly.add(markingPreview)
          }
        }

        minX = Math.min(minX, p.x)
        maxX = Math.max(maxX, p.x + p.w)
        minY = Math.min(minY, p.y)
        maxY = Math.max(maxY, p.y + p.h)
        if (animateLattice) {
          setLattice3DStatus(`正在构建三维孔壁 ${i + 1}/${panels.length}…`)
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
          if (cancelled) return
        }
      }
      if(cancelled)return
      // Cached meshes stay in the complete old assembly until every new panel
      // has succeeded. The following synchronous swap cannot expose half a board.
      if(deferredChildren.length)assembly.add(...deferredChildren)
      updateLabels.forEach(update=>update())
      for (const [index, prepared] of textures.entries()) if (prepared)
        applyTexturePreview(prepared.canvas, prepared.config, index === 0 ? 'front' : 'back', assembly, panels, prepared.key)
      // 图片贴面会让所有板背面呈现同一种基材色，真实共面接缝因此完全消失。
      // 背视图使用独立预览色带标出共享边，不修改板件几何，也不进入3MF。
      const backSeamGuide = makeBackSeamGuide(backAssemblySeams)
      if (backSeamGuide) {
        backSeamGuide.visible = viewPresetRef.current === 'back'
        assembly.add(backSeamGuide)
      }

      const cx = (minX + maxX) / 2
      const midY = (minY + maxY) / 2
      assembly.position.set(-cx, -minY, 0)
      assembly.visible = usesPegboardHost && !spatialLayout.enabled
      const previousAssembly = animateLattice ? oldRoots.find(root => root.name === 'split-assembly') : undefined
      if (previousAssembly) previousAssembly.name = 'split-assembly-previous'
      scene.userData.disposeLatticeReplay?.()
      // Retained cached panels may still share a texture with a removed panel.
      // Make their new assembly reachable before releasing the captured old roots.
      scene.add(assembly)
      if (!animateLattice) for (const child of oldRoots) {
        scene.remove(child)
        disposeSubtree(child)
      }
      stagedAssembly=null
      borrowed.clear()
      panelMeshCacheRef.current = nextMeshCache
      panelLabelCacheRef.current = nextLabelCache
      splitLayoutKeyRef.current = layoutKey
      scene.userData.textureBoundsOverlay = null
      scene.userData.boardTexturePreview = assembly.userData.boardTexturePreview ?? null
      scene.userData.backTexturePreview = assembly.userData.backTexturePreview ?? null
      setBuilding(false)
      if (!animateLattice) setMeshReadyRevision(revision => revision + 1)
      let replayBase: THREE.Group | null = null
      const playReveal = (previous: THREE.Object3D, replay = false) => {
        if (import.meta.env.DEV) performance.mark('snapboard:lattice-reveal-prepare')
        const deferred: THREE.Object3D[] = []
        assembly.traverse(object => {
          if (object.name === 'planned-hole-guide' || nextLabels.includes(object)) {
            object.visible = false; deferred.push(object)
          }
        })
        const renderer = scene.userData.renderer as THREE.WebGLRenderer
        const camera = scene.userData.camera as THREE.PerspectiveCamera
        // Warm the normal textured materials and GPU images too. Restoring them
        // at the end must not trigger another UV bake, image upload or compile.
        const normalTarget = renderer.getRenderTarget()
        renderer.setRenderTarget((scene.userData.composer as EffectComposer).readBuffer)
        try { renderer.compile(scene, camera); renderer.render(scene, camera) } finally { renderer.setRenderTarget(normalTarget) }
        const wipe = createLatticeReveal({ scene, previous, current: assembly, panels,
          thickness: splitCfg.thickness, camera, reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
          onFinish: () => {
            for (const label of nextLabels) label.visible = !label.userData.latticeFace && !boardTexture.backEnabled && viewPresetRef.current !== 'back'
            for (const guide of deferred) if (!nextLabels.includes(guide)) guide.visible = true
            if (replay) scene.remove(previous)
            else for (const child of oldRoots) { scene.remove(child); disposeSubtree(child) }
            if (scene.userData.latticeWipe === wipe) scene.userData.latticeWipe = null
            if (import.meta.env.DEV) performance.mark('snapboard:lattice-reveal-end')
            if (sceneRef.current === scene) { setMeshReadyRevision(revision => revision + 1); setLattice3DStatus(null) }
          },
        })
        scene.userData.latticeWipe = wipe
        // Warm the offscreen material variants used by the composer; never put
        // a raw, differently tone-mapped frame on the visible canvas.
        const target = renderer.getRenderTarget()
        renderer.setRenderTarget((scene.userData.composer as EffectComposer).readBuffer)
        try { renderer.compile(scene, camera) } finally { renderer.setRenderTarget(target) }
        scene.userData.renderFrame()
        if (import.meta.env.DEV) performance.mark('snapboard:lattice-reveal-ready', { detail: {
          frontTextured: Boolean(assembly.userData.boardTexturePreview), backTextured: Boolean(assembly.userData.backTexturePreview),
        } })
        if (import.meta.env.DEV) performance.measure('snapboard:lattice-reveal-prepare', 'snapboard:lattice-reveal-prepare')
        wipe.start()
        scene.userData.startLoop?.()
        setLattice3DStatus('斜向光谱破碎 · 三维结构已就绪')
      }
      if (previousAssembly) playReveal(previousAssembly)
      else setLattice3DStatus(null)
      scene.userData.replayLattice = async () => {
        const replayIsCurrent = capturePreviewReplay(scene)
        const isCurrent = () => replayIsCurrent() && sceneRef.current === scene && scene.getObjectByName('split-assembly') === assembly && activeRef.current
        if (!isCurrent() || scene.userData.latticeBuilding || scene.userData.latticeWipe || !assembly.visible) return
        const setReplayBuilding = claimPreviewBuildState(scene)
        if (!replayBase) {
          setReplayBuilding(true)
          setLattice3DStatus('正在准备展示…')
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
          if (!isCurrent()) { setReplayBuilding(false); return }
          const base = new THREE.Group()
          replayBase = base
          base.name = 'lattice-replay-base'
          base.position.copy(assembly.position)
          const ownsBase = () => isCurrent() && replayBase === base
          const releaseBase = () => {
            if (replayBase === base) { disposeSubtree(base); replayBase = null }
            setReplayBuilding(false)
          }
          try {
            for (let i = 0; i < panels.length; i++) {
              if (!ownsBase()) { releaseBase(); return }
              const attached = await appendPreviewResource(base,
                makePanelMesh({ ...panels[i], latticeCutouts: undefined, latticeFace: undefined }, SPLIT_PANEL_COLORS[i % SPLIT_PANEL_COLORS.length]),
                ownsBase, scene)
              if (!attached) { releaseBase(); return }
              await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
            }
            if (!ownsBase()) { releaseBase(); return }
            for (const [index, prepared] of textures.entries()) if (prepared)
              applyTexturePreview(prepared.canvas, prepared.config, index === 0 ? 'front' : 'back', base, panels, prepared.key)
          } catch (error) {
            const current = ownsBase()
            releaseBase()
            if (current) setLattice3DStatus(`三维展示准备失败：${error instanceof Error ? error.message : String(error)}`)
            return
          }
          setReplayBuilding(false)
        }
        if (!isCurrent() || !replayBase) { setReplayBuilding(false); setLattice3DStatus(null); return }
        scene.add(replayBase)
        playReveal(replayBase, true)
      }
      scene.userData.disposeLatticeReplay = () => {
        if (replayBase) { scene.remove(replayBase); disposeSubtree(replayBase); replayBase = null }
        scene.userData.replayLattice = null
      }
      panelCutoutKeyRef.current = cutoutKey
      displayedTrialRef.current = structurePreview
      scene.userData.textureMapping = {
        minX: minX - cx,
        maxX: maxX - cx,
        minY: 0,
        maxY: maxY - minY,
        width: Math.max(1, maxX - minX),
        height: Math.max(1, maxY - minY),
        worldMinX: minX,
        worldMinY: minY,
      }
      scene.userData.assemblyView = {
        centerY: midY - minY,
        size: Math.max(maxX - minX, maxY - minY, 80),
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
      // The first texture may arrive after the front-view session starts. Fit
      // once to the real board bounds instead of retaining its empty-scene size.
      if (shouldAutoFrame && viewPresetRef.current !== 'free') {
        window.dispatchEvent(new CustomEvent('snapboard:set-view-preset', { detail: { preset: viewPresetRef.current } }))
      }
      } finally {
        if(stagedAssembly){
          for(const [object,parent]of borrowed)if(object.parent===stagedAssembly)parent.add(object)
          disposeSubtree(stagedAssembly)
        }
        for(const object of loose)disposeSubtree(object)
      }
    }

    void rebuildPanels().then(() => {
      if (cancelled) return
      lastPanelInputsRef.current = inputs
      reportReady()
      if(!spatialLayout.enabled){
        finishSidePreview(currentPanels?.length??0)
        if(sideOrderNumber && scene.userData.camera && scene.userData.controls && currentPanels?.length){
          selectViewPreset('free')
          const assembly=scene.getObjectByName('split-assembly')!
          const first=currentPanels[0]
          const cuts=sideOrderNumberEngravings(first,splitCfg,sideOrderNumber,assemblyMarking)
          const mark=cuts[0].marks[0],target=assembly.localToWorld(new THREE.Vector3(mark.x,mark.y,cuts[0].zMm))
          const camera=scene.userData.camera as THREE.PerspectiveCamera,controls=scene.userData.controls as OrbitControls
          const distance=Math.max(65,mark.width*1.5)
          assembly.traverse(object=>{if((object as THREE.Sprite).isSprite)object.visible=false})
          camera.up.set(0,0,1);controls.target.copy(target)
          camera.position.copy(target).add(new THREE.Vector3(0,distance,distance*.12))
          camera.lookAt(target);controls.update()

        }
      }
    }).catch(error => {
      if (!cancelled) {
        setBuilding(false)
        if(import.meta.env.DEV)performance.mark('snapboard:board-preview-retained-on-error',{detail:{
          panelCount:scene.getObjectByName('split-assembly')?.children.filter(child=>!(child instanceof THREE.Sprite)&&currentPanels?.some(p=>child.name===`split-panel-${p.id}`)).length??0,
        }})
        finishSidePreview(0,error instanceof Error?error.message:String(error))
        setLattice3DStatus(`三维孔壁预览失败：${error instanceof Error ? error.message : String(error)}`)
      }
    })
    return () => {
      cancelled = true
      invalidatePreviewReplay(scene)
      controller.abort()
      setBuilding(false)
    }
  }, [active, splitResult, splitCfg, textureEnabled, textureThickness, boardTexture.backEnabled,
    boardTexture.baseColor, usesPegboardHost, spatialLayout.enabled, assemblyMarking, assemblyMarkPlan, backAssemblySeams, projectName,sideOrderNumber,sidePreviewTick])

  useEffect(() => {
    const scene = sceneRef.current
    if (!scene || !active) return
    const old = scene.getObjectByName('spatial-assembly')
    if (old && !spatialLayout.enabled) { scene.remove(old); disposeSubtree(old) }
    scene.userData.spatialHoleTargets = []
    const flatAssembly = scene.getObjectByName('split-assembly')
    if (flatAssembly) flatAssembly.visible = usesPegboardHost && !spatialLayout.enabled
    if (!spatialLayout.enabled) {
      spatialFrameKeyRef.current = null
      scene.userData.spatialLayoutModel = null
      scene.userData.spatialDisplayedLayout = null
      return
    }
    const controller = new AbortController()
    const frameKey = JSON.stringify([
      spatialLayout.template, spatialLayout.polygonSides, spatialLayout.width, spatialLayout.depth, spatialLayout.height,
      spatialLayout.angleDegrees, spatialLayout.bendStyle, spatialLayout.bendSizeMm,
      spatialLayout.manufacturingMode, splitCfg.thickness,
      splitCfg.printerPreset, splitCfg.bedW, splitCfg.bedH, splitCfg.bedMarginLeft, splitCfg.bedMarginRight,
      splitCfg.bedMarginBottom, splitCfg.bedMarginTop, splitCfg.bedKeepouts,
      spatialLayout.printSafetyMarginMm, spatialLayout.customPrintHeight,
      spatialLayout.printedAngleConnector,
    ])
    const shouldFrame = spatialFrameKeyRef.current !== frameKey
    spatialFrameKeyRef.current = frameKey
    const isCurrent = () => !controller.signal.aborted && sceneRef.current === scene &&
      useAppStore.getState().spatialLayout === spatialLayout && useAppStore.getState().splitConfig === splitCfg && useAppStore.getState().assemblyMarking === assemblyMarking
    const showAssembly = (assembly: THREE.Group) => {
      if (!isCurrent()) { if (assembly.parent !== scene) disposeSubtree(assembly); return }
      scene.add(assembly)
      for (const previous of scene.children.filter(child => child.name === 'spatial-assembly' && child !== assembly)) {
        scene.remove(previous); disposeSubtree(previous)
      }
      scene.userData.spatialDisplayedLayout = scene.userData.spatialLayoutModel
      const selected = useAppStore.getState().selectedHole
      if (selected?.spatialKey) {
        const target = (scene.userData.spatialHoleTargets as SpatialHoleTarget[]).find(target =>
          spatialHoleKey(target.face.phaseU + target.x, target.y) === selected.spatialKey)
        useAppStore.getState().selectHole(target ? { panel: target.panel, x: target.x, y: target.localY,
          spatialKey: selected.spatialKey, spatialFace: target.face, spatialOffsetY: target.offsetY } : null)
      }
      setAssemblyMessage(null)
      const box = new THREE.Box3().setFromObject(assembly)
      const center = box.getCenter(new THREE.Vector3())
      const extents = box.getSize(new THREE.Vector3())
      const size = Math.max(80, extents.length(), extents.y * 1.35)
      const camera = scene.userData.camera as THREE.PerspectiveCamera | undefined
      const controls = scene.userData.controls as OrbitControls | undefined
      if (camera && controls && shouldFrame) {
        controls.target.copy(center)
        camera.position.copy(center).add(new THREE.Vector3(size * 0.7, size * 0.5, size * 0.85))
        camera.far = Math.max(5000, size * 10)
        camera.updateProjectionMatrix()
        camera.lookAt(center)
        controls.update()
      }
      scene.userData.assemblyView = { centerY: center.y, size }
      if (pendingSpatialFaceRef.current) {
        window.dispatchEvent(new CustomEvent('snapboard:focus-spatial-face', {
          detail: { faceId: pendingSpatialFaceRef.current },
        }))
      }
    }
    try {
      const plan = resolveSpatialManufacturing(spatialLayout, splitCfg)
      scene.userData.spatialLayoutModel = plan.layout
      if (plan.error && plan.mode !== 'monolithic') { setAssemblyMessage(plan.error); return }
      void createSpatialPanels(plan.layout, plan.printCfg, plan.mode,
        plan.mode !== 'monolithic' && spatialLayout.printedAngleConnector, controller.signal,
        undefined, spatialLayout).then(async pieces => {
        if (!isCurrent()) return
        useAppStore.setState({ spatialPreviewCount: plan.mode === 'monolithic' ? null : {
          key: JSON.stringify([spatialLayout, splitCfg]), count: pieces.length,
        } })
        if (plan.mode === 'monolithic') {
          void import('../../utils/spatialSolid').then(async tools => {
            const sections = splitSpatialHeight(plan.layout, pieces, plan.printHeight, plan.printCfg)
            const assembly = new THREE.Group()
            assembly.name = 'spatial-assembly'
            const holeTargets: SpatialHoleTarget[] = []
            let partCount = 0
            try {
            for (const section of sections) {
              if (controller.signal.aborted || sceneRef.current !== scene) { disposeSubtree(assembly); return }
              if (sections.length > 1) setAssemblyMessage(`正在更新立体分节 ${section.index + 1}/${sections.length}`)
              const { solid, wasm } = await tools.createOnePieceSolid(section.layout, section.panels,
                plan.printCfg, spatialLayout)
              try {
                const parts = tools.splitSolidForPrint(solid, plan.printCfg, spatialLayout, wasm, section.panels, section.offsetY)
                try { for (const printPart of parts) {
                const engraved=sideOrderNumber?(await import('../../utils/orderEngraving')).engraveSpatialSideNumber(printPart.solid,printPart.faces,plan.printCfg,wasm,sideOrderNumber,assemblyMarking):null
                const part = engraved??printPart.solid
                const bounds = part.boundingBox()
                const multiple = sections.length > 1 || parts.length > 1 || plan.needsBedSplit
                const model = part.getMesh()
                const positions = new Float32Array(model.vertProperties.length / model.numProp * 3)
                for (let vertex = 0; vertex < positions.length / 3; vertex++) {
                  const source = vertex * model.numProp
                  positions.set(model.vertProperties.subarray(source, source + 3), vertex * 3)
                }
                const geometry = new THREE.BufferGeometry()
                geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
                geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(model.triVerts), 1))
                engraved?.delete()
                geometry.computeVertexNormals()
                const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
                  color: SPLIT_PANEL_COLORS[partCount % SPLIT_PANEL_COLORS.length],
                  roughness: 0.62, metalness: 0.06,
                  flatShading: true, side: THREE.DoubleSide,
                }))
                const id = `M${String(++partCount).padStart(2, '0')}`
                mesh.name = `spatial-print-part-${id}`
                mesh.position.y = section.offsetY
                assembly.add(mesh)
                if (multiple) {
                  const label = makePanelLabel(id, '#ffffff')
                  label.scale.set(25, 12.5, 1)
                  label.position.set((bounds.min[0] + bounds.max[0]) / 2,
                    bounds.max[1] + section.offsetY + 6, (bounds.min[2] + bounds.max[2]) / 2)
                  assembly.add(label)
                }
                for (const { face, panel } of printPart.faces) {
                  const guides = new THREE.Group()
                  guides.position.set(...face.origin)
                  guides.rotation.y = -Math.atan2(face.u[2], face.u[0])
                  for (const { hole, group: holeGroup, mode } of panelHoleEntries(panel)) {
                    const point = faceToWorld(face, hole.x, hole.y)
                    if (point.some((value, axis) => value < bounds.min[axis] - 0.01 || value > bounds.max[axis] + 0.01)) continue
                    const y = hole.y + section.offsetY
                    holeTargets.push({ face, panel, x: hole.x, y, localY: hole.y, offsetY: section.offsetY, knocked: mode !== 'closed', group: holeGroup })
                    if (mode === 'closed') {
                      const targetGroup = face.curve ? new THREE.Group() : guides
                      if (face.curve) {
                        const { u } = faceAxes(face, hole.x)
                        targetGroup.position.set(...faceToWorld(face, hole.x, 0))
                        targetGroup.rotation.y = -Math.atan2(u[2], u[0])
                        assembly.add(targetGroup)
                      }
                      for (const side of [-1, 1]) targetGroup.add(makeClosedHoleGuide({ ...hole, x: face.curve ? 0 : hole.x, y },
                        splitCfg, side * (splitCfg.thickness / 2 + 0.08), 24))
                    }
                  }
                  assembly.add(guides)
                }
                } } finally { parts.forEach(part => part.solid.delete()) }
              } finally { solid.delete() }
              await new Promise<void>(resolve => window.setTimeout(resolve, 0))
            }
            if (!isCurrent()) { disposeSubtree(assembly); return }
            scene.userData.spatialHoleTargets = holeTargets
            useAppStore.setState({ spatialPreviewCount: { key: JSON.stringify([spatialLayout, splitCfg]), count: partCount } })
            showAssembly(assembly);finishSidePreview(partCount)
            } catch (error) { disposeSubtree(assembly); throw error }
          }).catch(error => {
            if (!controller.signal.aborted) {finishSidePreview(0,error instanceof Error?error.message:String(error));setAssemblyMessage(`一体板件预览失败：${error instanceof Error ? error.message : String(error)}`)}
          })
          return
        }
        const assembly = new THREE.Group()
        assembly.name = 'spatial-assembly'
        const faceGroups = new Map<string, THREE.Group>()
        for (const [index, face] of plan.layout.faces.entries()) {
          const group = new THREE.Group()
          group.position.set(...face.origin)
          group.rotation.y = -Math.atan2(face.u[2], face.u[0])
          assembly.add(group)
          faceGroups.set(face.id, group)
          group.userData.spatialFaceId = face.id
          group.userData.color = SPLIT_PANEL_COLORS[index % SPLIT_PANEL_COLORS.length]
        }
        const flatHoleTargets: SpatialHoleTarget[] = []
        for (const [pieceIndex, { face, panel }] of pieces.entries()) {
          const group = faceGroups.get(face.id)!
          const mesh = generateSplitPanelMesh({ panel, cfg: { ...splitCfg, cornerRadius: 0 },
            color: SPLIT_PANEL_COLORS[pieceIndex % SPLIT_PANEL_COLORS.length], curveSegments: 12, slotCapSegments: 8,
            includeGuides: true, manufacturingChamfer: splitCfg.manufacturingChamfer })
          if(sideOrderNumber && !await engraveSideOrderNumberPreview(mesh,panel,splitCfg,sideOrderNumber,assemblyMarking.sideDepth??.24,assemblyMarking.sideTextHeight??3.5))
            throw new Error(`${panel.id} 侧面放不下完整订单号`)
          mesh.name = `spatial-panel-${panel.id}`
          mesh.position.z = -splitCfg.thickness / 2
          group.add(mesh)
          flatHoleTargets.push(...panelHoleEntries(panel).map(({ hole, group, mode }) => ({ face, panel, x: hole.x, y: hole.y,
            localY: hole.y, offsetY: 0, knocked: mode !== 'closed', group })))
          if (plan.mode === 'bed-split') {
            const contour = panel.contour?.length ? panel.contour : [
              { x: panel.x, y: panel.y }, { x: panel.x + panel.w, y: panel.y },
              { x: panel.x + panel.w, y: panel.y + panel.h }, { x: panel.x, y: panel.y + panel.h },
            ]
            const boundary = new THREE.BufferGeometry().setFromPoints(contour.map(point =>
              new THREE.Vector3(point.x, point.y, splitCfg.thickness / 2 + 0.4)))
            const line = new THREE.LineLoop(boundary, new THREE.LineBasicMaterial({ color: 0xeef8f6 }))
            line.name = `spatial-seam-${panel.id}`
            group.add(line)
          }
        }
        if (!isCurrent()) { disposeSubtree(assembly); return }
        scene.userData.spatialHoleTargets = flatHoleTargets
        showAssembly(assembly);finishSidePreview(pieces.length)
        const mountsReady = !spatialLayout.printedAngleConnector || spatialConnectorMountsOpen(plan.layout, pieces)
        if (!mountsReady) setAssemblyMessage('连接件固定孔已关闭：临时连接件隐藏，导出仅包含板件')
        if (spatialLayout.printedAngleConnector && mountsReady) {
          void Promise.all([
            import('../../utils/spatialSolid'), import('../../utils/spatialConnector'),
          ]).then(async ([solidTools, connectorTools]) => {
            const wasm = await solidTools.spatialManifold()
            if (!isCurrent()) return
            for (const [index, junction] of plan.layout.junctions.entries()) {
              const from = plan.layout.faces.find(face => face.id === junction.from)!
              const solid = connectorTools.createPrintedAngleConnector(wasm, junction.angleDegrees,
                splitCfg.thickness, spatialLayout.connectorClearanceMm)
              try {
                const model = solid.getMesh()
                const positions = new Float32Array(model.vertProperties.length / model.numProp * 3)
                for (let vertex = 0; vertex < positions.length / 3; vertex++) {
                  const source = vertex * model.numProp
                  positions.set(model.vertProperties.subarray(source, source + 3), vertex * 3)
                }
                const geometry = new THREE.BufferGeometry()
                geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
                geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(model.triVerts), 1))
                geometry.computeVertexNormals()
                const offset = (splitCfg.thickness + 5) / 2
                const shift = offset * Math.tan((180 - junction.angleDegrees) * Math.PI / 360)
                const centers = from.height >= 100 ? [25, from.height - 25] : [from.height / 2]
                for (const centerY of centers) {
                  const mesh = new THREE.Mesh(geometry.clone(), new THREE.MeshStandardMaterial({
                    color: 0xff986e, roughness: 0.65, metalness: 0.05, side: THREE.DoubleSide,
                  }))
                  mesh.name = `spatial-connector-J${index + 1}`
                  mesh.position.set(...faceToWorld(from, from.width + shift, centerY - 15, offset))
                  mesh.rotation.y = -Math.atan2(from.u[2], from.u[0])
                  assembly.add(mesh)
                }
                geometry.dispose()
              } finally { solid.delete() }
            }
            showAssembly(assembly)
          }).catch(error => {
            if (!controller.signal.aborted) setAssemblyMessage(`连接件预览失败：${error instanceof Error ? error.message : String(error)}`)
          })
        }
      }).catch(error => {
        if (!controller.signal.aborted) setAssemblyMessage(`立体版面预览失败：${error instanceof Error ? error.message : String(error)}`)
      })
    } catch (error) { setAssemblyMessage(`立体版面无效：${error instanceof Error ? error.message : String(error)}`) }
    return () => {
      controller.abort()
      scene.userData.spatialLayoutModel = null
      scene.userData.spatialHoleTargets = []
      if (sceneRef.current !== scene || !activeRef.current || !useAppStore.getState().spatialLayout.enabled) {
        const current = scene.getObjectByName('spatial-assembly')
        if (current) { scene.remove(current); disposeSubtree(current) }
      }
    }
    // disposeSubtree is stable for a mounted scene and handles Three objects only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, spatialLayout, splitCfg, usesPegboardHost,assemblyMarking,sideOrderNumber,sidePreviewTick])

  const preparedTexture = async (panels: SplitPanel[], side: 'front' | 'back') => {
    const config = side === 'front' ? boardTexture : backTexture
    const bounds = getSplitPanelTextureBounds(panels)
    const sidePanels = texturePanelsForSide(panels, side)
    const key = config ? textureCanvasKey(config, bounds.width / bounds.height, sidePanels) : 'blank:' + boardTexture.baseColor
    const cache = side === 'front' ? texturePreviewCacheRef : backTexturePreviewCacheRef
    const solved = side === 'front' ? textureSolve.frontKey === key ? textureSolve.canvas : null
      : textureSolve.backKey === key ? textureSolve.backCanvas : null
    let canvas = solved ?? (cache.current?.key === key ? cache.current.canvas : null)
    if (!canvas) {
      if (config) canvas = await createLayoutTextureCanvas(config, bounds.width / bounds.height, sidePanels)
      else {
        canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
        const ctx = canvas.getContext('2d')!
        ctx.fillStyle = boardTexture.baseColor; ctx.fillRect(0, 0, 1, 1)
      }
    }
    if (!canvas) return null
    cache.current = { key, canvas }
    return { canvas, config: config ?? boardTexture, key }
  }

  const applyTexturePreview = (canvas: HTMLCanvasElement, config: BoardTextureConfig, side: 'front' | 'back' = 'front',
    target?: THREE.Object3D, targetPanels?: SplitPanel[], preparedKey?: string) => {
    const scene = sceneRef.current
    const root = target ?? scene?.getObjectByName('split-assembly')
    const panels = targetPanels ?? splitResult?.panels ?? []
    if (!scene || !root || !panels.length || (!target && (scene.userData.latticeBuilding || scene.userData.latticeWipe))) return
    const bounds = getSplitPanelTextureBounds(panels)
    const key = preparedKey ?? textureCanvasKey(config, bounds.width / bounds.height, texturePanelsForSide(panels, side))
    const surfaces: THREE.Object3D[] = []
    root.traverse(object => {
      if (object.name.startsWith(side === 'back' ? 'split-panel-back-texture-' : 'split-panel-texture-')) surfaces.push(object)
    })
    if (!surfaces.length) return
    const storageKey = side === 'back' ? 'backTexturePreview' : 'boardTexturePreview'
    if (surfaces.every(surface => surface.userData.previewCanvas === canvas && surface.userData.previewKey === key)) {
      root.userData[storageKey] = surfaces[0].userData.previewTexture
      return
    }
    const texture = new THREE.CanvasTexture(canvas)
    if (import.meta.env.DEV) performance.mark('snapboard:texture-preview-upload', { detail: { side } })
    texture.colorSpace = THREE.SRGBColorSpace
    if (config.modelingMode === 'pixel') {
      texture.magFilter = THREE.NearestFilter; texture.minFilter = THREE.NearestFilter; texture.generateMipmaps = false
    } else {
      texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter; texture.generateMipmaps = true
      texture.anisotropy = Math.max(1, Math.min(8, (scene.userData.renderer as THREE.WebGLRenderer).capabilities.getMaxAnisotropy()))
    }
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping
    texture.userData.snapboardTexture = true
    for (const surface of surfaces) {
      applyBoardTexture(surface, texture, bounds, side === 'back')
      Object.assign(surface.userData, { previewCanvas: canvas, previewKey: key, previewTexture: texture })
    }
    root.userData[storageKey] = texture
    if (root === scene.getObjectByName('split-assembly')) scene.userData[storageKey] = texture
  }

  const previewLayerTransform = (layerId: string, transform: TextureCompositionTransform): BoardTextureConfig => ({
    ...editingTexture, source: 'composition', opacity: 1,
    composition: { ...textureComposition, layers: textureComposition.layers.map(layer =>
      layer.id === layerId && layer.kind !== 'panel-sequence' && (layer.placement.mode === 'free' || layer.placement.mode === 'repeat')
        ? { ...layer, placement: { ...layer.placement, autoFit: false, transform } } : layer),
    },
  })

  const requestLayoutPreview = (draft: BoardTextureConfig) => {
    textureDraftRef.current = draft
    if (textureDraftFrameRef.current !== null || textureDraftRenderingRef.current) return
    textureDraftFrameRef.current = window.requestAnimationFrame(() => {
      textureDraftFrameRef.current = null
      const latest = textureDraftRef.current
      const panels = useAppStore.getState().splitResult?.panels ?? []
      if (!latest || !panels.length) return
      textureDraftRenderingRef.current = true
      const tokenRef = editSide === 'back' ? backPreviewTokenRef : texturePreviewTokenRef
      const token = ++tokenRef.current
      const bounds = getSplitPanelTextureBounds(panels)
      const state = useAppStore.getState()
      const draft = editSide === 'back' ? backTextureForRendering({ ...state.boardTexture, backTexture: latest }, panels, state.splitConfig, state.assemblyMarking, state.project.metadata.name) ?? latest : latest
      void createLayoutTextureCanvas(draft, bounds.width / bounds.height, texturePanelsForSide(panels, editSide)).then(canvas => {
        if (canvas && token === tokenRef.current) applyTexturePreview(canvas, latest, editSide)
      }).catch(error => console.warn('纹理拖动预览失败', error)).finally(() => {
        textureDraftRenderingRef.current = false
        if (textureDraftRef.current && textureDraftRef.current !== latest) requestLayoutPreview(textureDraftRef.current)
      })
    })
  }

  const solvedCanvas = textureSolve.frontKey === colorKeys.front ? textureSolve.canvas : null
  useEffect(() => {
    const scene = sceneRef.current, root = scene?.getObjectByName('split-assembly')
    const panels = splitResult?.panels ?? []
    if (!scene || !root || !active || !textureEnabled || !panels.length || scene.userData.latticeBuilding || scene.userData.latticeWipe) return
    const token = ++texturePreviewTokenRef.current
    void preparedTexture(panels, 'front').then(prepared => {
      if (prepared && token === texturePreviewTokenRef.current && sceneRef.current === scene && root === scene.getObjectByName('split-assembly') && !scene.userData.latticeBuilding && !scene.userData.latticeWipe)
        applyTexturePreview(prepared.canvas, prepared.config, 'front', root, panels, prepared.key)
    }).catch(error => console.warn('纹理排版预览失败', error))
    return () => { texturePreviewTokenRef.current++ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, splitResult, splitCfg, textureEnabled, colorKeys.front, textureSolve.revision, solvedCanvas, editSide, usesPegboardHost, assemblyMarkPlan, meshReadyRevision])

  useEffect(() => {
    const scene = sceneRef.current, root = scene?.getObjectByName('split-assembly')
    const panels = splitResult?.panels ?? []
    if (!scene || !root || !active || !textureEnabled || !boardTexture.backEnabled || !panels.length || spatialLayout.enabled || scene.userData.latticeBuilding || scene.userData.latticeWipe) return
    const token = ++backPreviewTokenRef.current
    void preparedTexture(panels, 'back').then(prepared => {
      if (prepared && token === backPreviewTokenRef.current && sceneRef.current === scene && root === scene.getObjectByName('split-assembly') && !scene.userData.latticeBuilding && !scene.userData.latticeWipe)
        applyTexturePreview(prepared.canvas, prepared.config, 'back', root, panels, prepared.key)
    }).catch(error => console.warn('背面纹理预览失败', error))
    return () => { backPreviewTokenRef.current++ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, splitResult, textureEnabled, boardTexture.backEnabled, backTexture, colorKeys.back, textureSolve.revision, textureSolve.backCanvas, editSide, splitCfg, spatialLayout.enabled, meshReadyRevision])

  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    const old = scene.userData.textureBoundsOverlay as THREE.Object3D | null
    if (old) { scene.remove(old); disposeSubtree(old) }
    scene.userData.textureBoundsOverlay = null
    const mapping = scene.userData.textureMapping
    if (!mapping || !splitResult?.panels.length) return
    const overlay = createTextureBoundsOverlay(editingTexture, mapping, editSide === 'back' ? -1.1 : splitCfg.thickness + 1.1,
      selectedEditableTextureLayer?.placement.transform, editSide === 'back')
    overlay.visible = usesPegboardHost && textureMappingMode
    scene.userData.textureBoundsOverlay = overlay
    scene.add(overlay)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardTexture, editSide, selectedEditableTextureLayer, splitResult, splitCfg, textureMappingMode, usesPegboardHost, assemblyMarkPlan])

  // 渲染配件 (placedParts 变化时重建)
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    let cancelled=false

    // 移除旧配件 — 释放 geometry/material
    for (const child of [...scene.children]) {
      if ((child as THREE.Object3D).name?.startsWith('part-')) {
        scene.remove(child)
        disposeSubtree(child)
      }
    }

    if (!usesPegboardHost || spatialLayout.enabled) return

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
            if (cancelled || !stillPlaced?.placement || sceneRef.current !== scene || useAppStore.getState().spatialLayout.enabled) { disposeSubtree(obj); return }
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
          .catch(error => {if(!cancelled&&sceneRef.current===scene)setAssemblyMessage(`配件模型加载失败：${error instanceof Error ? error.message : String(error)}`)})
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
          if (cancelled || !stillPlaced || sceneRef.current !== scene || useAppStore.getState().spatialLayout.enabled) { disposeSubtree(obj); return }
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
        .catch(error => {if(!cancelled&&sceneRef.current===scene)setAssemblyMessage(`配件模型加载失败：${error instanceof Error ? error.message : String(error)}`)})
    }
    return ()=>{cancelled=true}
  }, [placedParts, boards, libIndex, usesPegboardHost, spatialLayout.enabled])

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
    if (!usesPegboardHost) {
      clearSnapHighlights(highlightGroup)
      return
    }
    const selected = selectedPartId ? placedParts.find(part => part.id === selectedPartId) : undefined
    if (!selected?.placement || !splitResult?.panels.length) {
      clearSnapHighlights(highlightGroup)
      return
    }
    const side = selected.placement.side ?? 'front'
    const occupied = new Set(selected.placement.targetIds)
    const targets = splitPanelTargets(splitResult.panels, splitCfg, side).filter(target => occupied.has(target.id))
    renderSnapHighlights(highlightGroup, targets, side, 0x62e6cf)
  }, [selectedPartId, placedParts, splitResult, splitCfg, highlightRevision, usesPegboardHost])

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
    return { fit: fitPartAnchors(anchors, targets, point, 35, 4, undefined, occupiedIds, contactZForSide(mount.contactZ, side), mount.slideY ?? 0), point }
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
    if (spatialLayout.enabled) { setAssemblyMessage('立体版面的配件吸附尚未接入；请先切回平面工程放置配件'); return }
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
    if (!usesPegboardHost) {
      setAssemblyMessage(`${assemblyHostPreset?.label ?? '当前宿主'}已进入预适配模式；该配件仍是洞洞板锚点，需要先标定对应的${assemblyHostPreset?.kind === 'rail-clip' ? '导轨卡扣' : assemblyHostPreset?.kind === 't-slot' ? '型材槽连接器' : '墙面底座'}。`)
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
      triggerSnapFeedback()
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
    if (spatialLayout.enabled) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    const rect = containerRef.current?.getBoundingClientRect()
    const data = dragDataRef.current
    const def = data && partDefsRef.current.find(part => part.id === data.defId)
    if (!rect || !def) return
    if (!usesPegboardHost) {
      if (dragModelRef.current) dragModelRef.current.visible = false
      const highlightGroup = sceneRef.current?.userData.snapHighlights as THREE.Group | undefined
      if (highlightGroup) clearSnapHighlights(highlightGroup)
      setDragPreview({
        x: e.clientX - rect.left + 12,
        y: e.clientY - rect.top + 12,
        valid: false,
        text: `${assemblyHostPreset?.label ?? '当前宿主'} · 需要兼容连接器`,
      })
      return
    }
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
    if (!textureMappingMode || viewPresetRef.current !== editSide) return null
    const point = pointOnAssemblyPlane(clientX, clientY, editSide)
    const mapping = sceneRef.current?.userData.textureMapping as { minX: number; maxX: number; minY: number; maxY: number; width: number; height: number } | undefined
    if (!point || !mapping || point.x < mapping.minX || point.x > mapping.maxX || point.y < mapping.minY || point.y > mapping.maxY) return null
    if (editSide === 'back') point.x = mapping.minX + mapping.maxX - point.x
    return { point, mapping }
  }

  const beginTextureMove = (e: React.PointerEvent<HTMLDivElement>): boolean => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return false
    const hit = texturePoint(e.clientX, e.clientY)
    if (!hit) return false
    const controls = sceneRef.current?.userData.controls as OrbitControls | undefined
    textureMoveRef.current = {
      pointerId: e.pointerId,
      startPoint: hit.point.clone(),
      originOffsetX: editingTexture.offsetX,
      originOffsetY: editingTexture.offsetY,
      deltaX: 0,
      deltaY: 0,
      controlsWasEnabled: controls?.enabled ?? true,
      ...(selectedEditableTextureLayer ? {
        layerId: selectedEditableTextureLayer.id,
        originXmm: selectedEditableTextureLayer.placement.transform.xMm,
        originYmm: selectedEditableTextureLayer.placement.transform.yMm,
      } : {}),
    }
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
    if (moving.layerId && selectedEditableTextureLayer && moving.originXmm !== undefined && moving.originYmm !== undefined) {
      const transform = {
        ...selectedEditableTextureLayer.placement.transform,
        xMm: moving.originXmm + moving.deltaX,
        yMm: moving.originYmm + moving.deltaY,
      }
      updateCompositionBoundsOverlay(sceneRef.current, transform)
      requestLayoutPreview(previewLayerTransform(moving.layerId, transform))
    } else {
      const draft = {
        ...editingTexture,
        offsetX: moving.originOffsetX + moving.deltaX / hit.mapping.width * 100,
        offsetY: moving.originOffsetY + moving.deltaY / hit.mapping.height * 100,
      }
      updateTextureBoundsOverlay(sceneRef.current, draft)
      requestLayoutPreview(draft)
    }
    e.preventDefault()
    return true
  }

  const finishTextureMove = (e: React.PointerEvent<HTMLDivElement>): boolean => {
    const moving = textureMoveRef.current
    if (!moving || moving.pointerId !== e.pointerId) return false
    textureMoveRef.current = null
    const mapping = sceneRef.current?.userData.textureMapping as { width: number; height: number } | undefined
    if (moving.layerId && moving.originXmm !== undefined && moving.originYmm !== undefined) {
      setEditingTexture({
        composition: {
          ...textureComposition,
          layers: textureComposition.layers.map(layer => {
            if (layer.id !== moving.layerId || layer.kind === 'panel-sequence' || (layer.placement.mode !== 'free' && layer.placement.mode !== 'repeat')) return layer
            return { ...layer, placement: { ...layer.placement, transform: { ...layer.placement.transform, xMm: moving.originXmm! + moving.deltaX, yMm: moving.originYmm! + moving.deltaY } } }
          }),
        },
      })
    } else if (mapping) setEditingTexture({
      offsetX: Math.max(-100, Math.min(100, moving.originOffsetX + moving.deltaX / mapping.width * 100)),
      offsetY: Math.max(-100, Math.min(100, moving.originOffsetY + moving.deltaY / mapping.height * 100)),
    })
    const controls = sceneRef.current?.userData.controls as OrbitControls | undefined
    if (controls) controls.enabled = moving.controlsWasEnabled
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    setTextureDragging(false)
    setAssemblyMessage('图片位置已更新 · 可继续拖动或用滚轮缩放')
    e.preventDefault()
    return true
  }

  const cancelTextureMove = (e: React.PointerEvent<HTMLDivElement>): boolean => {
    const moving = textureMoveRef.current
    if (!moving || moving.pointerId !== e.pointerId) return false
    textureMoveRef.current = null
    if (moving.layerId && selectedEditableTextureLayer) updateCompositionBoundsOverlay(sceneRef.current, selectedEditableTextureLayer.placement.transform)
    else updateTextureBoundsOverlay(sceneRef.current, editingTexture)
    requestLayoutPreview(editingTexture)
    const controls = sceneRef.current?.userData.controls as OrbitControls | undefined
    if (controls) controls.enabled = moving.controlsWasEnabled
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    setTextureDragging(false)
    setAssemblyMessage('已取消图片移动 · 视角控制已恢复')
    e.preventDefault()
    return true
  }

  const handleTextureWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (holeEditMode) return
    const hit = texturePoint(e.clientX, e.clientY)
    if (!hit) return
    e.preventDefault()
    e.stopPropagation()
    if (selectedEditableTextureLayer) {
      const current = textureWheelTransformRef.current ?? selectedEditableTextureLayer.placement.transform
      const factor = Math.max(0.5, Math.min(2, Math.exp(-e.deltaY * 0.0012)))
      const next = {
        ...current,
        widthMm: Math.max(5, Math.min(1_000_000, current.widthMm * factor)),
        heightMm: Math.max(5, Math.min(1_000_000, current.heightMm * factor)),
      }
      textureWheelTransformRef.current = next
      updateCompositionBoundsOverlay(sceneRef.current, next)
      requestLayoutPreview(previewLayerTransform(selectedEditableTextureLayer.id, next))
      if (textureWheelTimerRef.current !== null) window.clearTimeout(textureWheelTimerRef.current)
      textureWheelCommitRef.current = () => {
        setEditingTexture({
          composition: {
            ...textureComposition,
            layers: textureComposition.layers.map(layer => layer.id === selectedEditableTextureLayer.id && layer.kind === 'image' && (layer.placement.mode === 'free' || layer.placement.mode === 'repeat')
              ? { ...layer, placement: { ...layer.placement, transform: next } }
              : layer),
          },
        })
        textureWheelTransformRef.current = null
        textureWheelTimerRef.current = null
        textureWheelCommitRef.current = null
        setAssemblyMessage('图片图层缩放已更新')
      }
      textureWheelTimerRef.current = window.setTimeout(() => textureWheelCommitRef.current?.(), 150)
      return
    }
    const current = textureWheelScaleRef.current || editingTexture.scale
    const next = Math.max(20, Math.min(400, current * Math.exp(-e.deltaY * 0.0012)))
    textureWheelScaleRef.current = next
    updateTextureBoundsOverlay(sceneRef.current, { ...editingTexture, scale: next })
    requestLayoutPreview({ ...editingTexture, scale: next })
    if (textureWheelTimerRef.current !== null) window.clearTimeout(textureWheelTimerRef.current)
    textureWheelCommitRef.current = () => {
      // 保留当前临时纹理矩阵，直到 editingTexture 更新后的新纹理真正替换它。
      // 旧逻辑先把 repeat 重置为 1，再等待场景重建，会产生“缩小→弹回→再缩小”的闪跳。
      setEditingTexture({ scale: next })
      textureWheelTimerRef.current = null
      textureWheelCommitRef.current = null
      setAssemblyMessage(`图片缩放 ${Math.round(next)}%`)
    }
    textureWheelTimerRef.current = window.setTimeout(() => textureWheelCommitRef.current?.(), 150)
  }

  const handleAssemblyPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (holeEditMode) {
      panelClickStartRef.current = e.button === 0 && !(e.target as HTMLElement).closest('button')
        ? { x: e.clientX, y: e.clientY, button: e.button } : null
      return
    }
    if (sceneRef.current?.userData.latticeBuilding || sceneRef.current?.userData.latticeWipe) {
      panelClickStartRef.current = null
      return
    }
    if (spatialLayout.enabled) {
      panelClickStartRef.current = e.button === 0 && !(e.target as HTMLElement).closest('button')
        ? { x: e.clientX, y: e.clientY, button: e.button } : null
      return
    }
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
    triggerSnapFeedback()
    return true
  }

  /** 3D 中按屏幕投影命中圆形敲落孔; 通孔没有可射线命中的表面, 因此不能只 raycast 网格。 */
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene || !active || !holeEditMode || !selectedHole) return
    const marker = new THREE.Mesh(new THREE.RingGeometry(6, 7, 32),
      new THREE.MeshBasicMaterial({ color: 0xffdf82, side: THREE.DoubleSide, depthTest: false }))
    if (selectedHole.spatialFace) {
      const face = selectedHole.spatialFace
      marker.position.set(...faceToWorld(face, selectedHole.x, selectedHole.y, splitCfg.thickness / 2 + .2))
      marker.position.y += selectedHole.spatialOffsetY ?? 0
      const { u } = faceAxes(face, selectedHole.x)
      marker.rotation.y = -Math.atan2(u[2], u[0])
    } else {
      const panels = splitResult?.panels ?? []
      if (!panels.length) { marker.geometry.dispose(); marker.material.dispose(); return }
      const centerX = (Math.min(...panels.map(p => p.x)) + Math.max(...panels.map(p => p.x + p.w))) / 2
      const minY = Math.min(...panels.map(p => p.y))
      marker.position.set(selectedHole.x - centerX, selectedHole.y - minY, splitCfg.thickness + .2)
    }
    marker.renderOrder = 50; marker.userData.previewOnly = true
    scene.add(marker)
    return () => { scene.remove(marker); marker.geometry.dispose(); marker.material.dispose() }
  }, [active, holeEditMode, selectedHole, splitResult, splitCfg.thickness])

  const handlePanelPointerUp = (e: React.PointerEvent) => {
    const start = panelClickStartRef.current
    panelClickStartRef.current = null
    if (!start || start.button !== 0 || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 5) return
    if (spatialLayout.enabled) {
      const scene = sceneRef.current
      const camera = scene?.userData.camera as THREE.PerspectiveCamera | undefined
      const rect = containerRef.current?.getBoundingClientRect()
      if (!scene || !camera || !rect) return
      const targets = scene.userData.spatialHoleTargets as SpatialHoleTarget[] | undefined
      let best: { key: string; knocked: boolean; distance: number; depth: number; target: SpatialHoleTarget } | null = null
      for (const target of targets ?? []) {
        if (!holeEditMode && target.group !== 'edge_holes' && target.group !== 'closed_holes') continue
        const base = new THREE.Vector3(...faceToWorld(target.face, target.x, target.y))
        const normal = new THREE.Vector3(...faceAxes(target.face, target.x).normal)
        const side = camera.position.clone().sub(base).dot(normal) >= 0 ? 1 : -1
        const point = new THREE.Vector3(...faceToWorld(target.face, target.x, target.y,
          side * (splitCfg.thickness / 2 + 0.08)))
        const projected = point.clone().project(camera)
        if (projected.z < -1 || projected.z > 1) continue
        const isSlot = target.group === 'slots' || target.group === 'closed_holes' &&
          target.panel.closed_holes?.some(hole => hole.editOrigin?.group === 'slots' && Math.abs(hole.x - target.x) < .01 && Math.abs(hole.y - target.localY) < .01)
        const half = isSlot ? Math.max(0, (splitCfg.slotLength - splitCfg.slotWidth) / 2) : 0
        const radius = (isSlot ? splitCfg.slotWidth : splitCfg.jointDiameter) / 2
        const z = side * (splitCfg.thickness / 2 + .08)
        const { distance, limit } = projectedHoleHit(e, camera, rect, point,
          new THREE.Vector3(...faceToWorld(target.face, target.x, target.y - half, z)),
          new THREE.Vector3(...faceToWorld(target.face, target.x, target.y + half, z)),
          new THREE.Vector3(...faceToWorld(target.face, target.x + radius, target.y, z)))
        const depth = point.distanceTo(camera.position)
        if (distance <= limit && (!best || distance < best.distance - 0.5 ||
          (Math.abs(distance - best.distance) <= 0.5 && depth < best.depth))) {
          best = { key: spatialHoleKey(target.face.phaseU + target.x, target.y),
            knocked: target.knocked, distance, depth, target }
        }
      }
      if (best) {
        const state = useAppStore.getState()
        if (holeEditMode || best.target.group === 'closed_holes') {
          if (!holeEditMode) state.setHoleEditMode(true)
          state.selectHole({ panel: best.target.panel, x: best.target.x, y: best.target.localY,
            spatialKey: best.key, spatialFace: best.target.face, spatialOffsetY: best.target.offsetY })
        } else if (state.spatialLayout.holeTypeOverrides?.[best.key]) {
          state.selectHole({ panel: best.target.panel, x: best.target.x, y: best.target.localY, spatialKey: best.key })
          state.editSelectedHole(best.knocked ? 'closed' : 'round'); state.selectHole(null)
        } else state.setSpatialLayout({ holeOverrides: {
          ...state.spatialLayout.holeOverrides, [best.key]: !best.knocked,
        } })
        playHoleTapSound()
      }
      return
    }
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
      panelId: string; panelX: number; panelY: number; holeX: number; holeY: number; distance: number; panel: SplitPanel; group: HoleGroup
    } | null = null
    for (const panel of splitResult.panels) {
      for (const { hole, group } of panelHoleEntries(panel)) {
        if (!holeEditMode && group !== 'edge_holes' && group !== 'closed_holes') continue
        const onBoundary = Math.abs(hole.x - panel.x) < 0.5 || Math.abs(hole.x - (panel.x + panel.w)) < 0.5 ||
          Math.abs(hole.y - panel.y) < 0.5 || Math.abs(hole.y - (panel.y + panel.h)) < 0.5
        if (onBoundary && !holeEditMode) continue
        const point = new THREE.Vector3(
          hole.x - cx,
          hole.y - minY,
          viewPresetRef.current === 'back' ? -0.5 : splitCfg.thickness + 0.5,
        )
        const projected = point.clone().project(camera)
        if (projected.z < -1 || projected.z > 1) continue
        const isSlot = group === 'slots' || group === 'closed_holes' && hole.editOrigin?.group === 'slots'
        const half = isSlot ? Math.max(0, (splitCfg.slotLength - splitCfg.slotWidth) / 2) : 0
        const radius = (isSlot ? splitCfg.slotWidth : splitCfg.jointDiameter) / 2
        const { distance, limit } = projectedHoleHit(e, camera, rect, point,
          point.clone().add(new THREE.Vector3(0, -half, 0)), point.clone().add(new THREE.Vector3(0, half, 0)),
          point.clone().add(new THREE.Vector3(radius, 0, 0)))
        if (distance <= limit && (!best || distance < best.distance)) {
          best = {
            panelId: panel.id, panelX: panel.x, panelY: panel.y,
            holeX: hole.x, holeY: hole.y, distance, panel, group,
          }
        }
      }
    }
    if (best) {
      if (holeEditMode || best.group === 'closed_holes') {
        const state = useAppStore.getState()
        if (!holeEditMode) state.setHoleEditMode(true)
        state.selectHole({ panel: best.panel, x: best.holeX, y: best.holeY })
      } else toggleEdgeHole(best.panelId, best.panelX, best.panelY, best.holeX, best.holeY)
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

  const startDimensionDrag = (kind: SpatialDimension, e: React.PointerEvent<HTMLButtonElement>) => {
    const axis = spatialDimensionAxisRef.current[kind]
    const controls = sceneRef.current?.userData.controls as OrbitControls | undefined
    if (!axis || !controls || e.button !== 0) return
    dimensionDragRef.current = { kind, pointerId: e.pointerId,
      startX: e.clientX, startY: e.clientY, startValue: spatialLayout[kind],
      axis, current: spatialLayout[kind], controlsWasEnabled: controls.enabled }
    controls.enabled = false
    e.currentTarget.setPointerCapture(e.pointerId)
    e.preventDefault(); e.stopPropagation()
  }

  const moveDimensionDrag = (e: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dimensionDragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    const pixels = (e.clientX - drag.startX) * drag.axis.dx + (e.clientY - drag.startY) * drag.axis.dy
    drag.current = Math.round(Math.max(25, Math.min(5000,
      drag.startValue + pixels / drag.axis.pxPerMm)) * 10) / 10
    setDimensionDraft({ kind: drag.kind, value: drag.current })
    e.preventDefault(); e.stopPropagation()
  }

  const finishDimensionDrag = (e: React.PointerEvent<HTMLButtonElement>, cancel = false) => {
    const drag = dimensionDragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    dimensionDragRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    const controls = sceneRef.current?.userData.controls as OrbitControls | undefined
    if (controls) controls.enabled = drag.controlsWasEnabled
    setDimensionDraft(null)
    if (!cancel && Math.abs(drag.current - drag.startValue) >= 0.1) {
      useAppStore.getState().setSpatialLayout({ [drag.kind]: drag.current })
    }
    e.stopPropagation()
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
      camera.up.set(0,1,0)
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
        object.visible = !boardTexture.backEnabled && preset !== 'back'
      }
      if (object.name === 'back-seam-guides') object.visible = preset === 'back' && !textureStudioOpen
    })
    controls.update()
    viewPresetRef.current = preset
    setViewPreset(preset)
    setAssemblyMessage(preset === 'front'
      ? textureStudioOpen ? '正在编辑正面映射 · 导入和参数只修改正面。' : '已锁定正面 · 当前用于安装配件。'
      : preset === 'back'
        ? textureStudioOpen ? '正在编辑背面映射 · 导入和参数只修改背面。' : '已锁定背面 · 当前用于安装固定件。'
        : '已恢复自由视角 · 可旋转检查整体装配。')
  }

  useEffect(() => {
    const handleExternalViewPreset = (event: Event) => {
      const preset = (event as CustomEvent<{ preset?: ViewPreset }>).detail?.preset
      if (preset === 'front' || preset === 'back' || preset === 'free') selectViewPreset(preset)
    }
    window.addEventListener('snapboard:set-view-preset', handleExternalViewPreset)
    return () => window.removeEventListener('snapboard:set-view-preset', handleExternalViewPreset)
  })

  // 纹理正视辅助是一段有边界的临时相机会话：只在打开上升沿保存一次，
  // 连续调色、图片缩放和板件重建都不会覆盖进入前快照；关闭下降沿精确恢复。
  useEffect(() => {
    const wasOpen = textureStudioWasOpenRef.current
    textureStudioWasOpenRef.current = textureStudioOpen
    const scene = sceneRef.current
    const camera = scene?.userData.camera as THREE.PerspectiveCamera | undefined
    const controls = scene?.userData.controls as OrbitControls | undefined
    if (!scene || !camera || !controls) return

    // StrictMode 会重放挂载 effect 并重建 Three.js 场景。若 scene 已更换，即使开关
    // 仍为 true 也要为新相机重新建立会话，不能沿用已销毁场景的快照。
    if (textureStudioOpen && (!wasOpen || textureViewSessionRef.current?.scene !== scene)) {
      if (!textureViewSessionRef.current || textureViewSessionRef.current.scene !== scene) {
        textureViewSessionRef.current = {
          scene,
          preset: viewPresetRef.current,
          position: camera.position.clone(),
          quaternion: camera.quaternion.clone(),
          up: camera.up.clone(),
          zoom: camera.zoom,
          target: controls.target.clone(),
          controlsEnabled: controls.enabled,
          enableRotate: controls.enableRotate,
          enablePan: controls.enablePan,
          enableZoom: controls.enableZoom,
          mouseButtons: { ...controls.mouseButtons },
          touches: { ...controls.touches },
        }
      }
      selectViewPreset(editSide)
      setAssemblyMessage('纹理正视辅助已开启 · 旋转已锁定，可平移、缩放和拖动图片。')
      return
    }

    if (!textureStudioOpen && wasOpen) {
      const moving = textureMoveRef.current
      if (moving) {
        textureMoveRef.current = null
        if (moving.layerId && selectedEditableTextureLayer) updateCompositionBoundsOverlay(scene, selectedEditableTextureLayer.placement.transform)
        else updateTextureBoundsOverlay(scene, boardTexture)
        const container = containerRef.current
        if (container?.hasPointerCapture(moving.pointerId)) container.releasePointerCapture(moving.pointerId)
        setTextureDragging(false)
      }
      const snapshot = textureViewSessionRef.current
      textureViewSessionRef.current = null
      if (!snapshot) return
      camera.position.copy(snapshot.position)
      camera.quaternion.copy(snapshot.quaternion)
      camera.up.copy(snapshot.up)
      camera.zoom = snapshot.zoom
      camera.updateProjectionMatrix()
      controls.target.copy(snapshot.target)
      controls.enabled = snapshot.controlsEnabled
      controls.enableRotate = snapshot.enableRotate
      controls.enablePan = snapshot.enablePan
      controls.enableZoom = snapshot.enableZoom
      Object.assign(controls.mouseButtons, snapshot.mouseButtons)
      Object.assign(controls.touches, snapshot.touches)
      scene.traverse(object => {
        if ((object as THREE.Sprite).isSprite && object.name.startsWith('split-panel-')) {
          object.visible = !boardTexture.backEnabled && snapshot.preset !== 'back'
        }
        if (object.name === 'back-seam-guides') object.visible = snapshot.preset === 'back'
      })
      controls.update()
      viewPresetRef.current = snapshot.preset
      setViewPreset(snapshot.preset)
      setAssemblyMessage('已退出纹理正视辅助 · 已恢复进入前视角。')
    }
    // selectViewPreset 和 boardTexture 保持当前渲染闭包；边沿判定只应由开关驱动。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textureStudioOpen])

  useEffect(() => {
    if (textureWheelTimerRef.current !== null) window.clearTimeout(textureWheelTimerRef.current)
    textureWheelCommitRef.current?.()
    textureWheelScaleRef.current = editingTexture.scale
    textureDraftRef.current = null
    if (textureDraftFrameRef.current !== null) window.cancelAnimationFrame(textureDraftFrameRef.current)
    textureDraftFrameRef.current = null
    const moving = textureMoveRef.current
    if (moving) {
      textureMoveRef.current = null
      const controls = sceneRef.current?.userData.controls as OrbitControls | undefined
      if (controls) controls.enabled = moving.controlsWasEnabled
      if (containerRef.current?.hasPointerCapture(moving.pointerId)) containerRef.current.releasePointerCapture(moving.pointerId)
      setTextureDragging(false)
    }
    if (textureStudioOpen) selectViewPreset(editSide)
    // Keep the saved entering view; only change the currently edited face.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editSide, textureStudioOpen])

  const resizeSelectedTextureLayer = (factor: number) => {
    if (!selectedEditableTextureLayer) {
      setEditingTexture({ scale: Math.max(20, Math.min(400, editingTexture.scale * factor)) })
      return
    }
    const transform = selectedEditableTextureLayer.placement.transform
    setEditingTexture({
      composition: {
        ...textureComposition,
        layers: textureComposition.layers.map(layer => layer.id === selectedEditableTextureLayer.id && layer.kind === 'image' && (layer.placement.mode === 'free' || layer.placement.mode === 'repeat')
          ? { ...layer, placement: { ...layer.placement, transform: { ...transform, widthMm: Math.max(5, Math.min(1_000_000, transform.widthMm * factor)), heightMm: Math.max(5, Math.min(1_000_000, transform.heightMm * factor)) } } }
          : layer),
      },
    })
  }

  const centerSelectedTextureLayer = () => {
    if (!selectedEditableTextureLayer || !splitResult?.panels.length) {
      setEditingTexture({ offsetX: 0, offsetY: 0, scale: 100, rotation: 0 })
      return
    }
    const bounds = getSplitPanelTextureBounds(splitResult.panels)
    const transform = selectedEditableTextureLayer.placement.transform
    setEditingTexture({
      composition: {
        ...textureComposition,
        layers: textureComposition.layers.map(layer => layer.id === selectedEditableTextureLayer.id && layer.kind === 'image' && (layer.placement.mode === 'free' || layer.placement.mode === 'repeat')
          ? { ...layer, placement: { ...layer.placement, transform: { ...transform, xMm: bounds.minX + bounds.width / 2, yMm: bounds.minY + bounds.height / 2, rotationDeg: 0 } } }
          : layer),
      },
    })
  }

  const partsWorkspace = useAppStore(s=>s.ui.partsOpen)
  const [propertyHost,setPropertyHost] = useState<HTMLElement|null>(null)
  useEffect(()=>{setPropertyHost(partsWorkspace?document.getElementById('workbench-properties'):null)},[partsWorkspace,selectedPartId])
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
    const fit = fitPartAnchors(anchorsForSide(mount.anchors, side), targets, pivot, 8, 4, desired, occupiedTargetIds(selectedPart.id), contactZForSide(mount.contactZ, side), mount.slideY ?? 0)
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
    triggerSnapFeedback()
    const applied = THREE.MathUtils.radToDeg(fit.rotationZ)
    setAssemblyMessage(`已手动旋转到 ${Math.round(applied * 10) / 10}°，并重新校验 ${fit.targets.length} 个吸附孔。`)
  }

  return (
    <div
      ref={containerRef}
      className={`viewport3d${textureMappingMode ? ' texture-mapping-mode' : ''}${textureDragging ? ' is-moving-texture' : ''}${snapFeedback ? ' snap-feedback' : ''}`}
      style={{ width: '100%', height: '100%', position: 'relative' }}
      onPointerDownCapture={handleAssemblyPointerDown}
      onPointerMoveCapture={handleAssemblyPointerMove}
      onPointerUpCapture={handleViewportPointerUp}
      onPointerCancelCapture={cancelTextureMove}
      onLostPointerCapture={cancelTextureMove}
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
        {structureOpen && !spatialLayout.enabled && splitResult?.panels.some(p => p.latticeCutouts?.length || p.latticeFace) &&
          <button type="button" className="lattice-replay-button" disabled={Boolean(lattice3DStatus)}
            onClick={() => { void sceneRef.current?.userData.replayLattice?.() }}
            title="重播已完成模型的破碎转场，无需重新计算镂空">✦ 重播特效</button>}
        <button className={viewPreset === 'front' ? 'on' : ''} onClick={() => { if (textureStudioOpen && boardTexture.backEnabled) setUI({ textureEditSide: 'front' }); selectViewPreset('front') }} aria-label="正面视角">正面</button>
        <button className={viewPreset === 'back' ? 'on' : ''} onClick={() => { if (textureStudioOpen && boardTexture.backEnabled) setUI({ textureEditSide: 'back' }); selectViewPreset('back') }} aria-label="背面视角">背面</button>
        <button className={viewPreset === 'free' ? 'on' : ''} onClick={() => selectViewPreset('free')} aria-label="自由视角">自由</button>
      </div>
      {spatialLayout.enabled && spatialLayout.template === 'L' && (['width', 'depth'] as const).map(kind =>
        <button key={kind} type="button" className="spatial-dimension-handle"
          ref={element => { spatialDimensionRefs.current[kind] = element }}
          aria-label={`拖动调整${kind === 'width' ? '主宽' : '侧深'}，方向键按孔阵步进`}
          title={`沿对应边拖动调整${kind === 'width' ? '主宽' : '侧深'}，释放后修齐拼接边；方向键按孔阵步进`}
          onPointerDown={event => startDimensionDrag(kind, event)}
          onPointerMove={moveDimensionDrag}
          onPointerUp={event => finishDimensionDrag(event)}
          onPointerCancel={event => finishDimensionDrag(event, true)}
          onLostPointerCapture={event => finishDimensionDrag(event, true)}
          onKeyDown={event => {
            const step = splitCfg.slotStaggerX === splitCfg.mx / 2 ? splitCfg.mx / 2 : splitCfg.mx
            const delta = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? step
              : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -step : 0
            if (!delta) return
            useAppStore.getState().setSpatialLayout({ [kind]: Math.max(25, Math.min(5000, spatialLayout[kind] + delta)) })
            event.preventDefault(); event.stopPropagation()
          }}>
          <span className="spatial-dimension-arrow">↔</span>
          <strong>{kind === 'width' ? '主宽' : '侧深'} {dimensionDraft?.kind === kind ? dimensionDraft.value : spatialLayout[kind]} mm</strong>
        </button>)}
      {textureMappingMode && (
        <div className="texture-map-hud">
          <span><b>{editSide === 'back' ? '背面' : '正面'}图片定位{viewPreset === editSide ? ' · 正视锁定' : ' · 仅预览'}</b><small>{viewPreset === editSide ? '虚线框=图层范围 · 板面拖动 · 滚轮缩放' : '切换到当前面的正视图后可拖动图片'}</small></span>
          <div>
            <button onClick={() => resizeSelectedTextureLayer(0.9)} title="缩小图片">−</button>
            <strong>{selectedEditableTextureLayer ? `${Math.round(selectedEditableTextureLayer.placement.transform.widthMm)}mm` : `${Math.round(editingTexture.scale)}%`}</strong>
            <button onClick={() => resizeSelectedTextureLayer(1.1)} title="放大图片">＋</button>
            <button onClick={centerSelectedTextureLayer} title="图片居中并恢复角度">居中</button>
            <button onClick={() => selectViewPreset(editSide)} title="切换到当前面的正视图">{viewPreset === editSide ? '🔒 正视' : '正视'}</button>
          </div>
        </div>
      )}
      {selectedPart && partsWorkspace && (propertyHost ? createPortal(
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
, propertyHost) : (
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
))}
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
      {usesPegboardHost && splitResult && splitResult.panels.length > 0 && (
        <div style={{
          position: 'absolute', left: 12, bottom: 12, padding: '5px 9px',
          color: 'rgba(255,255,255,0.72)', background: 'rgba(20,22,36,0.72)',
          borderRadius: 4, fontSize: 11, pointerEvents: 'none',
        }}>
          {textureStudioOpen ? `当前${editSide === 'back' ? '背面' : '正面'}映射 · 导入与参数跟随当前面 · 拖动图片，滚轮缩放` : viewPreset === 'back'
            ? '黄色高亮 = 板件接缝 · 沿接缝两侧同号箭头安装紧固件'
            : '单击虚线圆：切换为贯通孔 · 再次单击恢复完整板面 · 拖入配件：实时预览'}
        </div>
      )}
      {!usesPegboardHost && assemblyHostPreset && (
        <div className="mount-host-hud">
          <span>{assemblyHostPreset.kind === 'rail-clip' ? '═' : assemblyHostPreset.kind === 't-slot' ? '▰' : '▧'}</span>
          <div><b>{assemblyHostPreset.label}</b><small>{assemblyHostPreset.summary}</small></div>
          <em>{assemblyHostPreset.status === 'experimental' ? '实验适配' : '求解预适配'}</em>
        </div>
      )}
      {lattice3DStatus && !lattice3DStatus.startsWith('斜向光谱') && <div className="lattice3d-progress" role="status">
        <span className="lattice3d-progress-mark" aria-hidden="true" />{lattice3DStatus}
      </div>}
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
  worldMinX?: number
  worldMinY?: number
}

interface TextureOverlayFrame { width: number; height: number; x: number; y: number; rotation: number }

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

function createTextureBoundsOverlay(config: BoardTextureConfig, mapping: TextureMappingBounds, z: number, compositionTransform?: TextureCompositionTransform, viewedFromBack = false): THREE.LineLoop {
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
  line.userData.viewedFromBack = viewedFromBack
  if (compositionTransform) {
    line.userData.compositionLayer = true
    updateTextureFrameGeometry(line, textureCompositionFrame(compositionTransform, mapping))
  } else updateTextureBoundsGeometry(line, config)
  return line
}

function textureCompositionFrame(transform: TextureCompositionTransform, mapping: TextureMappingBounds): TextureOverlayFrame {
  return {
    width: transform.widthMm,
    height: transform.heightMm,
    x: mapping.minX + transform.xMm - (mapping.worldMinX ?? 0),
    y: mapping.minY + transform.yMm - (mapping.worldMinY ?? 0),
    rotation: THREE.MathUtils.degToRad(transform.rotationDeg),
  }
}

function updateTextureFrameGeometry(line: THREE.LineLoop, frame: TextureOverlayFrame): void {
  const hw = frame.width / 2
  const hh = frame.height / 2
  line.geometry.dispose()
  line.geometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-hw, -hh, 0), new THREE.Vector3(hw, -hh, 0),
    new THREE.Vector3(hw, hh, 0), new THREE.Vector3(-hw, hh, 0),
  ])
  const mapping = line.userData.mapping as TextureMappingBounds
  line.position.x = line.userData.viewedFromBack ? mapping.minX + mapping.maxX - frame.x : frame.x
  line.position.y = frame.y
  line.rotation.z = line.userData.viewedFromBack ? -frame.rotation : frame.rotation
  line.computeLineDistances()
}

function updateTextureBoundsGeometry(line: THREE.LineLoop, config: BoardTextureConfig): void {
  const mapping = line.userData.mapping as TextureMappingBounds | undefined
  if (!mapping) return
  const frame = textureImageFrame(config, mapping)
  updateTextureFrameGeometry(line, frame)
}

function updateTextureBoundsOverlay(scene: THREE.Scene | null, config: BoardTextureConfig): void {
  const line = scene?.userData.textureBoundsOverlay as THREE.LineLoop | undefined
  if (line) updateTextureBoundsGeometry(line, config)
}

function updateCompositionBoundsOverlay(scene: THREE.Scene | null, transform: TextureCompositionTransform): void {
  const line = scene?.userData.textureBoundsOverlay as THREE.LineLoop | undefined
  const mapping = line?.userData.mapping as TextureMappingBounds | undefined
  if (line && mapping) updateTextureFrameGeometry(line, textureCompositionFrame(transform, mapping))
}

/** 从场景中找到相机 (存储在 userData) */
function findCamera(scene: THREE.Scene): THREE.Camera | null {
  // 未设置场景相机时返回 null，由调用方处理。
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
