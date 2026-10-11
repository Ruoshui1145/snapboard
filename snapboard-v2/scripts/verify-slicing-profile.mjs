import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createServer } from 'vite'
import { unzipSync, strFromU8 } from 'fflate'
import { nativeManufactureApi } from './native-manufacture-api.mjs'
import { buildMarkPlan, normalizeOrder, DEFAULT_CODES } from '../../apps/order-workbench/shared/domain.mjs'

const output = '../output/slicing-profile-audit-20261004'
await mkdir(output, { recursive: true })
const server = await createServer({ configFile: false, appType: 'custom', logLevel: 'error', plugins: [nativeManufactureApi()],
  server: { host: '127.0.0.1', port: 0, hmr: false } })
const rows = []
try {
  const [split, lattice, svg, texture, exporter, marking, presets, wood, spatial, layout] = await Promise.all([
    'pegboardSplit', 'openLattice', 'svgLattice', 'boardTexture', 'export3mf', 'assemblyMarking', 'bambuPrinterPresets', 'woodGrain', 'spatialManufacturing', 'spatialLayout',
  ].map(name => server.ssrLoadModule(`/src/utils/${name}.ts`)))
  const cfg = { ...split.PEGBOARD_DEFAULT_CONFIG, thickness: 5, printerPreset: 'bambu-a1', bedW: 256, bedH: 256, bedKeepouts: [], manufacturingChamfer: .25 }
  const base = split.splitOrthogonalPolygon({ points: [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 120 }, { x: 0, y: 120 }], holes: [] }, cfg).panels[0]
  const disabled = { ...marking.createDefaultAssemblyMarking(), enabled: false }
  const plainTexture = { ...texture.createDefaultBoardTexture(), enabled: false, baseInfillDensity: 10 }
  const common = { cfg, panels: [base], boardTexture: plainTexture, assemblyMarking: disabled, placedParts: [], partDefinitions: [] }
  const contexts = config => ({ config, canvas: { width: 2, height: 2 }, pixels: new Uint8ClampedArray([0,0,0,255,255,255,255,255,255,255,255,255,0,0,0,255]),
    lut: { layerCount: 5, layerHeight: .08, colorCount: 2, stacks: new Uint8Array([0,0,0,0,0,1,1,1,1,1]), labs: new Float32Array([0,0,0,100,0,0]), materials: [{ name: 'White', color: '#ffffff' }, { name: 'Black', color: '#111111' }] },
    colors: ['#ffffff', '#111111'], bounds: { minX: 0, minY: 0, maxX: 120, maxY: 120, width: 120, height: 120 },
    structuralThickness: 4, textureThickness: 1, opticalStart: 4.6, samplePitch: 30, recipeCache: new Map(), vectorRegions: null, vectorRegionsMs: 0, contourReports: [], budget: {} })
  const rangesOf = text => [...text.matchAll(/<object id="(\d+)">([\s\S]*?)<\/object>/g)].map(object => ({ object: Number(object[1]),
    ranges: [...object[2].matchAll(/<range min_z="([^"]+)" max_z="([^"]+)"><option opt_key="layer_height">([^<]+)<\/option><\/range>/g)].map(range => ({ lo: Number(range[1]), hi: Number(range[2]), height: Number(range[3]) })) }))
  const inspect = (data, name, expectedPrinter = 'bambu-a1') => {
    const zip = unzipSync(data), settings = JSON.parse(strFromU8(zip['Metadata/project_settings.config']))
    const printer = presets.getBambuPrinterPreset(expectedPrinter), models = strFromU8(zip['Metadata/model_settings.config'])
    assert.equal(settings.layer_height, '0.28', name + ' global process stays coarse')
    assert.equal(settings.printer_settings_id, printer.profile); assert.equal(settings.printer_model, printer.model)
    assert.equal(settings.inherits_group[0], printer.defaultPrintProfile)
    assert.ok(settings.inherits_group.every(value => !value.includes('Extra Fine')), name + ' has no old H2D fine inheritance')
    assert.equal(settings.inherits_group.length, settings.filament_colour.length + 2)
    assert.equal(settings.filament_ids.length, settings.filament_colour.length)
    assert.ok(settings.filament_ids.every(id => id === settings.filament_id))
    if(settings.sparse_infill_density==='100%')assert.equal(settings.sparse_infill_pattern,'zig-zag','fully solid infill needs a supported solid pattern')
    assert.equal(settings.different_settings_to_system.length, settings.inherits_group.length)
    assert.ok(settings.different_settings_to_system[0].split(';').includes('layer_height'))
    for (const kind of ['print', 'printer']) {
      assert.equal(settings[`${kind}_extruder_id`].length, settings[`${kind}_extruder_variant`].length)
      assert.ok(settings[`${kind}_extruder_id`].every(id => Number(id) > 0 && Number(id) <= settings.nozzle_diameter.length))
    }
    for (const part of models.matchAll(/<part\b[\s\S]*?<\/part>/g)) {
      assert.doesNotMatch(part[0], /key="layer_height"/, 'material volumes cannot override whole-board height')
      if(name.startsWith('solid-100')||name.startsWith('solid100-corrected')){
        assert.match(part[0],/key="sparse_infill_density" value="100%"/,'actual material volume must honor the selected solid fill')
        assert.match(part[0],/key="sparse_infill_pattern" value="zig-zag"/)
      }
    }
    const profiles = rangesOf(strFromU8(zip['Metadata/layer_config_ranges.xml']))
    assert.ok(profiles.length > 0, name + ' has explicit print-space Z ranges')
    for (const profile of profiles) {
      assert.ok(profile.ranges.every(range => range.hi > range.lo && range.height > 0 && range.height <= .28))
      for (let i = 1; i < profile.ranges.length; i++) assert.ok(Math.abs(profile.ranges[i - 1].hi - profile.ranges[i].lo) < 1e-5)
      assert.ok(profile.ranges.at(-1).height <= .2, name + ' actual Z top is normal or required material detail')
    }
    const row = { name, printer: settings.printer_settings_id, layerHeight: Number(settings.layer_height), firstLayerHeight: Number(settings.initial_layer_print_height), profiles,
      plateCount: (models.match(/<plate>/g) || []).length, file: name + '.3mf', bytes: data.length, sha256:createHash('sha256').update(data).digest('hex') }
    rows.push(row)
    return { zip, settings, profiles, row }
  }
  const save = async (name, input, method = exporter.createManufacturing3MF) => {
    const result = await method({ ...common, ...input, projectName: name })
    await writeFile(`${output}/${name}.3mf`, result.data)
    console.log('metadata', name)
    const verified = inspect(result.data, name, input?.cfg?.printerPreset || cfg.printerPreset)
    await writeFile(`${output}/metadata-matrix.json`, JSON.stringify({ complete: false, selectedPrintersChecked: presets.BAMBU_PRINTER_PRESETS.map(preset => preset.id), rows }, null, 2))
    return verified
  }
  // Generate only corrected boundary probes while another audit reads the
  // frozen matrix. Never overwrite its files or completion manifest.
  if(process.argv.includes('--corrected-only')){
    for(const [name,changes]of [['solid100-corrected-A1',{boardTexture:{...plainTexture,baseInfillDensity:100}}],['plain3-corrected-A1',{cfg:{...cfg,thickness:3}}]]){
      const result=await exporter.createManufacturing3MF({...common,...changes,projectName:name})
      const checked=inspect(result.data,name)
      if(name.startsWith('plain3'))assert.deepEqual(checked.profiles[0].ranges,[{lo:0,hi:2.49,height:.28},{lo:2.49,hi:2.6,height:.11},{lo:2.6,hi:3,height:.2}])
      await writeFile(`${output}/${name}.3mf`,result.data)
    }
    console.log('PASS corrected solid and 3mm boundary probes; frozen matrix untouched')
    await server.close();process.exit(0)
  }
  for (const preset of presets.BAMBU_PRINTER_PRESETS) {
    const project = JSON.parse(exporter.bambuProjectSettingsJson({ ...cfg, ...presets.splitConfigForPrinter(preset.id) }, ['#ffffff', '#111111'], plainTexture, .25))
    assert.equal(project.printer_settings_id, preset.profile)
    for (const kind of ['print', 'printer']) assert.equal(project[`${kind}_extruder_id`].length, project[`${kind}_extruder_variant`].length)
    assert.ok(project[`${'print'}_extruder_id`].every(id => Number(id) <= project.nozzle_diameter.length))
    assert.equal(project.inherits_group[0], preset.defaultPrintProfile)
    assert.ok(project.different_settings_to_system[0].includes('layer_height'))
  }
  const plain = await save('plain-A1', {})
  assert.deepEqual(plain.profiles[0].ranges, [{ lo: 0, hi: 4.45, height: .28 }, { lo: 4.45, hi: 4.6, height: .15 }, { lo: 4.6, hi: 5, height: .2 }])
  await save('plain-P1S', { cfg: { ...cfg, ...presets.splitConfigForPrinter('bambu-p1s') } })
  await save('solid-100-A1', { boardTexture: { ...plainTexture, baseInfillDensity: 100 } })
  for (const thickness of [3, 4, 8]) await save(`plain-${thickness}mm-A1`, { cfg: { ...cfg, thickness } })
  let through
  for (const style of ['hex', 'honeycomb', 'diamond', 'organic', 'ribs']) {
    const plan = lattice.generateOpenLattice(base, cfg, 3.5, style)
    const open = { ...base, latticeCutouts: plan.holes }
    if (style === 'hex') through = open
    await save(`through-${style}-A1`, { panels: [open] })
    const retained = svg.applyLatticeFrontLayer(base, cfg, plan, 1)
    await save(`retained-${style}-A1`, { panels: [{ ...base, latticeCutouts: retained.holes, latticeFace: retained.face }] })
  }
  const fullBed=split.splitOrthogonalPolygon({points:[{x:0,y:0},{x:220,y:0},{x:220,y:220},{x:0,y:220}],holes:[]},cfg).panels[0]
  const fullBedPlan=lattice.generateOpenLattice(fullBed,cfg,3.5,'honeycomb')
  await save('full-bed-through-honeycomb-A1',{panels:[{...fullBed,latticeCutouts:fullBedPlan.holes}]})
  const fullBedRetained=svg.applyLatticeFrontLayer(fullBed,cfg,fullBedPlan,1)
  await save('full-bed-retained-honeycomb-A1',{panels:[{...fullBed,latticeCutouts:fullBedRetained.holes,latticeFace:fullBedRetained.face}]})
  const six = Array.from({ length: 6 }, (_, index) => ({ ...base, id: `audit-${index}`, w: 200, h: 200, contour: undefined, slots: [], round_holes: [], edge_holes: [] }))
  const allPlates = await save('six-plates-A1', { panels: six })
  assert.equal(allPlates.row.plateCount, 6, 'all-plates estimates must be separated from per-plate estimates')
  for (const finish of ['textured-pei', 'smooth-top']) {
    const config = { ...plainTexture, enabled: true, source: 'preset', surfaceMode: 'snapcolor', surfaceFinish: finish, textureThickness: 1, edgeSealEnabled: false }
    const color = await save(`snapcolor-${finish}-A1`, { boardTexture: config, sharedTextureContext: contexts(config) })
    const optical = color.profiles[0].ranges.filter(range => range.height === .08)
    assert.equal(optical.length, 1); assert.ok(Math.abs(optical[0].hi - optical[0].lo - .4) < 1e-5)
    assert.equal(color.settings.initial_layer_print_height, finish === 'textured-pei' ? '0.08' : '0.25')
    if (finish === 'textured-pei') await save('snapcolor-stream-A1', { boardTexture: config, sharedTextureContext: contexts(config) }, exporter.createManufacturing3MFStreamed)
  }
  const dual = { ...plainTexture, enabled: true, source: 'preset', backEnabled: true, backImageDataUrl: 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#ffffff"/></svg>').toString('base64'), surfaceMode: 'snapcolor', textureThickness: 1, edgeSealEnabled: false }
  const double = await save('double-snapcolor-A1', { boardTexture: dual, sharedTextureContext: contexts(dual), sharedBackTextureContext: contexts(dual) })
  assert.equal(double.profiles[0].ranges.filter(range => range.height === .08).length, 2)
  for (const goal of ['standard', 'frosted', 'clear-experimental']) {
    const config = { ...plainTexture, enabled: true, source: 'preset', surfaceMode: 'veneer', surfaceMaterialKind: 'transparent-petg', surfacePrintGoal: goal, textureThickness: 1 }
    const veneer = await save(`veneer-${goal}-A1`, { boardTexture: config, sharedTextureContext: contexts(config) })
    assert.ok(veneer.profiles[0].ranges.filter(range => range.height === .28).reduce((sum, range) => sum + range.hi - range.lo, 0) >= 3.2, 'the 4mm substrate retains a coarse majority outside its short interface transition and Z-top')
    if (goal === 'clear-experimental') assert.ok(veneer.profiles[0].ranges.filter(range => range.height === .1).every(range => range.hi <= 1 + 1e-5), 'transparent detail is confined to the actual bed-facing veneer')
  }
  const woodTexture = { ...plainTexture, enabled: true, surfaceMode: 'woodgrain', textureThickness: 1, woodGrain: { ...wood.DEFAULT_WOOD_GRAIN } }
  const grain = await save('woodgrain-A1', { boardTexture: woodTexture })
  assert.deepEqual(grain.profiles[0].ranges, [{ lo: 0, hi: 3.84, height: .28 }, { lo: 3.84, hi: 4, height: .16 }, { lo: 4, hi: 4.88, height: .08 }, {lo:4.88,hi:5,height:.12}])
  const plaGrain=await save('woodgrain-PLA-A1',{boardTexture:{...woodTexture,woodGrain:{...wood.DEFAULT_WOOD_GRAIN,filamentType:'PLA'}}})
  assert.deepEqual(plaGrain.settings.filament_ids,['GFA00','GFA00'])
  const zipped = await exporter.createManufacturing3MF({ ...common, panels: [base, { ...base, id: 'p2', x: 140, slots: [], edge_holes: [] }], outputMode: 'perPanel' })
  await writeFile(`${output}/per-panel-A1.zip`, zipped.data)
  let panelIndex=0
  for (const [, data] of Object.entries(unzipSync(zipped.data)).filter(([name]) => name.endsWith('.3mf'))) {
    const name=`per-panel-${++panelIndex}-A1`
    await writeFile(`${output}/${name}.3mf`,data);inspect(data,name)
  }
  const mono = await spatial.createSpatialManufacturing3MF({ cfg, layout: { ...layout.DEFAULT_SPATIAL_LAYOUT, enabled: true, template: 'L', manufacturingMode: 'monolithic', width: 70, depth: 55, height: 35, thickness: 5 }, projectName: 'spatial-L-A1', assemblyMarking: disabled })
  await writeFile(`${output}/spatial-L-A1.3mf`, mono.data)
  const lShape = inspect(mono.data, 'spatial-L-A1')
  assert.ok(lShape.profiles[0].ranges.at(-1).hi > 20, 'upright spatial Z height differs from the 5mm wall thickness')
  for(const template of ['U','prism']){
    const name=`spatial-${template}-A1`
    const model=await spatial.createSpatialManufacturing3MF({cfg,layout:{...layout.DEFAULT_SPATIAL_LAYOUT,enabled:true,template,manufacturingMode:'monolithic',width:70,depth:55,height:35,thickness:5},projectName:name,assemblyMarking:disabled})
    assert.ok(model.fileName.endsWith('.3mf'))
    await writeFile(`${output}/${name}.3mf`,model.data);inspect(model.data,name)
  }
  const perFace=await spatial.createSpatialManufacturing3MF({cfg,layout:{...layout.DEFAULT_SPATIAL_LAYOUT,enabled:true,template:'L',manufacturingMode:'per-face',width:110,depth:70,height:160,thickness:5},projectName:'spatial-per-face',assemblyMarking:disabled})
  await writeFile(`${output}/spatial-per-face-A1.zip`,perFace.data)
  let faceIndex=0
  for(const [,data]of Object.entries(unzipSync(perFace.data)).filter(([name])=>name.endsWith('.3mf'))){
    const name=`spatial-per-face-${++faceIndex}-A1`
    await writeFile(`${output}/${name}.3mf`,data);inspect(data,name)
  }
  assert.ok(faceIndex>=2,'flat spatial boards and printed connectors both carry complete profiles')
  const sampling={...plainTexture,enabled:true,source:'preset',surfaceMode:'snapcolor',surfaceFinish:'textured-pei',textureThickness:1,edgeSealEnabled:false}
  const samples=await save('snapcolor-sampling-A1',{boardTexture:sampling,sharedTextureContext:contexts(sampling),textureSampling:{sizeMm:20,locations:[{panelIndex:0,x:60,y:60}]}})
  assert.ok(samples.profiles.length>=2,'sampling retains its own actual Z profile alongside the complete original board')
  const normalized = normalizeOrder({ customer: { name: 'PRIVATE' }, product: { name: 'PRIVATE', layoutCode: 'F', mappingCode: 'M0', colourCode: 'C00', widthMm: through.w, heightMm: through.h, thicknessMm: 5 }, kitQuantity: 1,
    panels: [{ code: 'P01', quantity: 1, widthMm: through.w, heightMm: through.h, sourcePanelId: through.id }], designFingerprint: 'd'.repeat(64) }, DEFAULT_CODES)
  const orderPlan = { ...buildMarkPlan({ ...normalized, number: 'SB-20261004-0090', markingKey: '2610040090', revision: 2 }), designFingerprint: normalized.designFingerprint, kitQuantity: 1, perSetPanelCount: 1, totalPanelCount: 1 }
  const orderInput = { panels: [through], orderEngraving: orderPlan, orderInstance: orderPlan.panels[0], assemblyMarking: disabled }
  const browser = await save('order-through-browser-A1', orderInput)
  const streamOrder = await save('order-through-stream-A1', orderInput, exporter.createManufacturing3MFStreamed)
  assert.deepEqual(browser.profiles, streamOrder.profiles, 'native/stream order delegation retains side engraving ranges while assembly numbering is disabled')
  assert.ok(browser.profiles[0].ranges.some(range => range.height === .2 && range.lo < 1 && range.hi > 4), 'side glyphs require local normal layers, not an entire-board 0.08 profile')
  await writeFile(`${output}/metadata-matrix.json`, JSON.stringify({ complete: false, pending: 'real-native-http', selectedPrintersChecked: presets.BAMBU_PRINTER_PRESETS.map(preset => preset.id), rows }, null, 2))
  await server.listen()
  const endpoint = `http://127.0.0.1:${server.httpServer.address().port}/api/native-manufacture`
  const nativeExport = async (input, name, isOrder = false) => {
    const submitted = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...common, ...input }) })
    const job = await submitted.json(); assert.ok(submitted.ok, job.error)
    let state
    for (let attempt = 0; attempt < 180; attempt++) {
      state = await (await fetch(`${endpoint}?job=${job.jobId}`)).json()
      if (state.error) throw new Error(state.error)
      if (!state.running) break
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    assert.equal(state.running, false)
    const bytes = new Uint8Array(await (await fetch(`${endpoint}?job=${job.jobId}&result=1`)).arrayBuffer())
    let board = bytes
    if (isOrder) {
      await writeFile(`${output}/${name}.zip`, bytes)
      const orders = Object.entries(unzipSync(bytes)).filter(([filename]) => filename.endsWith('.3mf'))
      assert.equal(orders.length, 1); board = orders[0][1]
    }
    await writeFile(`${output}/${name}.3mf`, board)
    return inspect(board, name)
  }
  const bareNative = await nativeExport({ boardTexture: undefined }, 'plain-native-A1')
  assert.deepEqual(bareNative.profiles, plain.profiles, 'the native job API accepts an actual bare board without a texture renderer')
  const native = await nativeExport({ panels: [through], orderEngraving: orderPlan, assemblyMarking: disabled }, 'order-through-native-A1', true)
  assert.deepEqual(native.profiles, browser.profiles, 'the real native job API keeps the same actual side-glyph Z ranges')
  await writeFile(`${output}/metadata-matrix.json`, JSON.stringify({ complete: true, selectedPrintersChecked: presets.BAMBU_PRINTER_PRESETS.map(preset => preset.id), rows }, null, 2))
  console.log('PASS slicing metadata matrix: actual print-space material ranges, normal Z-top, machine inheritance, single/per-panel/stream/native orders with assembly disabled, spatial geometry preserved', { cases: rows.length })
} finally { await server.close() }
