$ErrorActionPreference = 'Stop'
# Windows convenience wrapper. CI uses the cross-platform build-public-site.mjs.
$root = Split-Path -Parent $PSScriptRoot
$studio = Join-Path $root 'snapboard-v2'
$wikiStatic = Join-Path $root 'apps\wiki\static\design'

Push-Location $root
try {
  # Build the designer with a /design/ base so it can be served beside Docusaurus.
  $env:VITE_BASE = '/design/'
  npm --workspace snapboard-v2 run build
  if ($LASTEXITCODE -ne 0) { throw "Studio build failed with exit code $LASTEXITCODE" }
  if (Test-Path -LiteralPath $wikiStatic) { Remove-Item -LiteralPath $wikiStatic -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $wikiStatic | Out-Null
  Copy-Item -Path (Join-Path $studio 'dist\*') -Destination $wikiStatic -Recurse -Force
  Remove-Item Env:VITE_BASE -ErrorAction SilentlyContinue

  # Docusaurus now owns / and /docs, while the built designer lives at /design/.
  npm --workspace apps-wiki run build
  if ($LASTEXITCODE -ne 0) { throw "Wiki build failed with exit code $LASTEXITCODE" }
  Write-Output 'Public site built: Wiki / + docs + devlog, Studio /design/'
}
finally {
  Pop-Location
}
