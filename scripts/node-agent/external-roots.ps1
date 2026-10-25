function ConvertTo-PhotoMeshExternalRootJson {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $candidate = $Path.Trim()
  if ($candidate.Length -ge 2 -and
      (($candidate.StartsWith('"') -and $candidate.EndsWith('"')) -or
       ($candidate.StartsWith("'") -and $candidate.EndsWith("'")))) {
    $candidate = $candidate.Substring(1, $candidate.Length - 2).Trim()
  }
  if ([string]::IsNullOrWhiteSpace($candidate)) {
    throw 'A photo folder path is required.'
  }

  try {
    $resolved = Resolve-Path -LiteralPath $candidate -ErrorAction Stop
    if ($resolved.Provider.Name -ne 'FileSystem') {
      throw 'The photo folder must be a filesystem directory, not a PowerShell provider path.'
    }
    $resolvedPath = $resolved.ProviderPath
    $item = Get-Item -LiteralPath $resolvedPath -Force -ErrorAction Stop
  } catch {
    throw "Could not resolve external photo folder '$candidate': $($_.Exception.Message)"
  }
  if (-not $item.PSIsContainer) {
    throw "External photo path '$candidate' is not a directory."
  }

  try {
    $null = Get-ChildItem -LiteralPath $item.FullName -Force -ErrorAction Stop | Select-Object -First 1
  } catch {
    throw "External photo folder '$($item.FullName)' is not readable: $($_.Exception.Message)"
  }

  $roots = @(
    [pscustomobject]@{
      rootId = 'user-photos'
      libraryId = 'user-photos'
      path = $item.FullName
      pathStyle = 'win32'
    }
  )
  $json = ConvertTo-Json -InputObject $roots -Compress -Depth 4
  if (-not $json.TrimStart().StartsWith('[') -or -not $json.TrimEnd().EndsWith(']')) {
    throw 'Could not serialize external photo roots as a JSON array.'
  }
  return $json
}

function Read-PhotoMeshExternalRootJson {
  [CmdletBinding()]
  param(
    [scriptblock]$ReadPath = { Read-Host 'Optional external photo folder (blank to skip)' },
    [scriptblock]$WriteMessage = {
      param([string]$Message, [string]$Color)
      Write-Host $Message -ForegroundColor $Color
    }
  )

  while ($true) {
    $candidate = [string](& $ReadPath)
    if ([string]::IsNullOrWhiteSpace($candidate)) {
      return $null
    }

    try {
      return ConvertTo-PhotoMeshExternalRootJson -Path $candidate
    } catch {
      $reason = $_.Exception.Message
      & $WriteMessage "Unable to configure external photo folder: $reason" 'Red'
      & $WriteMessage 'Enter the folder path again, or press Enter to skip.' 'Yellow'
    }
  }
}
