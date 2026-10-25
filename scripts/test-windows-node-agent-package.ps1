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
$externalRootsPath = Join-Path $resolvedRoot 'external-roots.ps1'
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
if (-not (Test-Path -LiteralPath $externalRootsPath -PathType Leaf)) {
  throw "External-root startup helper is missing: $externalRootsPath"
}
if (-not (Test-Path -LiteralPath $nodeModules -PathType Container)) {
  throw "Windows Node Agent production dependencies are missing: $nodeModules"
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.name -ne '@photomesh/node-agent') {
  throw "Unexpected package name in $manifestPath`: $($manifest.name)"
}

. $externalRootsPath
$testRootPath = Join-Path $env:TEMP ('photomesh-node-agent-external-roots-' + [guid]::NewGuid().ToString('N'))
$testRootCreated = $false
$previousExternalRoots = $env:PHOTOMESH_EXTERNAL_ROOTS
$previousExpectedRoot = $env:PHOTOMESH_EXPECTED_ROOT
try {
  New-Item -ItemType Directory -Path $testRootPath -ErrorAction Stop | Out-Null
  $testRootCreated = $true
  $filePath = Join-Path $testRootPath 'not-a-directory.txt'
  Set-Content -LiteralPath $filePath -Value 'test fixture' -Encoding UTF8
  $missingPath = Join-Path $testRootPath 'missing-photos'
  $inputState = [pscustomobject]@{ Index = 0; Values = @($missingPath, $filePath, $testRootPath) }
  $messageState = New-Object 'System.Collections.Generic.List[string]'
  $readPath = ({
    if ($inputState.Index -ge $inputState.Values.Count) { throw 'External-root prompt requested too many test inputs.' }
    $value = $inputState.Values[$inputState.Index]
    $inputState.Index += 1
    return $value
  }).GetNewClosure()
  $writeMessage = ({
    param([string]$Message, [string]$Color)
    [void]$messageState.Add("$Color|$Message")
  }).GetNewClosure()

  $rootsJson = Read-PhotoMeshExternalRootJson -ReadPath $readPath -WriteMessage $writeMessage
  if ($inputState.Index -ne 3) { throw 'External-root prompt did not retry invalid inputs before accepting a valid directory.' }
  $capturedMessages = @($messageState.ToArray())
  if ($capturedMessages.Count -ne 4 -or -not ($capturedMessages | Where-Object { $_ -like 'Red|*Could not resolve external photo folder*' }) -or
      -not ($capturedMessages | Where-Object { $_ -like 'Red|*is not a directory*' }) -or
      @($capturedMessages | Where-Object { $_ -like 'Yellow|*press Enter to skip*' }).Count -ne 2) {
    throw 'External-root prompt did not display specific errors and retry guidance.'
  }
  if (-not $rootsJson.TrimStart().StartsWith('[') -or -not $rootsJson.TrimEnd().EndsWith(']')) {
    throw 'External-root configuration was not serialized as a JSON array.'
  }

  $env:PHOTOMESH_EXTERNAL_ROOTS = $rootsJson
  $env:PHOTOMESH_EXPECTED_ROOT = (Get-Item -LiteralPath $testRootPath).FullName
  $rootSmokeScript = @'
const roots = JSON.parse(process.env.PHOTOMESH_EXTERNAL_ROOTS);
if (!Array.isArray(roots) || roots.length !== 1 || roots[0].rootId !== 'user-photos' ||
    roots[0].libraryId !== 'user-photos' || roots[0].path !== process.env.PHOTOMESH_EXPECTED_ROOT || roots[0].pathStyle !== 'win32') {
  throw new Error('External-root configuration did not preserve the authorized directory array.');
}
console.log('Windows external photo-root prompt smoke passed.');
'@
  $rootSmokeBase64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($rootSmokeScript))
  $rootBootstrap = "eval(Buffer.from('$rootSmokeBase64','base64').toString('utf8'))"
  & $nodePath --input-type=module -e $rootBootstrap
  if ($LASTEXITCODE -ne 0) { throw "Windows external photo-root smoke failed with exit code $LASTEXITCODE." }

  # Literal-path handling must preserve shell metacharacters and Unicode.
  $specialPath = Join-Path $testRootPath ('photos [1] & ' + [char]0x7167 + [char]0x7247)
  $null = [System.IO.Directory]::CreateDirectory($specialPath)
  $expectedSpecialPath = (Get-Item -LiteralPath $specialPath -Force -ErrorAction Stop).FullName
  foreach ($inputPath in @($specialPath, ('"' + $specialPath + '"'), ("'" + $specialPath + "'"))) {
    $specialJson = ConvertTo-PhotoMeshExternalRootJson -Path $inputPath
    $specialRoot = @(ConvertFrom-Json -InputObject $specialJson)
    $actualPath = if ($specialRoot.Count -gt 0) { [string]$specialRoot[0].path } else { '' }
    $pathMatches = [string]::Equals($actualPath, $expectedSpecialPath, [System.StringComparison]::OrdinalIgnoreCase)
    if ($specialRoot.Count -ne 1 -or -not $pathMatches -or -not $specialJson.TrimStart().StartsWith('[')) {
      throw "Quoted, Unicode or literal special-character path did not round-trip. Input=[$inputPath]; Expected=[$expectedSpecialPath]; Actual=[$actualPath]; roots=$($specialRoot.Count); JSON=[$specialJson]; PowerShell=$($PSVersionTable.PSVersion)."
    }
  }
  $providerRejected = $false
  try { $null = ConvertTo-PhotoMeshExternalRootJson -Path 'HKCU:\Software' }
  catch { $providerRejected = $_.Exception.Message -like '*filesystem directory*' }
  if (-not $providerRejected) { throw 'Non-filesystem provider path was not rejected.' }

  $skipInput = { return '' }
  $skippedRoots = Read-PhotoMeshExternalRootJson -ReadPath $skipInput -WriteMessage $writeMessage
  if ($null -ne $skippedRoots) { throw 'Blank external-root input must skip root configuration.' }
} finally {
  if ($null -eq $previousExternalRoots) { Remove-Item Env:PHOTOMESH_EXTERNAL_ROOTS -ErrorAction SilentlyContinue }
  else { $env:PHOTOMESH_EXTERNAL_ROOTS = $previousExternalRoots }
  if ($null -eq $previousExpectedRoot) { Remove-Item Env:PHOTOMESH_EXPECTED_ROOT -ErrorAction SilentlyContinue }
  else { $env:PHOTOMESH_EXPECTED_ROOT = $previousExpectedRoot }
  if ($testRootCreated -and (Test-Path -LiteralPath $testRootPath -PathType Container)) {
    $resolvedTestRoot = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $testRootPath).ProviderPath)
    $expectedParent = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')
    $actualParent = [System.IO.Path]::GetDirectoryName($resolvedTestRoot).TrimEnd('\')
    if (-not $actualParent.Equals($expectedParent, [System.StringComparison]::OrdinalIgnoreCase) -or
        [System.IO.Path]::GetFileName($resolvedTestRoot) -notmatch '^photomesh-node-agent-external-roots-[0-9a-f]{32}$') {
      throw "Refusing to remove unexpected external-root test directory: $resolvedTestRoot"
    }
    Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
  }
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
