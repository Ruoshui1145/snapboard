import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile, readdir, copyFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { unzipSync, strFromU8 } from 'fflate'
import { linearExtrusionSegments } from './slicing-gcode-stats.mjs'

// Existing local Bambu installation; only estimate and export files, never send to a printer.
const executable = 'D:/Bambu Studio/bambu-studio.exe'
const root = path.resolve('../output/slicing-profile-audit-20261004')
for (const argument of process.argv.slice(2)) {
  const input = path.resolve(argument), name = path.parse(input).name
  const inputBytes = await readFile(input)
  const output = path.join(root, 'sliced', name)
  await mkdir(output, { recursive: true })
  try { await copyFile(path.join(output, 'audit-report.json'), path.join(output, `previous-attempt-${Date.now()}.json`)) } catch {}
  // Keep native CLI evidence in a fresh ASCII directory, independent of GUI data and prior outputs.
  const scratch = await mkdtemp(path.join(tmpdir(), 'snapboard-slicer-audit-'))
  await writeFile(path.join(scratch, 'input.3mf'), inputBytes)
  const args = ['--datadir', scratch, '--slice', '0', '--skip-useless-pick', '--debug', '2', '--outputdir', scratch, path.join(scratch, 'input.3mf')]
  await writeFile(path.join(scratch, 'cli-spec.json'), JSON.stringify({ executable, args }))
  const driver = `$ErrorActionPreference = 'Stop'
$sliceRoot = '${scratch.replaceAll("'", "''")}'
$sliceSpec = Get-Content -LiteralPath (Join-Path $sliceRoot 'cli-spec.json') -Raw | ConvertFrom-Json
$sliceJob = Start-Process -FilePath $sliceSpec.executable -ArgumentList ([string[]]$sliceSpec.args) -WorkingDirectory $sliceRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $sliceRoot 'stdout.log') -RedirectStandardError (Join-Path $sliceRoot 'stderr.log') -PassThru
$null = $sliceJob.Handle
$sliceDone = $sliceJob.WaitForExit(120000)
$sliceExitCode = $(if ($sliceDone) { $sliceJob.ExitCode } else { $null })
$sliceJob.Refresh()
$sliceDiagnostic = [PSCustomObject]@{ exitCode = $sliceExitCode; timedOut = -not $sliceDone; windowTitle = $sliceJob.MainWindowTitle; cpuSeconds = $sliceJob.TotalProcessorTime.TotalSeconds; workingSetBytes = $sliceJob.WorkingSet64 }
if (-not $sliceDone) { Stop-Process -Id $sliceJob.Id -Force }
$sliceDiagnostic | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $sliceRoot 'process-result.json') -Encoding UTF8
`
  await writeFile(path.join(scratch, 'run-slice.ps1'), driver)
  const run = await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', driver], { windowsHide: true, cwd: scratch })
    let log = '', timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, 130_000)
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk.toString() })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('exit', code => { clearTimeout(timer); resolve({ code, timedOut, log }) })
  })
  const newOutputFiles = await readdir(scratch)
  for (const filename of newOutputFiles) if (/\.(?:3mf|gcode|json|log)$/.test(filename)) await copyFile(path.join(scratch, filename), path.join(output, filename))
  if (!scratch.startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(scratch).startsWith('snapboard-slicer-audit-')) throw new Error('Unexpected slicer test directory')
  await rm(scratch, { recursive: true, force: true })
  await writeFile(path.join(output, 'cli.log'), run.log)
  const report = { input, inputSha256: createHash('sha256').update(inputBytes).digest('hex'), executable, args, driverExitCode: run.code, timedOut: run.timedOut, outputFiles: newOutputFiles }
  if (newOutputFiles.includes('process-result.json')) Object.assign(report, JSON.parse((await readFile(path.join(output, 'process-result.json'), 'utf8')).replace(/^\uFEFF/, '')))
  if (newOutputFiles.includes('result.json')) try { report.result = JSON.parse(await readFile(path.join(output, 'result.json'), 'utf8')) } catch {}
  const inputZip = unzipSync(inputBytes)
  report.projectSettings = JSON.parse(strFromU8(inputZip['Metadata/project_settings.config']))
  const profiles = [...strFromU8(inputZip['Metadata/layer_config_ranges.xml']).matchAll(/<object id="(\d+)">([\s\S]*?)<\/object>/g)].map(object => ({ object: Number(object[1]),
    ranges: [...object[2].matchAll(/<range min_z="([^"]+)" max_z="([^"]+)"><option opt_key="layer_height">([^<]+)<\/option><\/range>/g)].map(range => ({ lo: Number(range[1]), hi: Number(range[2]), height: Number(range[3]) })) }))
  report.declaredProfiles = profiles
  const seconds = value => [...(value || '').matchAll(/([\d.]+)\s*([hms])/g)].reduce((sum, match) => sum + Number(match[1]) * ({ h: 3600, m: 60, s: 1 }[match[2]]), 0)
  report.gcodes = await Promise.all(newOutputFiles.filter(filename => filename.endsWith('.gcode')).map(async filename => {
    const text = await readFile(path.join(output, filename), 'utf8')
    const layers = [...text.matchAll(/; Z_HEIGHT:\s*([\d.]+)\r?\n; LAYER_HEIGHT:\s*([\d.]+)/g)].map(match => ({ z: Number(match[1]), height: Number(match[2]) }))
    const time = text.match(/; model printing time:\s*([^;\r\n]+); total estimated time:\s*([^\r\n]+)/)
    const fineCoverage = profiles.length === 1 ? profiles[0].ranges.filter(range => range.height < .28 - 1e-5).map(range => {
      const actual = layers.filter(layer => layer.z - layer.height / 2 >= range.lo - 1e-5 && layer.z - layer.height / 2 < range.hi - 1e-5)
      return { ...range, actualLayerCount: actual.length, minimumLayerCount: Math.floor((range.hi - range.lo) / range.height + 1e-5), heightsMatch: actual.every(layer => Math.abs(layer.height - range.height) < 1e-5) }
    }) : []
    return { filename, layers, fineCoverage, layerCount: Number(text.match(/; total layer number:\s*(\d+)/)?.[1] || layers.length), topZ: layers.at(-1)?.z,
      modelSeconds: time ? seconds(time[1]) : null, totalSeconds: time ? seconds(time[2]) : null, lastLayers: layers.slice(-3),
      filamentGrams:Number(text.match(/; total filament weight \[g\]\s*:\s*([\d.]+)/)?.[1]),
      linearSegments:linearExtrusionSegments(text),
      printer: text.match(/; printer_model = ([^\r\n]+)/)?.[1], globalLayerHeight: Number(text.match(/; layer_height = ([^\r\n]+)/)?.[1]) }
  }))
  report.scope = { plateCount: report.gcodes.length, allPlatesModelSeconds: report.gcodes.reduce((sum, plate) => sum + (plate.modelSeconds || 0), 0), allPlatesTotalSeconds: report.gcodes.reduce((sum, plate) => sum + (plate.totalSeconds || 0), 0) }
  report.sliceSucceeded = report.exitCode === 0 && !report.timedOut && report.result?.return_code === 0 && report.gcodes.length > 0
  report.profileValidated = report.sliceSucceeded && report.gcodes.every(plate => plate.globalLayerHeight === .28 && plate.layerCount === plate.layers.length && plate.lastLayers.at(-1)?.height <= .2 + 1e-5 && plate.fineCoverage.every(range => range.heightsMatch && range.actualLayerCount >= range.minimumLayerCount))
  report.controlledSimulation = name.startsWith('simulated-all-fine-')
  report.controlledSimulationValidated = report.controlledSimulation && report.sliceSucceeded && report.gcodes.every(plate => plate.globalLayerHeight === .08 && plate.layers.slice(1).every(layer => Math.abs(layer.height - .08) < 1e-5))
  await writeFile(path.join(output, 'audit-report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ input: name, sliceSucceeded: report.sliceSucceeded, profileValidated: report.profileValidated, exitCode: report.exitCode, timedOut: report.timedOut, windowTitle: report.windowTitle,
    gcodes: report.gcodes.map(({ layers, ...gcode }) => gcode), scope: report.scope, result: report.result ? { returnCode: report.result.return_code, error: report.result.error_string } : undefined, tail: run.log.slice(-500) }))
  if (!report.profileValidated && !report.controlledSimulationValidated) process.exitCode = 1
}
