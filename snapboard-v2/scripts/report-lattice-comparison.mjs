import fs from 'node:fs/promises'
import path from 'node:path'
import {zipSync,strToU8} from 'fflate'
const dir=path.resolve('output/lattice-comparison')
const data=JSON.parse(await fs.readFile(path.join(dir,'comparison-estimates.json'),'utf8'))
const csv='方案,模型估算g,138g标尺折算g,预估省料%,窗口数,累计边界路径mm\n'+data.rows.map(r=>[r.name,r.estimatedGrams.toFixed(2),r.normalized138g.toFixed(2),r.savingPercent.toFixed(2),r.windows,r.perimeterMm.toFixed(0)].join(',')).join('\n')
await fs.writeFile(path.join(dir,'comparison.csv'),'\ufeff'+csv)
const files={'comparison.csv':strToU8('\ufeff'+csv),'comparison-estimates.json':strToU8(JSON.stringify(data,null,2)),
  '说明.txt':strToU8('参考样板为200×200×5mm，PETG、2壁、0.42线宽、10%芯材。保留正面统一使用1mm连续面；另有0.8mm方案。估算不是切片实测。输入138g是归一化标尺，不能视为原项目准确预测。本机Bambu Studio命令行未能产出有效切片结果。请在相同预设下逐个切片后比对本体用量；擦料、支撑、裙边另计。')}
