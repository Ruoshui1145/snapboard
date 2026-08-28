import { useRef, useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import type { BoardTextureColorMode, BoardTextureFit, BoardTextureModelingMode } from '../../types/geometry'
import { BOARD_TEXTURE_PRESETS, createDefaultBoardTexture, getSplitPanelTextureBounds } from '../../utils/boardTexture'
import { LUMINA_LUTS, normalizeLuminaLutId } from '../../utils/luminaLut'

const FIT_OPTIONS: Array<{ id: BoardTextureFit; label: string; hint: string }> = [
  { id: 'cover', label: '覆盖', hint: '铺满板面，允许裁掉图片边缘' },
  { id: 'contain', label: '完整', hint: '显示整张图片，可能留下背景边' },
  { id: 'stretch', label: '拉伸', hint: '强制匹配整个板面比例' },
  { id: 'tile', label: '平铺', hint: '把图案重复排列到整块板面' },
]

const COLOR_MODES: Array<{ id: BoardTextureColorMode; label: string }> = [
  { id: 'original', label: '原色' },
  { id: 'mono', label: '黑白' },
  { id: 'posterize', label: '色阶' },
]

const MODELING_MODES: Array<{ id: BoardTextureModelingMode; label: string; hint: string }> = [
  { id: 'high-fidelity', label: '高保真', hint: '连续图像 · Lumina 0.1mm 级自适应采样' },
  { id: 'pixel', label: '像素艺术', hint: '保留可见色块，可手动设置格子尺寸' },
  { id: 'vector', label: 'SVG 矢量', hint: '面向 SVG 图案，以 0.08mm 级采样保持硬边' },
]

const VENEER_MATERIALS = [
  { name: '浅绿色 PETG 大理石', color: '#A8CDBA' },
  { name: '暖白色 PETG 大理石', color: '#E7E1D2' },
  { name: '石墨灰 PETG 金属', color: '#68717A' },
  { name: '深海蓝 PETG 闪粉', color: '#294D68' },
  { name: '自定义表层 PETG', color: '#B58CC8' },
]

interface TextureRangeProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  unit?: string
  onChange(value: number): void
}

function TextureRange({ label, value, min, max, step, unit = '', onChange }: TextureRangeProps) {
  return (
    <label className="texture-range">
      <span><b>{label}</b><output>{Math.round(value * 100) / 100}{unit}</output></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={event => onChange(+event.target.value)} />
    </label>
  )
}

const loadBrowserImage = (file: File): Promise<HTMLImageElement> => new Promise((resolve, reject) => {
  const url = URL.createObjectURL(file)
  const image = new Image()
  image.onload = () => {
    URL.revokeObjectURL(url)
    resolve(image)
  }
  image.onerror = () => {
    URL.revokeObjectURL(url)
    reject(new Error('浏览器无法解码这张图片，请改用 PNG、JPG 或 WebP'))
  }
  image.src = url
})

const fileDataUrl = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result))
  reader.onerror = () => reject(new Error('文件读取失败'))
  reader.readAsDataURL(file)
})

