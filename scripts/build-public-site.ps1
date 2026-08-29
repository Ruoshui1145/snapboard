$ErrorActionPreference = 'Stop'
# Windows convenience wrapper. CI uses the same cross-platform build script.
$root = Split-Path -Parent $PSScriptRoot

Push-Location $root
try {
  node scripts/build-public-site.mjs
  if ($LASTEXITCODE -ne 0) { throw "Public site build failed with exit code $LASTEXITCODE" }
  Write-Output 'Public site built: unified SnapBoard website + designer'
}
finally {
  Pop-Location
}
