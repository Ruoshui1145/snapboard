import { normalizeWoodGrain, type WoodGrainConfig } from '../../utils/woodGrain'

const fields: Array<[keyof WoodGrainConfig,string,number,number,string]> = [
  ['spacingMm','年轮间距',2,20,'mm'],['variation','自然变化',0,2,'倍'],['scale','纹路缩放',.1,20,'倍'],
  ['rotationDegrees','纹路旋转',-360,360,'°'],['offsetXmm','X 移动',-5000,5000,'mm'],['offsetYmm','Y 移动',-5000,5000,'mm'],
  ['cutDepthMm','切面深度',0,500,'mm'],['seed','纹路编号',0,65535,''],
]
export function WoodGrainPanel({ value,onChange,compact=false }: { value:WoodGrainConfig; onChange(value:WoodGrainConfig):void; compact?:boolean }) {
  const wood = normalizeWoodGrain(value)
  const commonFields = ['spacingMm','variation','rotationDegrees']
  const renderFields = (advanced=false) => <div className="texture-material-grid">{fields.filter(([key]) => (wood.pattern === 'long-grain' || key !== 'cutDepthMm') && (!compact || commonFields.includes(key) !== advanced)).map(([key,label,min,max,unit]) =>
      <label key={`${key}-${wood[key]}`}><span>{label} {unit}</span><input type="number" min={min} max={max} step={key === 'seed' ? 1 : 'any'} defaultValue={String(wood[key])}
        onBlur={event => { const text=event.currentTarget.value.trim(),n=Number(text)
          const next=text&&Number.isFinite(n)&&n>=min&&n<=max ? normalizeWoodGrain({...wood,[key]:n}) : wood
          event.currentTarget.value=String(next[key]);if(next[key]!==wood[key])onChange(next)
        }} onKeyDown={event => { if(event.key==='Escape'){event.currentTarget.value=String(wood[key]);event.currentTarget.blur()}if(event.key==='Enter')event.currentTarget.blur() }} /></label>)}</div>
  const distribution = <label>纹路分布<select value={wood.distribution} onChange={event => onChange({...wood,distribution:event.target.value as WoodGrainConfig['distribution']})}>
    <option value="per-panel">每板随机变化</option><option value="continuous">连续拼接木纹</option></select></label>
  return <section className={`texture-section texture-woodgrain-panel${compact?' is-compact':''}`} aria-label="木纹参数">
    <header className="texture-section-title"><b>{compact?'木纹参数':'木纹走线修改器'}</b>{!compact&&<small>普通基材 + 薄仿木层</small>}</header>
    {!compact && distribution}
    <label>纹路切面<select value={wood.pattern} onChange={event => onChange({...wood,pattern:event.target.value as WoodGrainConfig['pattern']})}>
      <option value="long-grain">纵切长木纹</option><option value="end-grain">横切年轮纹</option></select></label>
    <label>材料体系<select value={wood.filamentType} onChange={event => onChange({...wood,filamentType:event.target.value as WoodGrainConfig['filamentType']})}>
      <option value="PETG">{compact?'PETG 基材 + 仿木 PETG':'普通 PETG 基材 + 仿木 PETG 贴面'}</option><option value="PLA">{compact?'PLA 基材 + 仿木 PLA':'普通 PLA 基材 + 仿木 PLA 贴面'}</option></select></label>
    {renderFields()}
    <button type="button" className="texture-minor-action" onClick={() => onChange({...wood,seed:crypto.getRandomValues(new Uint32Array(1))[0] % 65536})}>换一组纹路</button>
    <details className="texture-advanced-settings"><summary>{compact?'更多木纹调整':'走线与侧面参数'}</summary>
      {compact && <>{distribution}{renderFields(true)}</>}
      <p>木纹层 45° · 表层修改区域 135° · 顶面直线排列</p><p>仅贴面外轮廓绒毛：点距 1 mm · 厚度 0.08 mm</p>
    </details>
    <p className="texture-inline-note">1 号普通料打印基材，2 号仿木料仅打印质感层；修改器不会进入基材。每板变化使用固定种子，预览与重新导出保持一致。</p>
  </section>
}
