// ============ 右侧栏: 分割引擎 + 配件库 (手册式折叠面板, 手机 App 式动态挤压) ============
// 两卡片纵向排列, 打开一个时收起另一个，也允许再次点击已展开标题将两者全部收起:
//  - 展开的分割引擎 → 压缩配件库 (反之亦然), flex-grow 过渡产生挤压/回弹动画
//  - 平时分割引擎默认折叠 (只留标题栏 + ⚡自动分割), 用时点开; 配件库默认展开
// 展开状态存于 store (ui.splitOptionsOpen / ui.partsOpen), 工具栏【⚙ 选项】按钮可同步控制
import { useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { PartLibraryPanel } from './PartLibraryPanel'
import type { PartDefinition } from '../../partLibrary/types'
import { beginPartDrag, endPartDrag } from '../../utils/partDragSession'
import { printableBedDescription } from '../../utils/printBed'
import { BAMBU_PRINTER_PRESETS, splitConfigForPrinter } from '../../utils/bambuPrinterPresets'
import { TextureStudio } from '../texture/TextureStudio'

export function RightSidebar() {
  const splitOpen = useAppStore(s => s.ui.splitOptionsOpen)
  const textureOpen = useAppStore(s => s.ui.textureStudioOpen)
  const setUI = useAppStore(s => s.setUI)
  const splitResult = useAppStore(s => s.splitResult)
  const splitJob = useAppStore(s => s.splitJob)
  const splitConfig = useAppStore(s => s.splitConfig)
  const setSplitConfig = useAppStore(s => s.setSplitConfig)
  const runAutoSplit = useAppStore(s => s.runAutoSplit)
  // 结果是日常主视图；高级参数仅在用户明确需要调整时展开。
  const [configOpen, setConfigOpen] = useState(false)

  const printerPreset = splitConfig.printerPreset || 'bambu-p1s'

  const applyPrinterPreset = (preset: string) => {
    if (preset === 'custom') setSplitConfig({ printerPreset: 'custom' })
    else if (preset === 'generic-220') setSplitConfig({
      printerPreset: 'generic-220', bedW: 220, bedH: 220,
      bedMarginLeft: 0, bedMarginRight: 0, bedMarginBottom: 0, bedMarginTop: 0, bedKeepouts: [],
    })
    else setSplitConfig(splitConfigForPrinter(preset))
  }

  const updateKeepout = (id: string, patch: Partial<(typeof splitConfig.bedKeepouts)[number]>) => {
    setSplitConfig({ bedKeepouts: splitConfig.bedKeepouts.map(zone => zone.id === id ? { ...zone, ...patch } : zone) })
  }

  const activeWorkspace: 'split' | 'parts' | 'texture' = textureOpen ? 'texture' : splitOpen ? 'split' : 'parts'

  /** 三个工作区共享右栏空间；普通用户一次只看到当前任务需要的一组功能。 */
  const selectWorkspace = (workspace: 'split' | 'parts' | 'texture') => {
    if (workspace === 'split') setUI({ splitOptionsOpen: true, partsOpen: false, textureStudioOpen: false, viewMode: '2d' })
    else if (workspace === 'parts') setUI({ splitOptionsOpen: false, partsOpen: true, textureStudioOpen: false, viewMode: '3d', activeTool: 'select' })
    else setUI({ splitOptionsOpen: false, partsOpen: false, textureStudioOpen: true, viewMode: '3d', activeTool: 'select' })
    // 进入业务工作区: 绘图任务已完成, 左栏不再需要 (由 DesignerApp 监听折叠)
    window.dispatchEvent(new Event('snapboard:expand-right-panel'))
  }

  const handleDragPart = (def: PartDefinition, e: React.DragEvent) => {
    const payload = {
      defId: def.id,
      params: Object.fromEntries(def.params.map(p => [p.id, p.default])),
    }
    e.dataTransfer.setData('application/snapboard-part', JSON.stringify(payload))
    e.dataTransfer.effectAllowed = 'copy'
    // 隐藏浏览器默认的整张文字卡片拖影；3D 视口会显示真实模型预览。
    const transparent = document.createElement('canvas')
    transparent.width = 1
    transparent.height = 1
    // Chromium 要求自定义拖影节点已经参与渲染；脱离 DOM 的 canvas 会偶发退回整张卡片拖影。
    transparent.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1'
    document.body.appendChild(transparent)
    e.dataTransfer.setDragImage(transparent, 0, 0)
    window.setTimeout(() => transparent.remove(), 0)
    beginPartDrag(payload)
    setUI({ viewMode: '3d', activeTool: 'select' })
  }

  const handleDragEnd = () => endPartDrag()

  return (
    <div className="rsb">
      {/* ============ 第一级: 业务工作区 tab (分割/配件/纹理) ============ */}
      <div className="rsb-workspace-tabs" role="tablist" aria-label="业务工作区">
        <button
          type="button"
          role="tab"
          aria-selected={activeWorkspace === 'split'}
          className={activeWorkspace === 'split' ? 'active' : ''}
          onClick={() => selectWorkspace('split')}
        ><span>🔪 分割</span><small>{splitJob ? '后台计算中' : splitResult ? `${splitResult.panels.length} 块板件` : '参数与板件'}</small></button>
        <button
          type="button"
          role="tab"
          aria-selected={activeWorkspace === 'parts'}
          className={activeWorkspace === 'parts' ? 'active' : ''}
          onClick={() => selectWorkspace('parts')}
        ><span>🧩 配件</span><small>模型库与装配</small></button>
        <button
          type="button"
          role="tab"
          aria-selected={activeWorkspace === 'texture'}
          className={activeWorkspace === 'texture' ? 'active' : ''}
          onClick={() => selectWorkspace('texture')}
        ><span>🎨 纹理</span><small>贴图、材质与图片</small></button>
      </div>

      {/* ============ 分割引擎 ============ */}
      {activeWorkspace === 'split' && <section className="acc expanded right-workspace-content">
        <div
          className="acc-head"
          role="button"
          tabIndex={0}
          onClick={() => selectWorkspace('split')}
          onKeyDown={(e) => {
            if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault()
              selectWorkspace('split')
            }
          }}
          title="分割引擎参数与结果"
        >
          <span style={{ fontSize: 15 }}>🔪</span>
          <span style={{ fontWeight: 600 }}>分割引擎</span>
          <button
            className={'split-primary-action' + (splitJob ? ' is-busy' : splitResult ? ' is-return' : '')}
            onClick={(e) => {
              e.stopPropagation()
              runAutoSplit()
              setUI({ splitOptionsOpen: true, partsOpen: false, textureStudioOpen: false })
            }}
            title="一键分割: 读取选中(或唯一)外轮廓 -> 切板+打孔 -> 画布预览 + 输出数据"
          >
            {splitJob ? '■ 停止分割' : splitResult ? '↩ 返回草图' : '⚡ 自动分割'}{splitResult && splitResult.panels.length > 0 ? ` (${splitResult.panels.length})` : ''}
          </button>
          <span className="acc-chev acc-chev-box" aria-hidden="true">▼</span>
        </div>
        <div className="acc-body">
          <div className="acc-body-inner split-engine-body">
            <div className="split-sticky-head">
            {/* ---- 参数配置 (默认 = 宜家洞洞板标准) ---- */}
            <section className={'split-config-section' + (configOpen ? ' open' : '')}>
              <button
                className="split-section-toggle"
                type="button"
                aria-expanded={configOpen}
                onClick={() => setConfigOpen(v => !v)}
                title={configOpen ? '收起高级分割参数' : '展开高级分割参数'}
              >
                <span className="split-section-icon">⚙</span>
                <span className="split-section-label">
                  <strong>参数配置</strong>
                  <small>有效打印区、孔位、圆角/倒角与板厚</small>
                </span>
                <span className="split-section-chevron">⌄</span>
              </button>
              {configOpen && (
              <div className="split-config-content">
                <div className="split-config-grid">
              <div className="prop-item" style={{ gridColumn: '1 / -1' }} title="选择常用打印机后仍可继续修改物理热床、边距和禁放区">
                <span className="plabel">打印机模板</span>
                <select className="prop-num" style={{ width: 142 }} value={printerPreset} onChange={e => applyPrinterPreset(e.target.value)}>
                  <option value="custom">自定义</option>
                  <option value="generic-220">通用 220×220</option>
                  {BAMBU_PRINTER_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
                </select>
              </div>
              <div className="prop-item" title="打印机物理热床 X 尺寸；真正排盘边界还会扣除安全边距与禁放区">
                <span className="plabel">物理床宽</span>
                <input className="prop-num" style={{ width: 54 }} type="number" step={20} value={splitConfig.bedW}
                  onChange={e => setSplitConfig({ printerPreset: 'custom', bedW: Math.max(1, +e.target.value || 1) })} />
              </div>
              <div className="prop-item" title="打印机物理热床 Y 尺寸；真正排盘边界还会扣除安全边距与禁放区">
                <span className="plabel">物理床深</span>
                <input className="prop-num" style={{ width: 54 }} type="number" step={20} value={splitConfig.bedH}
                  onChange={e => setSplitConfig({ printerPreset: 'custom', bedH: Math.max(1, +e.target.value || 1) })} />
              </div>
              {([
                ['左安全边', 'bedMarginLeft'], ['右安全边', 'bedMarginRight'],
                ['下安全边', 'bedMarginBottom'], ['上安全边', 'bedMarginTop'],
              ] as const).map(([label, key]) => (
                <div className="prop-item" key={key} title={`${label}会从物理热床边界向内扣除`}>
                  <span className="plabel">{label}</span>
                  <input className="prop-num" style={{ width: 54 }} type="number" min={0} step={0.5} value={splitConfig[key]}
                    onChange={e => setSplitConfig({ [key]: Math.max(0, +e.target.value || 0) })} />
                </div>
              ))}
              <div className="prop-item" style={{ gridColumn: '1 / -1', alignItems: 'flex-start', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span className="plabel" title="擦嘴、切刀、换料结构等不可打印区域">有效打印区</span>
                  <strong style={{ fontSize: 11, color: '#63dfce' }}>{printableBedDescription(splitConfig)}</strong>
                </div>
                {splitConfig.bedKeepouts.length > 0 && (
                  <div style={{ display: 'grid', width: '100%', gridTemplateColumns: '18px 1fr repeat(4, 42px) 22px', gap: 4, color: '#8290a3', fontSize: 9, textAlign: 'center' }}>
                    <span /><span style={{ textAlign: 'left' }}>禁放区名称</span><span>X</span><span>Y</span><span>宽</span><span>高</span><span />
                  </div>
                )}
                {splitConfig.bedKeepouts.map(zone => (
                  <div key={zone.id} style={{ display: 'grid', width: '100%', gridTemplateColumns: '18px 1fr repeat(4, 42px) 22px', gap: 4, alignItems: 'center' }}>
                    <input type="checkbox" title="启用禁放区" checked={zone.enabled} onChange={e => updateKeepout(zone.id, { enabled: e.target.checked })} />
                    <input className="prop-num" aria-label="禁放区名称" title="禁放区名称" value={zone.name} onChange={e => updateKeepout(zone.id, { name: e.target.value })} />
                    {(['x', 'y', 'w', 'h'] as const).map(key => (
                      <input key={key} className="prop-num" aria-label={`禁放区 ${key.toUpperCase()}`} title={`${key.toUpperCase()} (mm)`}
                        type="number" step={1} min={key === 'w' || key === 'h' ? 0 : undefined} value={zone[key]}
                        onChange={e => updateKeepout(zone.id, { [key]: Math.max(0, +e.target.value || 0) })} />
                    ))}
                    <button type="button" title="删除禁放区" onClick={() => setSplitConfig({ bedKeepouts: splitConfig.bedKeepouts.filter(item => item.id !== zone.id) })}>×</button>
                  </div>
                ))}
                <button type="button" onClick={() => setSplitConfig({
                  bedKeepouts: [...splitConfig.bedKeepouts, {
                    id: `keepout-${Date.now()}`, name: '自定义禁放区', x: 0, y: 0, w: 20, h: 20, enabled: true,
                  }],
                })}>＋ 添加禁放区</button>
              </div>
              <div className="prop-item" title="X 模数: 板宽必须是其整数倍">
                <span className="plabel">模数 X</span>
                <input className="prop-num" style={{ width: 54 }} type="number" value={splitConfig.mx}
                  onChange={e => setSplitConfig({ mx: Math.max(1, +e.target.value || 1) })} />
              </div>
              <div className="prop-item" title="Y 模数: 板高必须是其整数倍">
                <span className="plabel">模数 Y</span>
                <input className="prop-num" style={{ width: 54 }} type="number" value={splitConfig.my}
                  onChange={e => setSplitConfig({ my: Math.max(1, +e.target.value || 1) })} />
              </div>
              <div className="prop-item" title="长圆孔阵列离板边的最小距离">
                <span className="plabel">边缘预留</span>
                <input className="prop-num" style={{ width: 54 }} type="number" value={splitConfig.edgeMargin}
                  onChange={e => setSplitConfig({ edgeMargin: Math.max(0, +e.target.value || 0) })} />
              </div>
              <div className="prop-item" title="防碎边: 小于此宽度的板放弃切割并合并">
                <span className="plabel">最小板宽</span>
                <input className="prop-num" style={{ width: 54 }} type="number" value={splitConfig.minW}
                  onChange={e => setSplitConfig({ minW: Math.max(1, +e.target.value || 1) })} />
              </div>
              <div className="prop-item" title="防碎边: 小于此高度的板放弃切割并合并">
                <span className="plabel">最小板高</span>
                <input className="prop-num" style={{ width: 54 }} type="number" value={splitConfig.minH}
                  onChange={e => setSplitConfig({ minH: Math.max(1, +e.target.value || 1) })} />
              </div>
              <div className="prop-item" title="规则分区优先避免出现小于该宽度的细长条、细颈和难固定板件">
                <span className="plabel">最小结构宽</span>
                <input className="prop-num" style={{ width: 54 }} type="number" step={5} value={splitConfig.minFeatureWidth}
                  onChange={e => setSplitConfig({ minFeatureWidth: Math.max(1, +e.target.value || 1) })} />
              </div>
              <div className="prop-item" title="内孔优先完整归属单板时，与分板接缝保留的安全距离；确实放不下会自动跨板">
                <span className="plabel">孔缝安全距</span>
                <input className="prop-num" style={{ width: 54 }} type="number" step={1} value={splitConfig.holeSeamClearance}
                  onChange={e => setSplitConfig({ holeSeamClearance: Math.max(0, +e.target.value || 0) })} />
              </div>
              <div className="prop-item" title="长圆孔和固定圆孔与外边、缺口、内孔之间至少保留的实体材料宽度；冲突孔会自动删除留白">
                <span className="plabel">孔边留白</span>
                <input className="prop-num" style={{ width: 54 }} type="number" step={0.5} value={splitConfig.holeBoundaryClearance}
                  onChange={e => setSplitConfig({ holeBoundaryClearance: Math.max(0, +e.target.value || 0) })} />
              </div>
              <div className="prop-item" title="内部垂直接缝圆孔线的默认内缩；非模数外周会对齐最近长孔列">
                <span className="plabel">固定孔偏移X</span>
                <input className="prop-num" style={{ width: 54 }} type="number" value={splitConfig.jointOffsetX}
                  onChange={e => setSplitConfig({ jointOffsetX: Math.max(0, +e.target.value || 0) })} />
              </div>
              <div className="prop-item" title="内部水平接缝圆孔线的默认内缩；非模数外周会对齐最近长孔行">
                <span className="plabel">固定孔偏移Y</span>
                <input className="prop-num" style={{ width: 54 }} type="number" value={splitConfig.jointOffsetY}
                  onChange={e => setSplitConfig({ jointOffsetY: Math.max(0, +e.target.value || 0) })} />
              </div>
              <div className="prop-item" title="板件整体外轮廓凸角的平面圆角半径；拼接内角保持直角">
                <span className="plabel">轮廓圆角 R</span>
                <input className="prop-num" style={{ width: 54 }} type="number" step={0.5} value={splitConfig.cornerRadius}
                  onChange={e => setSplitConfig({ cornerRadius: Math.max(0, +e.target.value || 0) })} />
              </div>
              <div className="prop-item" title="3MF 制造模型上、下表面边缘的微倒角尺寸">
                <span className="plabel">制造倒角</span>
                <input className="prop-num" style={{ width: 54 }} type="number" step={0.05} value={splitConfig.manufacturingChamfer}
                  onChange={e => setSplitConfig({ manufacturingChamfer: Math.max(0, +e.target.value || 0) })} />
              </div>
              <div className="prop-item" title="竖向长圆孔总长 (长轴, 工程图 15.0)">
                <span className="plabel">槽长</span>
                <input className="prop-num" style={{ width: 54 }} type="number" step={0.5} value={splitConfig.slotLength}
                  onChange={e => setSplitConfig({ slotLength: Math.max(1, +e.target.value || 1) })} />
              </div>
              <div className="prop-item" title="竖向长圆孔宽度 (短轴 = 2×端部半径, 工程图 5.0)">
                <span className="plabel">槽宽</span>
                <input className="prop-num" style={{ width: 54 }} type="number" step={0.5} value={splitConfig.slotWidth}
                  onChange={e => setSplitConfig({ slotWidth: Math.max(0.5, +e.target.value || 0.5) })} />
              </div>
              <div className="prop-item" title="长圆孔两端圆弧半径，由槽宽自动计算">
                <span className="plabel">槽端半径</span>
                <span style={{ fontSize: 11, color: '#aab6c6' }}>R {(splitConfig.slotWidth / 2).toFixed(2)} mm</span>
              </div>
              <div className="prop-item" title="A 列胶囊中心 X 零位 (相对整板左下角, 工程图 10)">
                <span className="plabel">槽列起点X</span>
                <input className="prop-num" style={{ width: 54 }} type="number" step={0.5} value={splitConfig.slotGridX0}
                  onChange={e => setSplitConfig({ slotGridX0: Math.max(0, +e.target.value || 0) })} />
              </div>
              <div className="prop-item" title="A 列胶囊中心 Y 零位 (工程图 30)">
                <span className="plabel">槽列起点Y</span>
                <input className="prop-num" style={{ width: 54 }} type="number" step={0.5} value={splitConfig.slotGridY0}
                  onChange={e => setSplitConfig({ slotGridY0: Math.max(0, +e.target.value || 0) })} />
              </div>
              <div className="prop-item" title="B 列相对 A 列 X 错位 (工程图 20)">
                <span className="plabel">槽列错位X</span>
                <input className="prop-num" style={{ width: 54 }} type="number" step={0.5} value={splitConfig.slotStaggerX}
                  onChange={e => setSplitConfig({ slotStaggerX: Math.max(0, +e.target.value || 0) })} />
              </div>
              <div className="prop-item" title="B 列相对 A 列 Y 错位 (工程图 20)">
                <span className="plabel">槽列错位Y</span>
                <input className="prop-num" style={{ width: 54 }} type="number" step={0.5} value={splitConfig.slotStaggerY}
                  onChange={e => setSplitConfig({ slotStaggerY: Math.max(0, +e.target.value || 0) })} />
              </div>
              <div className="prop-item" title="边缘敲落圆孔直径（用户确认制造规格 φ5）">
                <span className="plabel">敲落孔直径</span>
                <input className="prop-num" style={{ width: 54 }} type="number" step={0.5} value={splitConfig.jointDiameter}
                  onChange={e => setSplitConfig({ jointDiameter: Math.max(1, +e.target.value || 1) })} />
              </div>
              <div className="prop-item" title="板材厚度">
                <span className="plabel">板厚</span>
                <input className="prop-num" style={{ width: 54 }} type="number" step={0.5} value={splitConfig.thickness}
                  onChange={e => setSplitConfig({ thickness: Math.max(0.5, +e.target.value || 0.5) })} />
              </div>
              <div className="prop-item" title="自动把推荐固定孔设为贯通孔；其余候选位置仅显示虚线，可在2D或3D中点击切换">
                <span className="plabel">推荐打孔</span>
                <input type="checkbox" checked={splitConfig.recommendKnockouts}
                  onChange={e => setSplitConfig({ recommendKnockouts: e.target.checked })} />
              </div>
              <div className="prop-item" title="拼装间隙 (公差预留)">
                <span className="plabel">拼装间隙</span>
                <input className="prop-num" style={{ width: 54 }} type="number" step={0.05} value={splitConfig.gapTolerance}
                  onChange={e => setSplitConfig({ gapTolerance: Math.max(0, +e.target.value || 0) })} />
              </div>
                </div>
                <div className="split-config-help">
              孔型 = 200×200 工程图 (SKÅDIS 20cm 板, 200.200边缘带孔.DXF): 竖向长圆孔 5.0×15.0、
              晶体错列阵列 (A/B 列族 40×40 周期, B 列错位 20/20, 锚定整板左下角);
              <strong>边缘 = 候选圆孔 φ5 一排</strong>（内部接缝默认内缩 10mm；外周对齐最近长孔行/列；沿边间距 40mm；
              未启用时只显示虚线位置提示，启用后直接贯穿整块板)。
              板宽=模数X整数倍, 板高=模数Y整数倍; 小于最小板宽/高的切割自动放弃并合并 (防碎边)。
              初始铺板完成后会自动执行<strong>边缘融合</strong>：相邻板的合并包围盒能放进热床时，
              可生成 L 型、阶梯型等正交异形板，优先减少板块、内部接缝和固定件占用。
              细长板会在<strong>扣除安全边距后的有效打印区</strong>内计算旋转投影，且真实轮廓不得进入擦嘴/机构禁放区；满足时允许对角排版并输出建议角度。
              内孔优先以“孔缝安全距”完整归属一块板；超过热床或无法避缝时自动跨板并逐板精确扣孔。
                </div>
              </div>
              )}
            </section>

            {/* ---- 分割结果固定信息: 标题、摘要、警告与轮廓覆盖率 ---- */}
              <div className="split-result-sticky">
                <div className="split-result-head">
                  <span className="split-result-title">▦ 分割结果</span>
                  <span className={'split-result-status' + (splitJob ? ' busy' : splitResult ? ' ready' : '')}>
                    {splitJob ? '正在计算' : splitResult ? `${splitResult.panels.length} 块板` : '等待生成'}
                  </span>
                </div>
                {splitJob ? (
                  <div className="split-empty-result is-busy" aria-live="polite">
                    <span className="split-busy-spinner" aria-hidden="true" />
                    <strong>{splitJob.phase === 'committing' ? '正在载入板件' : '正在后台分割'}</strong>
                    <span>已处理 {splitJob.completed} / {splitJob.total} 个外轮廓</span>
                    <button type="button" onClick={runAutoSplit}>■ 停止分割</button>
                  </div>
                ) : !splitResult ? (
                  <div className="split-empty-result">
                    <span className="split-empty-icon">▦</span>
                    <strong>还没有分割结果</strong>
                    <span>先在画布中选择一个闭合外轮廓，再点击上方“自动分割”。</span>
                    <button type="button" onClick={runAutoSplit}>⚡ 立即自动分割</button>
                  </div>
                ) : (
                  <>
                    <div className="split-result-summary">
                      <span className="split-result-summary-text">
                        共 {splitResult.panels.length} 块板
                        {splitResult.panels.some(p => (p.contour?.length ?? 0) > 4)
                          ? ` · ${splitResult.panels.filter(p => (p.contour?.length ?? 0) > 4).length} 块已边缘融合`
                          : ''}
                        {' · '}支持方孔/圆孔/跨板孔
                      </span>
                      <span className="split-export-location" title="项目保存、另存为与排盘 3MF 统一位于顶部第二行“文件”区">
                        导出位于顶部“文件”
                      </span>
                    </div>
                    {splitResult.warnings.map((w, i) => (
                      <div key={i} style={{ fontSize: 11, color: '#e8b84b', margin: '2px 0' }}>⚠ {w}</div>
                    ))}
                    <div className="split-source-overview" aria-label="轮廓分割摘要">
                      {splitResult.sources.map(src => (
                        <div key={src.contourId} className="split-source-overview-row">
                          <span>📐 {src.name}</span>
                          <span>{src.panels.length} 块 · 覆盖率 {(src.coverageRatio * 100).toFixed(0)}%</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* ---- 只有板件明细参与滚动 ---- */}
            <section className="split-result-section">
              {splitResult && (
                <div className="split-board-list">
                  {(() => {
                    const PALETTE = ['#3ec6b0', '#ffd166', '#b39ddb', '#5ea4ff']
                    let globalIdx = 0
                    return splitResult.sources.map(src => {
                      const base = globalIdx
                      globalIdx += src.panels.length
                      return (
                        <div key={src.contourId} style={{ marginTop: 6 }}>
                          {src.panels.map((p, i) => {
                            const dot = PALETTE[(base + i) % PALETTE.length]
                            return (
                              <div key={p.id} className="split-panel-row">
                                <span className="split-panel-identity">
                                  <strong className="split-panel-badge" style={{ background: dot }}>{p.id.toUpperCase()}</strong>
                                  <span className="split-panel-size">{p.w} × {p.h} mm</span>
                                  {(p.contour?.length ?? 0) > 4 && <span className="split-panel-fused">融合</span>}
                                  {(p.printRotation ?? 0) > 0 && <span className="split-panel-fused">排版 {p.printRotation}°</span>}
                                </span>
                                <span className="split-panel-coords">@ ({p.x}, {p.y})</span>
                                <span className="split-panel-meta">长孔 {p.slots.length} · 内孔 {p.cutouts?.length ?? 0} · 拼接孔 {p.edge_holes.length}</span>
                              </div>
                            )
                          })}
                        </div>
                      )
                    })
                  })()}
                </div>
              )}
            </section>
          </div>
        </div>
      </section>}

      {/* ============ 配件库 ============ */}
      {activeWorkspace === 'parts' && <section className="acc expanded right-workspace-content">
        <div
          className="acc-head"
          role="button"
          tabIndex={0}
          onClick={() => selectWorkspace('parts')}
          onKeyDown={(e) => {
            if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault()
              selectWorkspace('parts')
            }
          }}
          title="配件库（拖出装配）"
        >
          <span style={{ fontSize: 15 }}>🧩</span>
          <span style={{ fontWeight: 600 }}>配件库</span>
          <span className="acc-chev acc-chev-box" aria-hidden="true">▼</span>
        </div>
        <div className="acc-body">
          <div className="acc-body-inner">
            <PartLibraryPanel onDragPart={handleDragPart} onDragEnd={handleDragEnd} headerless />
          </div>
        </div>
      </section>}
      {activeWorkspace === 'texture' && <TextureStudio docked />}
    </div>
  )
}
