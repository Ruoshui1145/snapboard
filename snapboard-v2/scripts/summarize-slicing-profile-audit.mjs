import assert from 'node:assert/strict'
import { readFile,writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { unzipSync,strFromU8 } from 'fflate'
import { linearExtrusionSegments } from './slicing-gcode-stats.mjs'

const root='../output/slicing-profile-audit-20261004'
const json=async file=>JSON.parse(await readFile(`${root}/${file}`,'utf8'))
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const geometryHash=zip=>hash(Object.keys(zip).filter(name=>name.endsWith('.model')).sort().map(name=>name+'\n'+strFromU8(zip[name])).join('\n'))
const matrix=await json('metadata-matrix.json')
assert.equal(matrix.complete,true)
const rows=[]
for(const row of matrix.rows){
  const input=await readFile(`${root}/${row.file}`),report=await json(`roundtrip/${row.name}/audit-report.json`)
  assert.equal(hash(input),row.sha256,row.name+' metadata input must remain current')
  assert.equal(report.inputSha256,row.sha256,row.name+' CLI evidence must use that exact input')
  assert.equal(report.passed,true,row.name+' must slice and re-save, not merely create a Gcode before a timeout')
  assert.equal(report.profilesPassed,true,row.name+' actual layers must match height, fine intervals and normal Z top')
  const project=JSON.parse(strFromU8(unzipSync(input)['Metadata/project_settings.config']))
  assert.equal(project.printer_settings_id,row.printer)
  const plates=[]
  for(const plate of report.plates){
    const gcode=await readFile(`${root}/roundtrip/${row.name}/${plate.filename}`)
    plates.push({...plate,gcodeSha256:hash(gcode),linearSegments:linearExtrusionSegments(gcode.toString('utf8'))})
  }
  const saved=await readFile(`${root}/roundtrip/${row.name}/sliced.3mf`)
  rows.push({...row,roundtripSha256:hash(saved),cliVersion:report.version,plates,allPlatesTotalSeconds:plates.reduce((sum,plate)=>sum+plate.totalSeconds,0)})
}
const additionalGroups=[]
for(const group of (await json('final-roundtrip-summary.json')).groups.filter(group=>group.group!=='export-modes')){
  const directory=group.group==='printer-models'?'machines':'actual-native-order'
  const additionalRows=[]
  assert.equal(group.passed,true)
  for(const row of group.rows){
    const input=await readFile(`${root}/${directory}/${row.file}`),name=row.file.slice(0,-4),report=await json(`roundtrip/${name}/audit-report.json`)
    assert.equal(hash(input),row.sha256)
    assert.equal(report.inputSha256,row.sha256)
    assert.equal(report.passed,true);assert.equal(report.profilesPassed,true)
    const project=JSON.parse(strFromU8(unzipSync(input)['Metadata/project_settings.config']))
    const plates=[]
    for(const plate of report.plates)plates.push({...plate,gcodeSha256:hash(await readFile(`${root}/roundtrip/${name}/${plate.filename}`))})
    additionalRows.push({...row,inputFile:`${directory}/${row.file}`,printer:project.printer_settings_id,plates,roundtripSha256:hash(await readFile(`${root}/roundtrip/${name}/sliced.3mf`))})
  }
  additionalGroups.push({group:group.group,count:additionalRows.length,passed:true,rows:additionalRows})
}
const controls=[]
for(const control of await json('controlled-fine-inputs.json')){
  const original=await readFile(`${root}/${control.original}`),input=await readFile(`${root}/${control.file}`)
  const report=await json(`sliced/${control.file.slice(0,-4)}/audit-report.json`)
  assert.equal(hash(original),control.originalSha256)
  assert.equal(hash(input),control.sha256)
  assert.equal(report.inputSha256,control.sha256)
  assert.equal(geometryHash(unzipSync(original)),control.geometrySha256)
  assert.equal(geometryHash(unzipSync(input)),control.geometrySha256)
  assert.equal(report.controlledSimulationValidated,true)
  assert.equal(report.profileValidated,false,'all-board fine simulation must never be called a corrected production profile')
  const plates=[]
  for(const plate of report.gcodes){
    const gcode=await readFile(`${root}/sliced/${control.file.slice(0,-4)}/${plate.filename}`)
    plates.push({...plate,gcodeSha256:hash(gcode),linearSegments:linearExtrusionSegments(gcode.toString('utf8'))})
  }
  controls.push({...control,plates})
}
const totalCases=rows.length+additionalGroups.reduce((sum,group)=>sum+group.count,0)
const summary={format:'snapboard-slicing-audit',version:1,completedAtBeijing:new Date().toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'}),cliVersion:rows[0].cliVersion,complete:true,totalCases,metadataPrinterCount:matrix.selectedPrintersChecked.length,actualPrinterProfiles:[...new Set([...rows,...additionalGroups.flatMap(group=>group.rows)].map(row=>row.printer))],rows,additionalGroups,controls,physicalPrintingVerified:false}
await writeFile(`${root}/final-audit.json`,JSON.stringify(summary,null,2))
const duration=seconds=>{const value=Math.round(seconds);return `${Math.floor(value/3600)}:${String(Math.floor(value%3600/60)).padStart(2,'0')}:${String(value%60).padStart(2,'0')}`}
const fixed=value=>Number(value).toFixed(2)
const fullBed=rows.filter(row=>row.name.startsWith('full-bed-'))
const plateRow=(name,plate)=>`| ${name} | ${plate.layerCount} | ${plate.topZ} | ${duration(plate.totalSeconds)} | ${fixed(plate.grams??plate.filamentGrams)} | ${plate.linearSegments.linearExtrusionMoves} | ${plate.linearSegments.shortLinearMoves} |`
const six=rows.find(row=>row.name==='six-plates-A1')
const markdown=`# 切片配置审计 · 2026-10-04

当前 ${totalCases} 份终版导出均通过本机 Bambu Studio ${summary.cliVersion} 的真实切片、3MF 重保存及层高核验：${rows.length} 个导出模式样本、14 个打印机项目、3 个真实五料卷 LUT 的 native 订单/配件样本。每份输入、Gcode 和重保存 3MF 的 SHA-256 见 [final-audit.json](final-audit.json)；检查会拒绝旧输入或旧 Gcode。未封包、未发送到打印机。

## 根因与修复

- 普通板克隆的工艺仍继承“0.08mm Extra Fine @BBL H2D”，同时改机型名字却保留 H2D 喷嘴向量；自定义层高未进入系统差异清单。现按选中的完整机型模板输出，主体 0.28 mm，并显式保留工艺差异。
- 层高放在材质 volume 中不能表达局部 Z 层高；改为打印方向下真实高度范围。朝下/朝上的 SnapColor 光学层各保留完整 5 × 0.08 mm，其他主体不跟随细层。
- 粗层跨过材料起点会吞掉部分光学层；现用合法短过渡精确落到界面。普通 5 mm 板最后两层 0.2 mm，19 层到 Z=5.0；3 mm 板最后两层 0.2 mm，12 层到 Z=3.0。木纹 1 mm 贴面为 11 × 0.08 + 0.12 mm，到 Z=5.0；订单侧字用局部 0.2 mm，24 层到 Z=5.0，关闭普通装配编号也有效。
- 一体立体导出原来没有切片工艺元数据，容易沿用切片器当前细层。现使用同一机型工艺与真实立体 Z 高度；35 mm 高样本到 Z=35.0，而非按 5 mm 壁厚做高度配置。
- 重保存缺 filament_ids 材质槽向量，CLI 在切片后索引空数组停住。已按真实 PLA / PETG 档案 ID 补齐，终版重保存全通过；旧 timeout/OOM 证据保留在诊断目录，不能当通过。
- 100% 全局填充被裸板实体的默认 10% 覆盖，且 100% gyroid 被校验拒绝。实体与全局现一致采用 100% 合法 zig-zag；120 mm 对照实心 ${fixed(rows.find(row=>row.name==='solid-100-A1').plates[0].grams)} g，10% ${fixed(rows.find(row=>row.name==='plain-A1').plates[0].grams)} g，真实耗材量已不同。

## 220 × 220 × 5 mm 满床蜂窝 · 单盘

以下全细层是受控模拟：与当前板件完全相同的 XYZ、三角面和摆放，只改为全板 0.08 mm，首层仍 0.25 mm。它不是用户截图的原工程，也不是生产输出。未提高速度或最大体积流量。

| 样本 | 层数 | 最后 Z/mm | 单盘预测时间 h:mm:ss | 耗材/g | 正挤出直线段 | 其中短于 0.42 mm |
| --- | ---: | ---: | --- | ---: | ---: | ---: |
${fullBed.map(row=>plateRow(row.name,row.plates[0])).join('\n')}
${controls.map(row=>plateRow('模拟全板0.08 · '+(row.original.includes('retained')?'1mm承托':'完全贯通'),row.plates[0])).join('\n')}

短段统计只统计正挤出 XY G0/G1，排除 Custom/Flush/Undefined；G2/G3 更新坐标但不把圆弧弦长计作直线。圆弧离散后的连续短段也计入，不能直接等同有害碎线/色斑。分特征计数见 JSON。该同网格对照说明不必要的全板细层会显著增加轮廓和 gap infill 走线；不据此承诺用户原件相同时间。

## 六盘时间口径

同工程 6 份 200 × 200 × 5 mm 普通板，各盘时间独立如下，独立求和为 ${duration(six.allPlatesTotalSeconds)}。这只是测试工程的口径演示。用户截图有 All Plates Stats 按钮和多盘，仍不能证明浮层显示的 10–13 小时是总计；原工程未提供，不能直接均分。

| 测试盘 | 层数 | 最后 Z/mm | 本盘时间 h:mm:ss | 本盘耗材/g |
| --- | ---: | ---: | --- | ---: |
${six.plates.map(plate=>`| ${plate.filename} | ${plate.layerCount} | ${plate.topZ} | ${duration(plate.totalSeconds)} | ${fixed(plate.grams)} |`).join('\n')}

## 覆盖与边界

${matrix.selectedPrintersChecked.length} 个机型完成配置元数据断言，全部也经过真实原生切片与重保存：${summary.actualPrinterProfiles.join('、')}。配置保留设计器所选机型，没有用固定 P1S 配置冒充 A1；这是各机型的离线切片工程验证，没有操作任何实体打印机。

真实闭环覆盖普通/100% 实心/3、4、5、8 mm，hex/honeycomb/diamond/organic/ribs 完全贯通与 1 mm 承托，220 mm 满床，单/双面叠色、正反打印方向、普通/磨砂/实验透明贴面、PETG/PLA 木纹，一体 L/U/棱柱、按面平放与实体连接件，单文件、逐板 ZIP 解包项、试样与完整原板、流式及实际 native HTTP 裸板/逐实物订单；订单普通编号关闭时仍包含实际侧字需要的 Z 带。

| 输入 | 盘数 | 实际层数（逐盘） | 实际顶 Z（逐盘） | 预测总计 h:mm:ss |
| --- | ---: | --- | --- | --- |
${rows.map(row=>`| ${row.name} | ${row.plates.length} | ${row.plates.map(plate=>plate.layerCount).join('/')} | ${row.plates.map(plate=>plate.topZ).join('/')} | ${duration(row.allPlatesTotalSeconds)} |`).join('\n')}

本矩阵采用隔离虚构模型/订单，不创建生产记录，不包含客户私有字段。合成叠色样本用于层高边界验证，不替代真实耗材 LUT 的颜色校准。实体强度、孔位配合、侧字可读性、透明效果、双面结合与实际耗材可达流量仍需实物试打；切片器预测不是实测打印时间。封包许可由主任务处理，本报告不触发封包或发布。
`
await writeFile(`${root}/README.md`,markdown)
console.log('PASS fresh SHA-linked complete slicing/re-save audit', {cases:totalCases,exportModes:rows.length,printers:summary.actualPrinterProfiles.length,controls:controls.length})