async function prepareImage(file: File): Promise<{ dataUrl: string; aspect: number; vector: boolean }> {
  if (!file.type.startsWith('image/')) throw new Error('请选择图片文件')
  if (file.size > 16 * 1024 * 1024) throw new Error('图片不能超过 16 MB')
  const image = await loadBrowserImage(file)
  const vector = file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg')
  if (vector) return { dataUrl: await fileDataUrl(file), aspect: image.naturalWidth / Math.max(1, image.naturalHeight), vector: true }
  const limit = 1600
  const scale = Math.min(1, limit / Math.max(image.naturalWidth, image.naturalHeight))
  const width = Math.max(1, Math.round(image.naturalWidth * scale))
  const height = Math.max(1, Math.round(image.naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('浏览器无法创建图片处理画布')
  ctx.drawImage(image, 0, 0, width, height)
  const transparent = file.type === 'image/png' || file.type === 'image/webp'
  return {
    dataUrl: canvas.toDataURL(transparent ? 'image/png' : 'image/webp', 0.9),
    aspect: width / height,
    vector: false,
  }
}

export function TextureStudio({ docked = false }: { docked?: boolean }) {
  const open = useAppStore(state => state.ui.textureStudioOpen)
  const setUI = useAppStore(state => state.setUI)
  const storedTexture = useAppStore(state => state.boardTexture)
  const texture = { ...createDefaultBoardTexture(), ...storedTexture, lutId: normalizeLuminaLutId(storedTexture.lutId) }
  const setTexture = useAppStore(state => state.setBoardTexture)
  const splitResult = useAppStore(state => state.splitResult)
  const splitConfig = useAppStore(state => state.splitConfig)
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')
  const [minimized, setMinimized] = useState(false)
  const [openSection, setOpenSection] = useState<'source' | 'model' | 'mapping' | 'color' | 'layer' | null>('source')
  if (!open) return null

  const panels = splitResult?.panels ?? []
  const bounds = getSplitPanelTextureBounds(panels)
  const structuralThickness = Math.max(0.2, splitConfig.thickness - texture.textureThickness)
  const selectedLut = LUMINA_LUTS.find(lut => lut.id === texture.lutId) ?? LUMINA_LUTS[0]
  const opticalThickness = selectedLut.layerCount * selectedLut.layerHeight
  const studioMode: 'preset' | 'material' | 'image' = texture.surfaceMode === 'veneer'
    ? 'material'
    : texture.source === 'image'
      ? 'image'
      : 'preset'

  const selectStudioMode = (mode: typeof studioMode) => {
    if (mode === 'preset') setTexture({ enabled: true, source: 'preset', surfaceMode: 'lumina' })
    else if (mode === 'material') setTexture({ enabled: true, source: 'preset', surfaceMode: 'veneer' })
    else setTexture({ enabled: Boolean(texture.imageDataUrl), source: 'image', surfaceMode: 'lumina' })
    setOpenSection('source')
  }

  const importFile = async (file?: File) => {
    if (!file) return
    setUploading(true)
    setError('')
    try {
      const prepared = await prepareImage(file)
      setTexture({
        enabled: true,
        source: 'image',
        imageDataUrl: prepared.dataUrl,
        imageName: file.name,
        imageAspect: prepared.aspect,
        fit: 'cover',
        scale: 100,
        offsetX: 0,
        offsetY: 0,
        rotation: 0,
        modelingMode: prepared.vector ? 'vector' : texture.modelingMode === 'vector' ? 'high-fidelity' : texture.modelingMode,
      })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setUploading(false)
    }
  }

  return (
    <aside className={`texture-studio${minimized && !docked ? ' is-minimized' : ''}${docked ? ' is-docked' : ''}`} role="dialog" aria-label="洞洞板纹理工作室">
      <header className="texture-studio-head">
        <div>
          <span className="texture-studio-kicker">SURFACE LAB</span>
          <strong>纹理工作室</strong>
          <small>整板统一映射 · 分割缝保持连续 · 孔洞自动避让</small>
        </div>
        <label className="texture-enable" title="保留参数但暂时关闭纹理">
          <input type="checkbox" checked={texture.enabled} onChange={event => setTexture({ enabled: event.target.checked })} />
          <span>{texture.enabled ? '已启用' : '已关闭'}</span>
        </label>
        {!docked && <button className="texture-minimize" type="button" onClick={() => setMinimized(value => !value)}
          aria-label={minimized ? '展开纹理工作室' : '最小化纹理工作室'} title={minimized ? '展开纹理工作室' : '最小化纹理工作室'}>{minimized ? '⌄' : '⌃'}</button>}
        <button className="texture-close" type="button" onClick={() => setUI({ textureStudioOpen: false, partsOpen: docked })} aria-label="关闭纹理工作室">×</button>
      </header>

      <div className="texture-flow" aria-label="纹理设计流程">
        <span className="done"><b>1</b>板件</span><i />
        <span className={texture.enabled ? 'done' : ''}><b>2</b>纹理</span><i />
        <span><b>3</b>{studioMode === 'material' ? '材质层' : '多色层'}</span>
      </div>

      {!panels.length && (
        <div className="texture-empty">
          <b>还没有可映射的板件</b>
          <span>请先返回 2D 绘制闭合轮廓并执行“自动分割”，再进入 3D 添加纹理。</span>
        </div>
      )}

      <div className="texture-source-tabs texture-workflow-tabs">
        <button type="button" className={studioMode === 'preset' ? 'on' : ''} onClick={() => selectStudioMode('preset')}>▦ 贴图纹理</button>
        <button type="button" className={studioMode === 'material' ? 'on' : ''} onClick={() => selectStudioMode('material')}>◆ 材质纹理</button>
        <button type="button" className={studioMode === 'image' ? 'on' : ''} onClick={() => selectStudioMode('image')}>▧ 自定义图片</button>
      </div>

      <div className="texture-studio-scroll">
        {studioMode === 'preset' && (
          <section className="texture-section">
            <button type="button" className="texture-section-title" onClick={() => setOpenSection(section => section === 'source' ? null : 'source')}>
              <span><b>内置贴图包</b><small>马赛克、波纹与图案通过 Lumina 叠色制造</small></span><em>{openSection === 'source' ? '⌃' : '⌄'}</em>
            </button>
            {openSection === 'source' && <div className="texture-preset-grid">
              {BOARD_TEXTURE_PRESETS.map(preset => (
                <button type="button" key={preset.id}
                  className={texture.presetId === preset.id ? 'on' : ''}
                  onClick={() => setTexture({ enabled: true, source: 'preset', surfaceMode: 'lumina', presetId: preset.id })}>
                  <span className="texture-preset-preview" style={{ background: preset.preview }} />
                  <span><b>{preset.name}</b><small>{preset.description}</small></span>
                  <i>{preset.colors.map(color => <em key={color} style={{ background: color }} />)}</i>
                </button>
              ))}
            </div>}
          </section>
        )}

        {studioMode === 'material' && (
          <section className="texture-section">
            <button type="button" className="texture-section-title" onClick={() => setOpenSection(section => section === 'source' ? null : 'source')}>
              <span><b>表层材质包</b><small>4mm 普通基材 + 约 1mm 高级 PETG 贴面</small></span><em>{openSection === 'source' ? '⌃' : '⌄'}</em>
            </button>
            {openSection === 'source' && <><div className="texture-preset-grid texture-veneer-grid">
              {VENEER_MATERIALS.map(material => (
                <button type="button" key={material.name} className={texture.surfaceMaterialName === material.name ? 'on' : ''}
                  onClick={() => setTexture({ enabled: true, surfaceMode: 'veneer', surfaceMaterialName: material.name, surfaceColor: material.color })}>
                  <span className="texture-preset-preview veneer" style={{ background: `radial-gradient(circle at 25% 22%,rgba(255,255,255,.36),transparent 22%),repeating-linear-gradient(125deg,${material.color},${material.color} 8px,#ffffff18 9px,#ffffff18 11px)` }} />
                  <span><b>{material.name}</b><small>单耗材质感表层</small></span>
                  <i><em style={{ background: material.color }} /></i>
                </button>
              ))}
            </div><p className="texture-inline-note">后续自定义材质包只需增加名称、预览和 PETG 颜色；不会进入 Lumina 图片调色流程。</p></>}
          </section>
        )}

        {studioMode === 'image' && (
          <section className="texture-section">
            <button type="button" className="texture-section-title" onClick={() => setOpenSection(section => section === 'source' ? null : 'source')}>
              <span><b>图片与 Lumina 模式</b><small>导入预览和建模方式并排设置</small></span><em>{openSection === 'source' ? '⌃' : '⌄'}</em>
            </button>
            {openSection === 'source' && <><input ref={inputRef} hidden type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,.svg" onChange={event => void importFile(event.target.files?.[0])} />
              <div className="texture-image-workflow">
              <button type="button"
              className={`texture-dropzone${dragging ? ' dragging' : ''}${texture.imageDataUrl ? ' has-image' : ''}`}
              onClick={() => inputRef.current?.click()}
              onDragEnter={event => { event.preventDefault(); setDragging(true) }}
              onDragOver={event => event.preventDefault()}
              onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) }}
              onDrop={event => {
                event.preventDefault()
                setDragging(false)
                void importFile(event.dataTransfer.files[0])
              }}>
              {texture.imageDataUrl ? <img src={texture.imageDataUrl} alt="当前自定义纹理" /> : <span className="texture-drop-icon">＋</span>}
              <span>
                <b>{uploading ? '正在处理图片…' : texture.imageName || '拖入图片或点击选择'}</b>
                <small>{texture.imageDataUrl ? '点击可替换 · 图片会随工程保存' : '系统会压缩到适合实时预览的尺寸'}</small>
              </span>
              </button>
              <div className="texture-image-model-modes">
                {MODELING_MODES.map(mode => (
                  <button type="button" key={mode.id} className={texture.modelingMode === mode.id ? 'on' : ''}
                    title={mode.hint} onClick={() => setTexture({ modelingMode: mode.id })}><b>{mode.label}</b><small>{mode.hint}</small></button>
                ))}
              </div>
              </div>
              {error && <div className="texture-error">{error}</div>}</>}
          </section>
        )}

        {studioMode !== 'material' && <section className="texture-section texture-mapping">
          <button type="button" className="texture-section-title" onClick={() => setOpenSection(section => section === 'mapping' ? null : 'mapping')}>
            <span><b>映射方式</b><small>{Math.round(bounds.width)} × {Math.round(bounds.height)} mm 整板坐标</small></span><em>{openSection === 'mapping' ? '⌃' : '⌄'}</em>
          </button>
          {openSection === 'mapping' && <><div className="texture-fit-options">
            {FIT_OPTIONS.map(option => (
              <button type="button" key={option.id} className={texture.fit === option.id ? 'on' : ''}
                title={option.hint} onClick={() => setTexture({ fit: option.id })}>{option.label}</button>
            ))}
          </div>
          <div className="texture-control-grid">
            <TextureRange label="比例" value={texture.scale} min={20} max={250} step={1} unit="%" onChange={scale => setTexture({ scale })} />
            <TextureRange label="旋转" value={texture.rotation} min={-180} max={180} step={1} unit="°" onChange={rotation => setTexture({ rotation })} />
            <TextureRange label="水平偏移" value={texture.offsetX} min={-100} max={100} step={1} unit="%" onChange={offsetX => setTexture({ offsetX })} />
            <TextureRange label="垂直偏移" value={texture.offsetY} min={-100} max={100} step={1} unit="%" onChange={offsetY => setTexture({ offsetY })} />
          </div></>}
        </section>}

        {studioMode !== 'material' && <section className="texture-section texture-color-section">
          <button type="button" className="texture-section-title" onClick={() => setOpenSection(section => section === 'color' ? null : 'color')}>
            <span><b>打印端调色</b><small>LUT、色相保护与颜色细节</small></span><em>{openSection === 'color' ? '⌃' : '⌄'}</em>
          </button>
          {openSection === 'color' && <><div className="texture-color-modes">
            {COLOR_MODES.map(mode => (
              <button type="button" key={mode.id} className={texture.colorMode === mode.id ? 'on' : ''}
                onClick={() => setTexture({ colorMode: mode.id })}>{mode.label}</button>
            ))}
          </div>
          <div className="texture-control-grid">
            <TextureRange label="亮度" value={texture.brightness} min={0.4} max={1.6} step={0.02} onChange={brightness => setTexture({ brightness })} />
            <TextureRange label="对比度" value={texture.contrast} min={0.4} max={1.6} step={0.02} onChange={contrast => setTexture({ contrast })} />
            <TextureRange label="饱和度" value={texture.saturation} min={0} max={1.8} step={0.02} onChange={saturation => setTexture({ saturation })} />
            <TextureRange label="目标色阶" value={texture.colorCount} min={2} max={8} step={1} unit=" 色" onChange={colorCount => setTexture({ colorCount })} />
          </div>
          <label className="texture-lut-select"><span><b>校准色卡</b><small>基础耗材与实测叠色配方</small></span>
            <select value={texture.lutId} onChange={event => setTexture({ lutId: event.target.value as typeof texture.lutId })}>
              {LUMINA_LUTS.map(lut => <option key={lut.id} value={lut.id}>{lut.name}</option>)}
            </select>
          </label>
          <small className="texture-lut-description">{selectedLut.description}</small>
          <div className="texture-print-note"><b>PETG 光学层说明</b><span>Bambu Studio 按基础耗材显示白/红/黄/蓝等实体层，不会模拟透光后的混合色；网页板面是最终正面观感预览。</span></div>
          <TextureRange label="颜色细节" value={texture.quantizeColors} min={8} max={96} step={4} unit=" 色" onChange={quantizeColors => setTexture({ quantizeColors })} />
          <TextureRange label="色相保护" value={texture.hueWeight} min={0} max={1} step={0.05} onChange={hueWeight => setTexture({ hueWeight })} />
          <label className="texture-enable texture-cleanup"><input type="checkbox" checked={texture.cleanup} onChange={event => setTexture({ cleanup: event.target.checked })} /><span>清理孤立配方点</span></label>
          </>}
        </section>}

        <section className="texture-section texture-layer-plan">
          <button type="button" className="texture-section-title" onClick={() => setOpenSection(section => section === 'layer' ? null : 'layer')}>
            <span><b>{structuralThickness.toFixed(1)}mm 基层 + {texture.textureThickness.toFixed(1)}mm {texture.surfaceMode === 'lumina' ? '彩色版画' : '质感贴面'}</b><small>{texture.surfaceMode === 'lumina' ? `顶部 ${selectedLut.layerCount}×${selectedLut.layerHeight.toFixed(2)}mm PETG 光学叠色` : `${texture.surfaceMaterialName} · 单耗材表层`}</small></span><em>{openSection === 'layer' ? '⌃' : '⌄'}</em>
          </button>
          {openSection === 'layer' && <>
          <div className="texture-material-grid">
            <label><span>结构基材</span><input type="text" value={texture.baseMaterialName} maxLength={80} onChange={event => setTexture({ baseMaterialName: event.target.value })} /></label>
            <label className="texture-color-input"><span>基材颜色</span><input type="color" value={texture.baseColor} onChange={event => setTexture({ baseColor: event.target.value.toUpperCase() })} /></label>
            {texture.surfaceMode === 'veneer' && <>
              <label><span>表层耗材</span><select value={texture.surfaceMaterialName} onChange={event => {
                const selected = VENEER_MATERIALS.find(material => material.name === event.target.value)
                setTexture({ surfaceMaterialName: event.target.value, ...(selected ? { surfaceColor: selected.color } : {}) })
              }}>{VENEER_MATERIALS.map(material => <option key={material.name} value={material.name}>{material.name}</option>)}</select></label>
              <label className="texture-color-input"><span>表层颜色</span><input type="color" value={texture.surfaceColor} onChange={event => setTexture({ surfaceColor: event.target.value.toUpperCase() })} /></label>
            </>}
          </div>
          <TextureRange label="基材填充" value={texture.baseInfillDensity} min={5} max={50} step={1} unit="%" onChange={baseInfillDensity => setTexture({ baseInfillDensity })} />
          <div className="texture-finish-options">
            <button type="button" className={texture.surfaceFinish === 'textured-pei' ? 'on' : ''} onClick={() => setTexture({ surfaceFinish: 'textured-pei' })}><b>细磨砂面</b><small>装饰面朝下贴纹理 PEI 热床</small></button>
            <button type="button" className={texture.surfaceFinish === 'smooth-top' ? 'on' : ''} onClick={() => setTexture({ surfaceFinish: 'smooth-top' })}><b>普通顶面</b><small>装饰面朝上，由顶层走线形成表面</small></button>
          </div>
          <TextureRange label={texture.surfaceMode === 'lumina' ? '彩色纹理层' : '质感贴面厚度'} value={texture.textureThickness} min={texture.surfaceMode === 'lumina' ? opticalThickness + 0.08 : 0.4}
            max={Math.max(opticalThickness + 0.08, Math.min(2, splitConfig.thickness - 0.2))} step={0.08} unit=" mm"
            onChange={textureThickness => setTexture({ textureThickness })} />
          {texture.modelingMode === 'pixel' ? <TextureRange label="像素格尺寸" value={texture.pixelSize} min={0.4} max={6} step={0.2} unit=" mm/格"
            onChange={pixelSize => setTexture({ pixelSize })} /> : <div className="texture-resolution-note">
              <b>{texture.modelingMode === 'vector' ? '0.08mm 级' : '0.10mm 级'}自适应采样</b><small>大板会自动放宽采样，防止 3MF 体积失控</small>
            </div>}
          <div className="texture-layer-bar">
            <span style={{ flex: structuralThickness }}><b>{structuralThickness.toFixed(1)} mm</b><small>结构板体</small></span>
            <span className="art" style={{ flex: texture.textureThickness }}><b>{texture.textureThickness.toFixed(1)} mm</b><small>{texture.surfaceMode === 'lumina' ? `${Math.max(0, texture.textureThickness - opticalThickness).toFixed(2)} 承托 + ${opticalThickness.toFixed(2)} 光学` : texture.surfaceMaterialName}</small></span>
          </div>
          <p>总厚度保持 {splitConfig.thickness.toFixed(1)} mm。结构基材采用 0.28mm、2 壁、{Math.round(texture.baseInfillDensity)}% 填充，0.6mm 承托/壳层同样使用 0.28mm；只有 Lumina 光学叠色保持 0.08mm 慢速高质量参数。</p></>}
        </section>
      </div>

      <footer className="texture-studio-foot">
        <span>{panels.length ? `${panels.length} 块板件 · 全局连续 UV · 拖右下角调大小` : '等待分割结果'}</span>
        <button type="button" onClick={() => setTexture(createDefaultBoardTexture())}>重置纹理</button>
      </footer>
    </aside>
  )
}
