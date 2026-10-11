/** “重画”事务只依赖的最小 UI 字段。 */
export interface RedrawUiShape {
  selectedFeatureId: string | null
  selectedContourId: string | null
  selectedConstraintId: string | null
  selectedPartId: string | null
  textureStudioOpen: boolean
  structureOpen?: boolean
  occlusionAnalysisOpen: boolean
}

/** 装配场景中会依附旧板坐标系的字段；定义和宿主预设不在此列。 */
export interface RedrawAssemblyShape<THost = unknown, TPlacement = unknown> {
  hostInstances: THost[]
  placements: TPlacement[]
}

export interface RedrawStateShape<
  TBoard = unknown,
  TPart = unknown,
  TTexture = unknown,
  TAssembly extends RedrawAssemblyShape = RedrawAssemblyShape,
  TSplit = unknown,
  TUi extends RedrawUiShape = RedrawUiShape,
> {
  boards: TBoard[]
  placedParts: TPart[]
  boardTexture: TTexture
  assemblyScene: TAssembly
  splitResult: TSplit | null
  occlusionOverlayEnabled: boolean
  ui: TUi
}

export interface RedrawWorkspaceSnapshot<
  TContour = unknown,
  TBoard = unknown,
  TPart = unknown,
  TTexture = unknown,
  TAssembly extends RedrawAssemblyShape = RedrawAssemblyShape,
  TSplit = unknown,
> {
  contours: TContour[]
  boards: TBoard[]
  placedParts: TPart[]
  boardTexture: TTexture
  assemblyScene: TAssembly
  splitResult: TSplit | null
  occlusionOverlayEnabled: boolean
  ui: RedrawUiShape
}

/** 捕获一次撤销需要恢复的全部上游几何和旧板派生状态。 */
export function captureRedrawSnapshot<
  TContour,
  TBoard,
  TPart,
  TTexture,
  TAssembly extends RedrawAssemblyShape,
  TSplit,
  TUi extends RedrawUiShape,
>(
  state: RedrawStateShape<TBoard, TPart, TTexture, TAssembly, TSplit, TUi>,
  contours: TContour[],
): RedrawWorkspaceSnapshot<TContour, TBoard, TPart, TTexture, TAssembly, TSplit> {
  return {
    contours,
    boards: state.boards,
    placedParts: state.placedParts,
    boardTexture: state.boardTexture,
    assemblyScene: state.assemblyScene,
    splitResult: state.splitResult,
    occlusionOverlayEnabled: state.occlusionOverlayEnabled,
    ui: {
      selectedFeatureId: state.ui.selectedFeatureId,
      selectedContourId: state.ui.selectedContourId,
      selectedConstraintId: state.ui.selectedConstraintId,
      selectedPartId: state.ui.selectedPartId,
      textureStudioOpen: state.ui.textureStudioOpen,
      structureOpen: state.ui.structureOpen,
      occlusionAnalysisOpen: state.ui.occlusionAnalysisOpen,
    },
  }
}

/**
 * 生成重画后的状态补丁。调用方负责把 current UI/assembly 的其他全局配置展开
 * 进来，因此打印参数、资源定义、宿主预设、遮挡目标模式和工具偏好不会丢失。
 */
export function createClearedRedrawPatch<
  TTexture,
  TAssembly extends RedrawAssemblyShape,
  TUi extends RedrawUiShape,
>(state: { assemblyScene: TAssembly; ui: TUi }, defaultBoardTexture: TTexture) {
  return {
    boards: [],
    placedParts: [],
    boardTexture: defaultBoardTexture,
    assemblyScene: {
      ...state.assemblyScene,
      hostInstances: [],
      placements: [],
    },
    splitResult: null,
    splitJob: null,
    occlusionOverlayEnabled: false,
    ui: {
      ...state.ui,
      selectedFeatureId: null,
      selectedContourId: null,
      selectedConstraintId: null,
      selectedPartId: null,
      textureStudioOpen: false,
      structureOpen: false,
      occlusionAnalysisOpen: false,
    },
  }
}

/** 生成单次撤销的恢复补丁；进行中的旧 Worker 不会恢复。 */
export function createRestoredRedrawPatch<
  TContour,
  TBoard,
  TPart,
  TTexture,
  TAssembly extends RedrawAssemblyShape,
  TSplit,
  TUi extends RedrawUiShape,
>(
  state: { ui: TUi },
  snapshot: RedrawWorkspaceSnapshot<TContour, TBoard, TPart, TTexture, TAssembly, TSplit>,
) {
  return {
    boards: snapshot.boards,
    placedParts: snapshot.placedParts,
    boardTexture: snapshot.boardTexture,
    assemblyScene: snapshot.assemblyScene,
    splitResult: snapshot.splitResult,
    splitJob: null,
    occlusionOverlayEnabled: snapshot.occlusionOverlayEnabled,
    ui: { ...state.ui, ...snapshot.ui },
  }
}
