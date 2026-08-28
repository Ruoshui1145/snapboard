// ============ 左侧栏 (属性栏): 项目信息 + 特征树 + 属性面板(按图形类型) + 约束 ============
// 分割引擎与配件库已移到右侧栏 (RightSidebar), 本栏专注"选中对象的详细属性"
import { useAppStore } from '../../store/useAppStore'
import { RemoveConstraintCommand, UpdateConstraintCommand, UpdateContourPointsCommand } from '../../commands/SketchCommands'
import { standaloneArc } from '../../utils/entities'
import { arcSpan } from '../../utils/arc'
import type { ConstraintType, Contour, Feature, Point2D } from '../../types/geometry'

const CONS_ICONS: Record<ConstraintType, string> = {
  length: '↔', distance: '↔', angle: '∠', diameter: '⌀', radius: 'R', arcLength: '⌒',
  horizontal: '—', vertical: '│', parallel: '∥', perpendicular: '⊥', equal: '＝',
}

export function Sidebar() {
  const project = useAppStore(s => s.project)
  const ui = useAppStore(s => s.ui)
  const setUI = useAppStore(s => s.setUI)
  const mm = project.config.pixelToMM

  // 当前选中的轮廓 (供属性面板/约束面板)
  const selectedContour: Contour | undefined = project.parts
    .flatMap(p => p.features)
    .filter((f): f is Extract<Feature, { type: 'sketch' }> => f.type === 'sketch')
    .flatMap(f => f.contours)
    .find(c => c.id === ui.selectedContourId)

  const fmt = (v: number) => (v * mm).toFixed(1)
  /** 坐标显示 (mm, Y 向上 — 与画布左下原点标志一致) */
  const coord = (p: Point2D) => `(${fmt(p.x)}, ${(-p.y * mm).toFixed(1)})`

  /** 属性补丁 (命令式可撤销) */
  const patchContour = (patch: Partial<Contour>) => {
    if (!selectedContour) return
    useAppStore.getState().execute(new UpdateContourPointsCommand(
      selectedContour.id, selectedContour.points, selectedContour.points, patch,
    ))
  }

  /** 多边形旋转角应用 (保持半径重新生成顶点) */
  const applyRotation = (degRaw: number) => {
    if (!selectedContour || selectedContour.shape !== 'polygon' || !selectedContour.center) return
    const c = selectedContour
    const deg = ((degRaw % 360) + 360) % 360
    if (Math.abs(deg - (c.rotation ?? 0)) < 0.05) return
    const n = c.points.length
    const r = c.radius ?? Math.hypot(c.points[0].x - c.center!.x, c.points[0].y - c.center!.y)
    const circ = c.polygonCircumscribed === true
    const angle0 = (deg * Math.PI) / 180
    const rOut = circ ? r / Math.cos(Math.PI / n) : r
    const newPts = Array.from({ length: n }, (_, i) => {
      const a = angle0 + (2 * Math.PI * i) / n
      return { x: c.center!.x + rOut * Math.cos(a), y: c.center!.y + rOut * Math.sin(a) }
    })
    useAppStore.getState().execute(new UpdateContourPointsCommand(c.id, c.points, newPts, { rotation: deg }))
    const radCons = c.constraints.find(x => x.type === 'radius')
    if (radCons) {
      useAppStore.getState().execute(new UpdateConstraintCommand(c.id, radCons.id, {
        labelPos: { x: c.center!.x + (r / 2) * Math.cos(angle0), y: c.center!.y + (r / 2) * Math.sin(angle0) },
      }))
    }
  }

  // 是否可无限延长 (2 点开放直线)
  const canInfinite = !!selectedContour
    && !selectedContour.closed
    && selectedContour.points.length === 2
    && (selectedContour.arcs?.length ?? 0) === 0
    && selectedContour.shape === undefined

  const arc = selectedContour ? standaloneArc(selectedContour) : null

  // 矩形判定 (4 点闭合正交)
  const isRect = !!selectedContour && selectedContour.closed && selectedContour.points.length === 4
    && selectedContour.shape === undefined && selectedContour.slotWidth === undefined
    && (selectedContour.arcs?.length ?? 0) === 0
    && selectedContour.points.every((p, i) => {
      const q = selectedContour.points[(i + 1) % 4]
      return Math.min(Math.abs(q.x - p.x), Math.abs(q.y - p.y)) < 1
    })

  // 折线总长 (直线/开放/闭合折线)
  const totalLen = selectedContour && !selectedContour.shape && selectedContour.slotWidth === undefined && !arc
    ? (() => {
        let sum = 0
        const pts = selectedContour.points
        const total = selectedContour.closed ? pts.length : pts.length - 1
        for (let i = 0; i < total; i++) {
          const a = pts[i], b = pts[(i + 1) % pts.length]
          sum += Math.hypot(b.x - a.x, b.y - a.y)
        }
        return sum
      })()
    : null

  // 矩形宽高与中心
  const rectW = isRect && selectedContour
    ? Math.max(Math.abs(selectedContour.points[1].x - selectedContour.points[0].x), Math.abs(selectedContour.points[3].x - selectedContour.points[0].x))
    : null
  const rectH = isRect && selectedContour
    ? Math.max(Math.abs(selectedContour.points[3].y - selectedContour.points[0].y), Math.abs(selectedContour.points[2].y - selectedContour.points[1].y))
    : null
  const rectCenter = isRect && selectedContour
    ? {
        x: (Math.min(...selectedContour.points.map(p => p.x)) + Math.max(...selectedContour.points.map(p => p.x))) / 2,
        y: (Math.min(...selectedContour.points.map(p => p.y)) + Math.max(...selectedContour.points.map(p => p.y))) / 2,
      }
    : null

  const slotLen = selectedContour && selectedContour.slotWidth !== undefined && selectedContour.points.length >= 2
    ? Math.hypot(selectedContour.points[1].x - selectedContour.points[0].x, selectedContour.points[1].y - selectedContour.points[0].y)
    : null
  const slotCenter = selectedContour && selectedContour.slotWidth !== undefined && selectedContour.points.length >= 2
    ? { x: (selectedContour.points[0].x + selectedContour.points[1].x) / 2, y: (selectedContour.points[0].y + selectedContour.points[1].y) / 2 }
    : null

  // 多边形边长 (参考半径 r 与模式)
  const polySide = selectedContour && selectedContour.shape === 'polygon' && selectedContour.radius !== undefined
    ? (() => {
        const n = selectedContour.points.length
        const rOut = selectedContour.polygonCircumscribed
          ? selectedContour.radius / Math.cos(Math.PI / n)
          : selectedContour.radius
        return 2 * rOut * Math.sin(Math.PI / n)
      })()
    : null

  return (
    <div className="sb">
      {/* 项目信息 */}
      <div className="sb-section">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 16 }}>📦</span>
          <div>
            <div style={{ fontSize: 13, color: 'var(--text)' }}>{project.metadata.name}</div>
            <div style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>v{project.metadata.version} · 像素比 {project.config.pixelToMM} mm/px</div>
          </div>
        </div>
      </div>

      {/* 特征树 */}
      <div className="sb-section">
        <h4 className="sb-title">特征</h4>
        {project.parts.flatMap(p => p.features).length === 0 && (
          <div className="sb-empty">暂无特征。切换到 2D 草图模式开始绘制。</div>
        )}
        {project.parts.flatMap(p => p.features).map(f => (
          <div
            key={f.id}
            className={'sb-row' + (ui.selectedFeatureId === f.id ? ' active' : '')}
            onClick={() => setUI({ selectedFeatureId: f.id, activeSketchId: f.type === 'sketch' ? f.id : ui.activeSketchId })}
          >
            <span>{f.type === 'sketch' ? '📐' : f.type === 'extrude' ? '🧊' : f.type === 'hole' ? '🕳' : '🔲'} {f.name}</span>
            {f.type === 'sketch' && (
              <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                {f.contours.length} 轮廓 · {f.contours.reduce((n, c) => n + c.constraints.length, 0)} 约束
              </span>
            )}
          </div>
        ))}
      </div>

      {/* 属性面板 (选中轮廓, 按图形类型显示) */}
      <div className="sb-section">
        <h4 className="sb-title">属性 (选中轮廓)</h4>
        {selectedContour ? (
          <div style={{ animation: 'fadeIn 0.15s ease' }}>
            <div style={{ fontSize: 12, marginBottom: 6, color: 'var(--text)' }}>
              {selectedContour.construction ? '📏 辅助线'
                : selectedContour.shape === 'circle' ? '◯ 圆'
                : selectedContour.shape === 'polygon' ? '⬡ 多边形'
                : selectedContour.slotWidth !== undefined ? '💊 槽口'
                : arc ? '◠ 圆弧'
                : '▭ ' + (selectedContour.closed ? '闭合' : '开放') + '折线'}
              <span style={{ color: 'var(--text-dim)', fontSize: 10.5 }}> · {selectedContour.points.length} 点</span>
            </div>

            {/* 内外轮廓 */}
            <div className="prop-item">
              <span className="plabel">轮廓类型</span>
              <div className="tb-seg">
                <button
                  className={selectedContour.type === 'outer' ? 'on' : ''}
                  disabled={selectedContour.construction}
                  onClick={() => patchContour({ type: 'outer' })}
                >外轮廓</button>
                <button
                  className={selectedContour.type === 'inner' ? 'on' : ''}
                  disabled={selectedContour.construction}
                  onClick={() => patchContour({ type: 'inner' })}
                >内轮廓(开孔)</button>
              </div>
            </div>

            {/* 构造线 */}
            <div className="prop-item">
              <span className="plabel">构造线 (虚线)</span>
              <div
                className={'prop-switch' + (selectedContour.construction ? ' on' : '')}
                title="构造线不参与板子轮廓, 仅作辅助基准"
                onClick={() => patchContour({
                  construction: !selectedContour.construction,
                  infinite: selectedContour.construction ? false : selectedContour.infinite,
                })}
              >
                <div className="knob" />
              </div>
            </div>

            {/* 无限长度 */}
            <div className="prop-item" style={{ opacity: canInfinite ? 1 : 0.45 }}>
              <span className="plabel">无限长度</span>
              <div
                className={'prop-switch' + (selectedContour.infinite ? ' on' : '')}
                title={canInfinite ? '像 SolidWorks 中心线一样无限延长' : '仅直线(2点开放)支持'}
                onClick={() => canInfinite && patchContour({ infinite: !selectedContour.infinite })}
              >
                <div className="knob" />
              </div>
            </div>

            {/* 圆: 半径 + 圆心坐标 */}
            {selectedContour.shape === 'circle' && selectedContour.radius !== undefined && (
              <>
                <div className="prop-item">
                  <span className="plabel">半径 R</span>
                  <span className="prop-val">{fmt(selectedContour.radius)} mm</span>
                </div>
                {selectedContour.center && (
                  <div className="prop-item">
                    <span className="plabel">圆心坐标</span>
                    <span className="prop-val">{coord(selectedContour.center)} mm</span>
                  </div>
                )}
              </>
            )}

            {/* 槽口: 长/宽/R + 中心 */}
            {selectedContour.slotWidth !== undefined && (
              <>
                {slotLen !== null && (
                  <div className="prop-item">
                    <span className="plabel">长度</span>
                    <span className="prop-val">{fmt(slotLen)} mm</span>
                  </div>
                )}
                <div className="prop-item">
                  <span className="plabel">宽度</span>
                  <span className="prop-val">{fmt(selectedContour.slotWidth)} mm</span>
                </div>
                <div className="prop-item">
                  <span className="plabel">端部 R</span>
                  <span className="prop-val">R {fmt(selectedContour.slotWidth / 2)} mm</span>
                </div>
                {slotCenter && (
                  <div className="prop-item">
                    <span className="plabel">中心坐标</span>
                    <span className="prop-val">{coord(slotCenter)} mm</span>
                  </div>
                )}
              </>
            )}

            {/* 多边形: 边数/旋转/R/边长/中心 */}
            {selectedContour.shape === 'polygon' && (
              <>
                <div className="prop-item">
                  <span className="plabel">边数</span>
                  <span className="prop-val">{selectedContour.points.length} 边</span>
                </div>
                <div className="prop-item">
                  <span className="plabel">旋转角度</span>
                  <input
                    className="prop-num"
                    key={selectedContour.id}
                    type="number"
                    step={5}
                    defaultValue={selectedContour.rotation ?? 0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        applyRotation(Number((e.target as HTMLInputElement).value))
                        ;(e.target as HTMLInputElement).blur()
                      }
                    }}
                    onBlur={(e) => {
                      const v = Number(e.target.value)
                      if (Number.isFinite(v)) applyRotation(v)
                    }}
                  />
                </div>
                {selectedContour.radius !== undefined && (
                  <div className="prop-item">
                    <span className="plabel">参考半径 R</span>
                    <span className="prop-val">{fmt(selectedContour.radius)} mm</span>
                  </div>
                )}
                {polySide !== null && (
                  <div className="prop-item">
                    <span className="plabel">边长</span>
                    <span className="prop-val">{fmt(polySide)} mm</span>
                  </div>
                )}
                {selectedContour.center && (
                  <div className="prop-item">
                    <span className="plabel">中心坐标</span>
                    <span className="prop-val">{coord(selectedContour.center)} mm</span>
                  </div>
                )}
              </>
            )}

            {/* 圆弧: 半径/圆心/角度 */}
            {arc && (
              <>
                <div className="prop-item">
                  <span className="plabel">半径 R</span>
                  <span className="prop-val">{fmt(arc.radius)} mm</span>
                </div>
                <div className="prop-item">
                  <span className="plabel">圆心</span>
                  <span className="prop-val">{coord(arc.center)} mm</span>
                </div>
                <div className="prop-item">
                  <span className="plabel">弧跨度</span>
                  <span className="prop-val">
                    {(arcSpan(arc.center, selectedContour.points[0], selectedContour.points[1], arc.sweep) * 180 / Math.PI).toFixed(1)}°
                  </span>
                </div>
              </>
            )}

            {/* 矩形: 宽/高/中心 */}
            {isRect && (
              <>
                {rectW !== null && (
                  <div className="prop-item">
                    <span className="plabel">宽</span>
                    <span className="prop-val">{fmt(rectW)} mm</span>
                  </div>
                )}
                {rectH !== null && (
                  <div className="prop-item">
                    <span className="plabel">高</span>
                    <span className="prop-val">{fmt(rectH)} mm</span>
                  </div>
                )}
                {rectCenter && (
                  <div className="prop-item">
                    <span className="plabel">中心坐标</span>
                    <span className="prop-val">{coord(rectCenter)} mm</span>
                  </div>
                )}
              </>
            )}

            {/* 折线/直线: 长度 */}
            {totalLen !== null && !isRect && (
              <div className="prop-item">
                <span className="plabel">{selectedContour.closed ? '周长' : '长度'}</span>
                <span className="prop-val">{fmt(totalLen)} mm</span>
              </div>
            )}
          </div>
        ) : (
          <div className="sb-empty">用 🖱 选择工具点击轮廓后, 可在此切换 构造线 / 无限长度 / 内外轮廓, 并查看图形属性。</div>
        )}
      </div>

      {/* 约束面板 (选中轮廓的约束列表) */}
      <div className="sb-section">
        <h4 className="sb-title">约束 (选中轮廓)</h4>
        {selectedContour ? (
          selectedContour.constraints.length === 0 ? (
            <div className="sb-empty">该轮廓无约束。用 ↔ 智能尺寸标注, 或点击图形上的 R 数字调整。</div>
          ) : (
            selectedContour.constraints.map(cons => (
              <div
                key={cons.id}
                className={'cons-item' + (ui.selectedConstraintId === cons.id ? ' sel' : '')}
                onClick={() => setUI({ selectedConstraintId: ui.selectedConstraintId === cons.id ? null : cons.id })}
              >
                <span>{CONS_ICONS[cons.type] ?? '🔗'} {cons.label}</span>
                <button
                  className="cons-del"
                  onClick={(e) => {
                    e.stopPropagation()
                    useAppStore.getState().execute(
                      new RemoveConstraintCommand(selectedContour.id, cons.id))
                  }}
                  title="删除约束"
                >
                  ✕
                </button>
              </div>
            ))
          )
        ) : (
          <div className="sb-empty">先选中一个轮廓。</div>
        )}
      </div>
    </div>
  )
}
