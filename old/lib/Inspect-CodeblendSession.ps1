[CmdletBinding()]
param(
    [string]$RepoRoot,
    [int]$MaxLogLines = 120
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Section {
    param([Parameter(Mandatory = $true)][string]$Title)

    Write-Output ''
    Write-Output "=== $Title ==="
}

function Normalize-Path {
    param([AllowNull()][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $null
    }

    $normalized = $Path.Trim().Replace('/', '\')

    try {
        $normalized = [System.IO.Path]::GetFullPath($normalized)
    }
    catch {
        # Keep the best-effort normalized form when the path cannot be canonicalized.
    }

    $normalized = $normalized.TrimEnd([char[]]@('\', '/'))

    return $normalized.ToLowerInvariant()
}

function Resolve-RepoRoot {
    param([string]$PreferredRepoRoot)

    if (-not [string]::IsNullOrWhiteSpace($PreferredRepoRoot)) {
        try {
            return (Resolve-Path -Path $PreferredRepoRoot -ErrorAction Stop).Path
        }
        catch {
            return $PreferredRepoRoot
        }
    }

    try {
        $gitRoot = (& git rev-parse --show-toplevel 2>$null)
        if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($gitRoot)) {
            return $gitRoot.Trim()
        }
    }
    catch {
        # Fall back to the current working directory when git is unavailable.
    }

    return (Get-Location).Path
}

function Get-TimestampedSessionDirectories {
    param([Parameter(Mandatory = $true)][string]$SessionsPath)

    return @(
        Get-ChildItem -Path $SessionsPath -Directory -Force |
            Where-Object { $_.Name -match '^\d{14}-' } |
            Sort-Object Name -Descending
    )
}

function Test-DocumentStateMatchesRepo {
    param(
        [Parameter(Mandatory = $true)][string]$DocumentStatePath,
        [Parameter(Mandatory = $true)][string]$NormalizedRepoRoot
    )

    if (-not (Test-Path -Path $DocumentStatePath)) {
        return $false
    }

    try {
        $documentState = Get-Content -Path $DocumentStatePath -Raw -ErrorAction Stop | ConvertFrom-Json
        if ($null -eq $documentState) {
            return $false
        }

        foreach ($property in $documentState.PSObject.Properties) {
            $normalizedFilePath = Normalize-Path -Path $property.Name
            if (
                $normalizedFilePath -and (
                    $normalizedFilePath -eq $NormalizedRepoRoot -or
                    $normalizedFilePath.StartsWith("$NormalizedRepoRoot\\")
                )
            ) {
                return $true
            }
        }
    }
    catch {
        try {
            $raw = (Get-Content -Path $DocumentStatePath -Raw -ErrorAction Stop).ToLowerInvariant()
            $escapedRepoRoot = $NormalizedRepoRoot.Replace('\', '\\').ToLowerInvariant()
            if ($raw.Contains($escapedRepoRoot)) {
                return $true
            }
        }
        catch {
            return $false
        }
    }

    return $false
}

function Get-WorkspaceFolderFromLog {
    param([Parameter(Mandatory = $true)][string]$LogPath)

    if (-not (Test-Path -Path $LogPath)) {
        return $null
    }

    foreach ($line in Get-Content -Path $LogPath -TotalCount 120 -ErrorAction SilentlyContinue) {
        if ($line -match '"workspaceFolder":"([^"]+)"') {
            return $Matches[1]
        }
    }

    return $null
}

function Test-LogsMatchRepo {
    param(
        [AllowEmptyCollection()][string[]]$LogPaths,
        [Parameter(Mandatory = $true)][string]$NormalizedRepoRoot
    )

    foreach ($logPath in @($LogPaths)) {
        $workspaceFolder = Get-WorkspaceFolderFromLog -LogPath $logPath
        $normalizedWorkspaceFolder = Normalize-Path -Path $workspaceFolder
        if ($normalizedWorkspaceFolder -and $normalizedWorkspaceFolder -eq $NormalizedRepoRoot) {
            return $true
        }
    }

    return $false
}

function Get-MatchingSession {
    param(
        [AllowEmptyCollection()][System.IO.DirectoryInfo[]]$SessionDirectories,
        [Parameter(Mandatory = $true)][string]$NormalizedRepoRoot
    )

    foreach ($sessionDirectory in @($SessionDirectories)) {
        $documentStatePath = Join-Path $sessionDirectory.FullName 'document-state.json'
        $sessionJsonPath = Join-Path $sessionDirectory.FullName 'session.json'

        $codeblendLogPaths = @(
            Get-ChildItem -Path $sessionDirectory.FullName -File -Force |
                Where-Object { $_.Name -like 'codeblend-*.log' -and $_.Name -notlike 'codeblend-server-*.log' } |
                Sort-Object Name -Descending |
                Select-Object -ExpandProperty FullName
        )

        $serverLogPaths = @(
            Get-ChildItem -Path $sessionDirectory.FullName -File -Force |
                Where-Object { $_.Name -like 'codeblend-server-*.log' } |
                Sort-Object Name -Descending |
                Select-Object -ExpandProperty FullName
        )

        $matchSource = $null

        if (Test-DocumentStateMatchesRepo -DocumentStatePath $documentStatePath -NormalizedRepoRoot $NormalizedRepoRoot) {
            $matchSource = 'document-state.json'
        }
        elseif (Test-LogsMatchRepo -LogPaths $codeblendLogPaths -NormalizedRepoRoot $NormalizedRepoRoot) {
            $matchSource = 'codeblend-*.log workspaceFolder'
        }
        elseif (Test-LogsMatchRepo -LogPaths $serverLogPaths -NormalizedRepoRoot $NormalizedRepoRoot) {
            $matchSource = 'codeblend-server-*.log workspaceFolder'
        }

        if ($matchSource) {
            return [PSCustomObject]@{
                Name = $sessionDirectory.Name
                FullName = $sessionDirectory.FullName
                MatchSource = $matchSource
                SessionJsonPath = if (Test-Path -Path $sessionJsonPath) { $sessionJsonPath } else { $null }
                DocumentStatePath = if (Test-Path -Path $documentStatePath) { $documentStatePath } else { $null }
                CodeblendLogPaths = @($codeblendLogPaths)
                ServerLogPaths = @($serverLogPaths)
            }
        }
    }

    return $null
}

function Write-FileOutput {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [AllowNull()][string]$Path,
        [int]$PreviewLines = 0
    )

    Write-Section -Title $Label

    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -Path $Path)) {
        Write-Output 'MISSING'
        return
    }

    Write-Output "Path: $Path"

    if ($PreviewLines -gt 0) {
        Get-Content -Path $Path -TotalCount $PreviewLines -ErrorAction SilentlyContinue | Write-Output
        Write-Output "... preview limited to first $PreviewLines lines ..."
        return
    }

    Get-Content -Path $Path -Raw -ErrorAction SilentlyContinue | Write-Output
}

$sessionsPath = Join-Path $env:USERPROFILE '.codeblend\vscode\sessions'
if (-not (Test-Path -Path $sessionsPath)) {
    Write-Output 'NO_DIR'
    exit 0
}

Write-Section -Title 'Raw session inventory'
Get-ChildItem -Path $sessionsPath -Recurse -Force |
    Select-Object FullName, Length |
    Out-String -Width 1000 |
    Write-Output

$resolvedRepoRoot = Resolve-RepoRoot -PreferredRepoRoot $RepoRoot
$normalizedRepoRoot = Normalize-Path -Path $resolvedRepoRoot
$sessionDirectories = Get-TimestampedSessionDirectories -SessionsPath $sessionsPath

Write-Section -Title 'Current repository'
Write-Output "Repo root: $resolvedRepoRoot"
Write-Output "Normalized repo root: $normalizedRepoRoot"
Write-Output "Timestamped session directories considered: $($sessionDirectories.Count)"

if ($sessionDirectories.Count -eq 0) {
    Write-Section -Title 'Matching session'
    Write-Output 'No timestamped CodeBlend session directories were found.'
    exit 0
}

$matchingSession = Get-MatchingSession -SessionDirectories $sessionDirectories -NormalizedRepoRoot $normalizedRepoRoot

Write-Section -Title 'Matching session'
if ($null -eq $matchingSession) {
    Write-Output "No CodeBlend session matched repo root: $resolvedRepoRoot"
    Write-Output 'Signals checked: document-state.json file keys, codeblend-*.log workspaceFolder, codeblend-server-*.log workspaceFolder.'
    Write-Output 'This can be expected when CodeBlend has not created session data for the repo yet, such as a brand-new, never-opened, or inactive repository.'
    Write-Output "Latest timestamped session checked: $($sessionDirectories[0].FullName)"
    exit 0
}

Write-Output "Matched session: $($matchingSession.FullName)"
Write-Output "Match source: $($matchingSession.MatchSource)"

Write-FileOutput -Label 'session.json' -Path $matchingSession.SessionJsonPath
Write-FileOutput -Label 'document-state.json' -Path $matchingSession.DocumentStatePath

foreach ($codeblendLogPath in @($matchingSession.CodeblendLogPaths)) {
    Write-FileOutput -Label ("codeblend log preview: " + [System.IO.Path]::GetFileName($codeblendLogPath)) -Path $codeblendLogPath -PreviewLines $MaxLogLines
}

foreach ($serverLogPath in @($matchingSession.ServerLogPaths)) {
    Write-FileOutput -Label ("server log preview: " + [System.IO.Path]::GetFileName($serverLogPath)) -Path $serverLogPath -PreviewLines $MaxLogLines
}
