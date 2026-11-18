# Zips src/ into function.zip for Lambda deployment.
# Run from the project root: npm run package

$ErrorActionPreference = "Stop"

$distDir = Join-Path $PSScriptRoot "..\dist"
$zipPath = Join-Path $distDir "function.zip"

if (Test-Path $distDir) {
    Remove-Item $distDir -Recurse -Force
}
New-Item -ItemType Directory -Path $distDir | Out-Null

Compress-Archive -Path (Join-Path $PSScriptRoot "..\src\*") -DestinationPath $zipPath

Write-Host "Packaged: $zipPath"
