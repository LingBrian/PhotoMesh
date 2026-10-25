[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$PackageRoot
)

$ErrorActionPreference = 'Stop'

$resolvedRoot = (Resolve-Path -LiteralPath $PackageRoot).Path
if (-not (Test-Path -LiteralPath $resolvedRoot -PathType Container)) {
  throw "Windows Node Agent package root is not a directory: $resolvedRoot"
}

$manifestPath = Join-Path $resolvedRoot 'package.json'
$nodePath = Join-Path $resolvedRoot 'runtime\node.exe'
$entryPath = Join-Path $resolvedRoot 'dist\index.js'
$nodeModules = Join-Path $resolvedRoot 'node_modules'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw "Windows Node Agent package manifest is missing: $manifestPath"
}
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
  throw "Bundled Node runtime is missing: $nodePath"
}
if (-not (Test-Path -LiteralPath $entryPath -PathType Leaf)) {
  throw "Node Agent entry point is missing: $entryPath"
}
if (-not (Test-Path -LiteralPath $nodeModules -PathType Container)) {
  throw "Windows Node Agent production dependencies are missing: $nodeModules"
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.name -ne '@photomesh/node-agent') {
  throw "Unexpected package name in $manifestPath`: $($manifest.name)"
}

$dependencies = @($manifest.dependencies.PSObject.Properties.Name)
if ($dependencies -notcontains 'better-sqlite3') {
  throw 'Windows Node Agent manifest does not declare better-sqlite3.'
}
$missingDependencies = @(
  $dependencies | Where-Object {
    -not (Test-Path -LiteralPath (Join-Path $nodeModules $_) -PathType Container)
  }
)
if ($missingDependencies.Count -gt 0) {
  throw "Release package is missing runtime dependency directories: $($missingDependencies -join ', ')"
}

$dependenciesJson = ConvertTo-Json -InputObject ([string[]]$dependencies) -Compress
$smokeScript = @"
(async () => {
  const dependencies = $dependenciesJson;
  for (const dependency of dependencies) await import(dependency);
  const { default: Database } = await import('better-sqlite3');
  const database = new Database(':memory:');
  const result = database.prepare('SELECT 1 AS value').get();
  if (result.value !== 1) throw new Error('SQLite runtime smoke query returned an unexpected value');
  database.close();
  console.log('Windows Node Agent production dependency smoke passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
"@
$smokeScriptBase64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($smokeScript))
$bootstrap = "eval(Buffer.from('$smokeScriptBase64','base64').toString('utf8'))"
$nodeExit = 0
Push-Location $resolvedRoot
try {
  & $nodePath --input-type=module -e $bootstrap
  $nodeExit = $LASTEXITCODE
} finally {
  Pop-Location
}
if ($nodeExit -ne 0) {
  throw "Windows Node Agent runtime dependency smoke failed with exit code $nodeExit."
}