for(const row of data.rows)files[row.id+'.3mf']=await fs.readFile(path.join(dir,row.id+'.3mf'))
for(const name of ['machine','process','filament']){try{files['切片预设/'+name+'.json']=await fs.readFile(path.join(dir,'profiles',name+'.json'))}catch{}}
await fs.writeFile(path.join(dir,'镂空省料比较样板.zip'),zipSync(files,{level:6}))
const safe=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
let illustrations=''
for(const id of ['hex-front','honeycomb-front','honeycomb-24-front','hex-hybrid']){
  const svg=await fs.readFile(path.join(dir,id+'.svg'),'utf8')
  illustrations+=`<figure>${svg}<figcaption>${safe(data.rows.find(r=>r.id===id).name)}<br><small>背面骨架投影，承托薄面另层连续</small></figcaption></figure>`
}
const html=`<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SnapBoard 农场版：镂空省料比较</title>
<style>body{margin:0;background:#101820;color:#e6edf4;font:15px/1.7 system-ui}main{max-width:1120px;margin:40px auto;padding:0 24px}h1{font-size:32px;line-height:1.3}h2{font-size:22px;margin-top:34px}.lead{font-size:18px;color:#bfdfdf}.notice{padding:16px 20px;background:#273244;border-left:4px solid #e7b463;border-radius:8px}.metrics{display:flex;gap:14px;flex-wrap:wrap}.metrics div{background:#172630;border:1px solid #356275;padding:18px 24px;border-radius:12px}.metrics b{display:block;font-size:29px;color:#80decb}a{color:#85e3d7}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}td,th{border-bottom:1px solid #304451;padding:10px 12px;text-align:right}td:first-child,th:first-child{text-align:left}thead{background:#203443}input{max-width:100px;border:1px solid #5a7984;border-radius:6px;color:#f0f8ff;background:#1b2e3a;padding:8px;font-size:16px}.positive{color:#81dec1}.negative{color:#ffb096}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:18px}figure{margin:0;background:#17242e;border-radius:12px;padding:15px}figure svg{width:100%;height:auto}figcaption{font-size:13px}small{color:#94acbb}.scroll{overflow:auto}.formula{font-family:ui-monospace,monospace;padding:16px;background:#172b34;border-radius:8px}.bar{height:5px;background:#283d4c;margin-top:6px}.bar i{display:block;height:5px;background:#73cbbb}footer{margin:36px 0;color:#98afbd}@media(max-width:760px){.grid{grid-template-columns:repeat(2,1fr)}h1{font-size:25px}main{margin:20px auto}.scroll table{min-width:750px}}</style>
<main><small>SnapBoard · farm · 2026-10-02 · 工程估算报告</small><h1>镂空减少了实体体积，<br>耗料却要把墙线和封层算进去。</h1>
<p class="lead">你的实测由 138g 降至 118g，省料 14.49%。本次修复承托层分岛，加入可调细蜂窝、可选内部补强及骨架封盖工艺，比较同尺寸模型。</p>
<div class="metrics"><div>你提供的实测<b>14.49%</b>138 → 118g</div><div>参考板<b>200×200×5</b>mm · PETG · 10%芯材</div><div>预测方法<b>逐层截面</b>墙线 + 实心层 + 剩余填充</div></div>
<p class="notice"><b>表中全是模型估算，不是切片实测。</b>本机 Bambu Studio 02.08.02.60 已尝试离线切片，但命令行初始化未成功，没有有效重量或时间结果。200mm 是参考样板尺寸；你未提供原工程的尺寸，138g 仅用作折算标尺，不代表这些数值就是你那块板的实际重量。可先预留约 ±20% 偏差，再用真实切片校准。</p>
<h2>同等正面外观下比较</h2><p>基准为普通板、同样 1mm 连续正面、10% 芯材。素板对照单独列出，避免把“有图案面层”和“没有面层”混为同一基准。每个模型保留 SnapBoard 自己的长孔、圆孔与开孔状态。</p>
<p>折算基准 <input id="base" type="number" min="1" value="138"> g　耗材单价（示例）<input id="price" type="number" min="0" value="20"> 元/kg</p>
<div class="scroll"><table><thead><tr><th>方案</th><th>模型估算</th><th>基准折算</th><th>预估省料</th><th>每件材料差额</th><th>背面窗口</th></tr></thead><tbody id="rows"></tbody></table></div>
<h2>结果如何使用</h2><p>优先试打保留原圆润主骨架、0.8mm 正面的方案。取消骨架封盖属于另外的切片工艺选择，默认保持关闭；它保留正面和承托层，但不能据此宣称与原实心板等强。24mm 蜂窝比 16mm 版本减少了小窗口墙线，属于新结构验证方案。内部细网补强会增加材料，不能当成必然省料的选项。</p>
<p>0.8mm 正面仅在当前彩色层、承托与打印要求能容纳时采用；软件会检查贴面厚度，不会为了省料裁掉光学层。新结构只验证几何连接与闭合，承载尚需实物试打。</p>
<div class="grid">${illustrations}</div>
<h2>承托修复与编号</h2><p>骨架结束在承托面下面，承托面使用连续截面，不再按每个背面窗口分成岛状零件。功能孔仍贯通；SVG 托底仍按所选外轮廓保留。通过分层区域、体积和闭合网格检查，确认没有把背面窗口复制到承托孔中。</p>
<p>装配编号按背面、侧面、背腔托底选择。侧面刻短板号，薄托底用腔内凸字；板号、方向、品牌、套件码、拼接数字分开。新增导出统计区分实际写入的背面、侧面、托底编号与未写入板号。</p>
<p>同时修复旧项目重开时的 Not manifold：侧边圆头字模使用闭合挤出，避免三角面的 T 型边让整板 3D 更新中断。真实“长亮”工程 11 块板通过重新打开、3D 编号与网格闭合检查，原文件无需重建。<a href="reopen-fixed.jpg">查看主站验证画面</a>。</p>
<h2>估算公式与边界</h2><div class="formula">质量 = 1.27 / 1000 × Σ层厚 × [墙线面积 + 实心面/封层面积 + 10% × 剩余面积]</div>
<p>墙线用逐层截面向内偏移 2×0.42mm 求得；狭窄筋条可能全是墙线，不能乘 10%。顶底层按截面变化识别，显式承托、面层、细节按实心计算。工具还记录累计轮廓长度；重量降低不等于打印时间同比降低，更多小窗口会带来转弯、起停与走线。</p>
<p>报告模型使用 0.20mm 层高、3层顶底、PETG 1.27g/cm³。软件即时估算另在面板明示其默认 0.28mm 假设；换了层高、壁数、喷嘴、支撑或图案堆叠，必须重新估算。没有把未测的擦料、支撑、裙边和时间虚构成精确数值。</p>
<h2>参考压缩包实际内容</h2><p>附件包含 5 个 STL，不是带切片预设的 3MF。它们是 240×240 的板体与不同支柱/安装孔变体；板体 5mm，带支柱最高 12mm。无支柱版本顶面提取到 72个 7×17mm 长孔、4个 10mm 圆孔，未发现可移植的六边形网。细蜂窝由参数算法生成；附件只作结构研究，没有复制其孔径与圆孔位置。</p>
<h2>复核文件</h2><p><a href="镂空省料比较样板.zip">下载比较样板与预设 ZIP</a> · <a href="comparison.csv">完整数值 CSV</a> · <a href="comparison-estimates.json">模型参数与计算记录</a></p>
<p>在相同打印机、耗材和预设下分别导入 3MF，记录本体克数、擦料克数与时间。把普通板重量填入软件估算基准，再用一种骨架方案核对误差；最终省料结论以这一组切片结果为准。</p>
<footer>方法参考：<a href="https://help.prusa3d.com/article/layers-and-perimeters_1748">Prusa 壁层与顶底实心层说明</a>；<a href="https://github.com/bambulab/BambuStudio/wiki/Command-Line-Usage">Bambu Studio 命令行文档</a>。数据为本地几何计算与用户提供的两项实测。</footer></main>
<script>const data=${JSON.stringify(data)};const baseline=data.rows[0].estimatedGrams;function draw(){const base=+document.getElementById('base').value||138,price=+document.getElementById('price').value||0;document.getElementById('rows').innerHTML=data.rows.map(r=>{const grams=base*r.estimatedGrams/baseline,saving=(1-r.estimatedGrams/baseline)*100;return '<tr><td>'+r.name+'<div class="bar"><i style="width:'+Math.min(100,grams/(base*1.2)*100)+'%"></i></div></td><td>'+r.estimatedGrams.toFixed(1)+'g</td><td>'+grams.toFixed(1)+'g</td><td class="'+(saving>=0?'positive':'negative')+'">'+(saving>=0?'省 ':'增 ')+Math.abs(saving).toFixed(1)+'%</td><td>'+((base-grams)*price/1000).toFixed(2)+'元</td><td>'+r.windows+'</td></tr>'}).join('')}document.getElementById('base').oninput=draw;document.getElementById('price').oninput=draw;draw()</script></html>`
await fs.writeFile(path.join(dir,'report.html'),html)
console.log('Comparison report, CSV and model ZIP saved to',dir)
