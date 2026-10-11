import { useAppStore } from '../../store/useAppStore'
import { createSpatialLayout } from '../../utils/spatialLayout'

export function SpatialFaceOverview() {
  const config = useAppStore(state => state.spatialLayout)
  const thickness = useAppStore(state => state.splitConfig.thickness)
  let layout
  try { layout = createSpatialLayout({ ...config, thickness }) }
  catch (error) { return <div className="spatial-face-overview" role="alert">{error instanceof Error ? error.message : String(error)}</div> }
  const names = config.template === 'L' ? ['主面', '侧面']
    : config.template === 'U' ? ['左侧', '主面', '右侧']
    : layout.template === 'cylinder' ? ['前右曲面', '后右曲面', '后左曲面', '前左曲面']
    : layout.faces.length === 3 ? ['正面', '右侧', '左侧'] : layout.faces.map((_, index) => `第 ${index + 1} 面`)
  return <div className="spatial-face-overview">
    <h3>立体面片</h3>
    <p>同一工程的局部二维面组成当前立体版面。点击面片可在 3D 视图聚焦。</p>
    {layout.template === 'cylinder' && <p>连续圆筒曲面 · 中线直径 {config.width} mm，四个方向共用同一圈孔阵。</p>}
    {layout.faces.map((face, index) => <button key={face.id} type="button"
      onClick={() => {
        useAppStore.getState().setUI({ viewMode: '3d' })
        requestAnimationFrame(() => requestAnimationFrame(() =>
          window.dispatchEvent(new CustomEvent('snapboard:focus-spatial-face', { detail: { faceId: face.id } }))))
      }}>
      <strong>F{index + 1} · {names[index]}</strong><span>{face.width.toFixed(1)} × {face.height.toFixed(1)} mm</span>
    </button>)}
    <p>{layout.junctions.map((joint, index) => `J${index + 1} ${joint.angleDegrees.toFixed(1)}°`).join(' · ')}</p>
    <small>3D 中点击各面的虚线圆孔，可单独开孔或关闭；孔位按展开平板的统一坐标对齐。逐面自由绘图与独立图片尚未接入。</small>
  </div>
}
