import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, readdir, copyFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'

// Exercise the actual installed slicer, including its final project save. Never print.
const executable = 'D:/Bambu Studio/bambu-studio.exe'
const reportOption = process.argv.find(argument => argument.startsWith('--report-dir='))
const reports = path.resolve(reportOption ? reportOption.slice('--report-dir='.length) : '../output/slicing-profile-audit-20261004/roundtrip')
const inputs = process.argv.slice(2).filter(argument => !argument.startsWith('--report-dir='))
assert.ok(inputs.length > 0, 'Supply freshly generated manufacturing 3MF paths')
await mkdir(reports, { recursive: true })
for (const inputName of inputs) {
  const input = path.resolve(inputName), bytes = await readFile(input)
  const zip = unzipSync(bytes), settings = JSON.parse(strFromU8(zip['Metadata/project_settings.config']))
  assert.equal(settings.filament_ids.length, settings.filament_colour.length, 'Every selected material requires a non-empty ID slot')
  assert.ok(settings.filament_ids.every(id => typeof id === 'string' && id.length))
  const scratch = await mkdtemp(path.join(tmpdir(), 'snapboard-roundtrip-'))
  const destination = path.join(reports, path.parse(input).name)
  await mkdir(destination, { recursive: true })
  await writeFile(path.join(scratch, 'input.3mf'), bytes)
  const argumentsList = ['--datadir', scratch, '--slice', '0', '--skip-useless-pick', '--debug', '2', '--outputdir', scratch, '--export-3mf', 'sliced.3mf', path.join(scratch, 'input.3mf')]
  await writeFile(path.join(scratch, 'spec.json'), JSON.stringify({ executable, argumentsList }))
  const driver = `$ErrorActionPreference = 'Stop'
$roundtripRoot = '${scratch.replaceAll("'", "''")}'
$roundtripSpec = Get-Content -LiteralPath (Join-Path $roundtripRoot 'spec.json') -Raw | ConvertFrom-Json
$roundtripJob = Start-Process -FilePath $roundtripSpec.executable -ArgumentList ([string[]]$roundtripSpec.argumentsList) -WorkingDirectory $roundtripRoot -WindowStyle Hidden -PassThru
$null = $roundtripJob.Handle
$roundtripDone = $roundtripJob.WaitForExit(60000)
$roundtripCode = $(if ($roundtripDone) { $roundtripJob.ExitCode } else { $null })
$roundtripJob.Refresh()
$roundtripEvidence = [PSCustomObject]@{ exitCode = $roundtripCode; timedOut = -not $roundtripDone; cpuSeconds = $roundtripJob.TotalProcessorTime.TotalSeconds; workingSetBytes = $roundtripJob.WorkingSet64; windowTitle = $roundtripJob.MainWindowTitle; version = (Get-Item -LiteralPath $roundtripSpec.executable).VersionInfo.FileVersion }
if (-not $roundtripDone) { Stop-Process -Id $roundtripJob.Id -Force }
$roundtripEvidence | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $roundtripRoot 'process.json') -Encoding UTF8
`
  const started = Date.now()
  const processResult = await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', driver], { cwd: scratch, windowsHide: true })
    let log = ''
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk })
    child.once('error', reject)
    child.once('exit', code => resolve({ driverCode: code, log }))
  })
  const files = await readdir(scratch)
  for (const filename of files) if (/\.(3mf|gcode|json)$/.test(filename)) await copyFile(path.join(scratch, filename), path.join(destination, filename))
  assert.ok(scratch.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(scratch).startsWith('snapboard-roundtrip-'))
  await rm(scratch, { recursive: true, force: true })
  const native = JSON.parse((await readFile(path.join(destination, 'process.json'), 'utf8')).replace(/^\uFEFF/, ''))
  const result = files.includes('result.json') ? JSON.parse(await readFile(path.join(destination, 'result.json'), 'utf8')) : null
  const roundtrip = files.includes('sliced.3mf') ? unzipSync(await readFile(path.join(destination, 'sliced.3mf'))) : {}
  const plateFiles = files.filter(filename => /^plate_\d+\.gcode$/.test(filename))
  const declaredProfiles = [...strFromU8(zip['Metadata/layer_config_ranges.xml']).matchAll(/<object id="(\d+)">([\s\S]*?)<\/object>/g)].map(object => ({ object: Number(object[1]), ranges: [...object[2].matchAll(/<range min_z="([^"]+)" max_z="([^"]+)"><option opt_key="layer_height">([^<]+)<\/option><\/range>/g)].map(range => ({ lo: Number(range[1]), hi: Number(range[2]), height: Number(range[3]) })) }))
  const uniqueProfiles = [...new Map(declaredProfiles.map(profile => [JSON.stringify(profile.ranges), profile.ranges])).values()]
  const plates = await Promise.all(plateFiles.map(async filename => {
    const gcode = await readFile(path.join(destination, filename), 'utf8')
    const layers = [...gcode.matchAll(/; Z_HEIGHT:\s*([\d.]+)\r?\n; LAYER_HEIGHT:\s*([\d.]+)/g)].map(match => ({ z: Number(match[1]), height: Number(match[2]) }))
    const sourcePlate = result?.sliced_plates?.find(plate => plate.id === Number(filename.match(/\d+/)[0]))
    const expectedTopZ = sourcePlate?.objects?.length ? Math.max(...sourcePlate.objects.map(object => object.bbox.z + object.bbox.height)) : null
    const fineCoverage = uniqueProfiles.length === 1 ? uniqueProfiles[0].filter(range => range.height < .28 - 1e-5).map(range => {
      const actual = layers.filter(layer => layer.z - layer.height / 2 >= range.lo - 1e-5 && layer.z - layer.height / 2 < range.hi - 1e-5)
      return { ...range, actualLayerCount: actual.length, minimumLayerCount: Math.floor((range.hi - range.lo) / range.height + 1e-5), heightsMatch: actual.every(layer => Math.abs(layer.height - range.height) < 1e-5) }
    }) : []
    const layerCount = Number(gcode.match(/; total layer number:\s*(\d+)/)?.[1])
    const globalLayerHeight = Number(gcode.match(/; layer_height = ([^\r\n]+)/)?.[1])
    const profilePassed = globalLayerHeight === .28 && layerCount === layers.length && expectedTopZ !== null && Math.abs(layers.at(-1)?.z - expectedTopZ) < 1e-4 && layers.slice(-2).every(layer => layer.height <= .2 + 1e-5) && fineCoverage.every(range => range.heightsMatch && range.actualLayerCount >= range.minimumLayerCount)
    return { filename, layerCount: layers.length, topZ: layers.at(-1)?.z, expectedTopZ, lastLayers: layers.slice(-2), fineCoverage, globalLayerHeight, profilePassed, modelSeconds: sourcePlate?.main_predication, totalSeconds: sourcePlate?.total_predication, grams: sourcePlate?.filaments?.reduce((sum, filament) => sum + filament.total_used_g, 0) }
  }))
  const passed = processResult.driverCode === 0 && native.exitCode === 0 && !native.timedOut && result?.return_code === 0 && Boolean(roundtrip['3D/3dmodel.model']) && plateFiles.length > 0
  const profilesPassed = passed && plates.every(plate => plate.profilePassed)
  const report = { input, inputSha256: createHash('sha256').update(bytes).digest('hex'), elapsedMs: Date.now() - started, executable, argumentsList, ...native, driverCode: processResult.driverCode, passed, profilesPassed, declaredProfiles, plates, roundtripEntries: Object.keys(roundtrip), result }
  await writeFile(path.join(destination, 'audit-report.json'), JSON.stringify(report, null, 2))
  await writeFile(path.join(destination, 'driver.log'), processResult.log)
  console.log(JSON.stringify({ input: path.basename(input), passed, profilesPassed, elapsedMs: report.elapsedMs, exitCode: native.exitCode, timedOut: native.timedOut, plates: plates.map(({fineCoverage, ...plate}) => plate) }))
  if (!profilesPassed) process.exitCode = 1
}
