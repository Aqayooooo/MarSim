param([string]$Image = 'marsim:verification')

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$docker = (Get-Command docker -ErrorAction Stop).Source
$tag = [Guid]::NewGuid().ToString('N').Substring(0, 12)
$container = "marsim-check-$tag"
$volume = "marsim-check-$tag"
$createdContainer = $false
$createdVolume = $false

function Invoke-Docker {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    $output = & $docker @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Docker zakończył się błędem $LASTEXITCODE przy poleceniu $($Arguments[0])"
    }
    return $output
}

function Invoke-Api {
    param([string]$Path, [object]$Body)
    $parameters = @{ Uri = "$script:base/api/$Path"; TimeoutSec = 30 }
    if ($null -ne $Body) {
        $parameters.Method = 'Post'
        $parameters.ContentType = 'application/json'
        $parameters.Body = ConvertTo-Json -InputObject $Body -Depth 10 -Compress
    }
    Invoke-RestMethod @parameters
}

function Wait-Ready {
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        try {
            if ((Invoke-Api 'health' $null).ok) { return }
        } catch { }
        $state = Invoke-Docker inspect --format '{{.State.Status}}' $container
        if ($state -ne 'running') {
            Invoke-Docker logs $container | Write-Host
            throw "Kontener nie działa ($state)"
        }
        Start-Sleep -Seconds 1
    }
    throw 'Serwer w kontenerze nie uruchomił się w ciągu 60 s'
}

try {
    if ((Invoke-Docker info --format '{{.OSType}}') -ne 'linux') {
        throw 'Włącz silnik kontenerów Linux w Docker Desktop'
    }
    Invoke-Docker build --tag $Image $repo | Write-Host
    Invoke-Docker volume create $volume | Out-Null
    $createdVolume = $true
    Invoke-Docker create --name $container --publish '127.0.0.1::8000' --mount "type=volume,source=$volume,target=/data" $Image | Out-Null
    $createdContainer = $true
    Invoke-Docker start $container | Out-Null
    $binding = Invoke-Docker inspect --format '{{json .NetworkSettings.Ports}}' $container | ConvertFrom-Json
    $port = $binding.'8000/tcp'[0].HostPort
    $script:base = "http://127.0.0.1:$port"
    Wait-Ready
    if ((Invoke-Docker exec $container id -u) -eq '0') { throw 'Proces działa jako root' }
    Invoke-Docker exec $container python -c "import importlib.util; assert all(importlib.util.find_spec(p) is None for p in ('pytest','httpx','rasterio','pyproj'))" | Out-Null

    foreach ($mission in @('mount-sharp', 'jezero')) {
        Invoke-Api 'missions/select' @{ id = $mission } | Out-Null
        $plan = Invoke-Api 'plan' @{}
        if (!$plan.ok -or $plan.path.Count -lt 2) { throw "Brak trasy dla $mission" }
        if (!(Invoke-Api 'report' $null).ok) { throw "Brak raportu dla $mission" }
        Write-Host "OK misja $mission, trasa $([Math]::Round($plan.lengthM)) m"
    }
    Invoke-Api 'missions/select' @{ id = 'mount-sharp' } | Out-Null
    $item = @{ id = "CHECK-$tag"; sol = 200; startLtst = '10:00'; durationH = 1; crew = @('EV1'); purpose = 'test zapisu w kontenerze' }
    Invoke-Api 'schedule' $item | Out-Null
    Invoke-Docker restart $container | Out-Null
    Wait-Ready
    if (!(Invoke-Api 'schedule' $null).items.Where({ $_.id -eq $item.id })) {
        throw 'Harmonogram nie przetrwał restartu kontenera'
    }
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        $health = Invoke-Docker inspect --format '{{.State.Health.Status}}' $container
        if ($health -eq 'healthy') { break }
        Start-Sleep -Seconds 1
    }
    if ($health -ne 'healthy') { throw "HEALTHCHECK zakończył się stanem $health" }
    $imageBytes = Invoke-Docker image inspect --format '{{.Size}}' $Image
    Write-Host "OK Docker: obie misje, raporty, użytkownik bez root, zapis po restarcie, HEALTHCHECK. Rozmiar obrazu $imageBytes B."
} finally {
    if ($createdContainer) { & $docker rm --force $container | Out-Null }
    if ($createdVolume) { & $docker volume rm $volume | Out-Null }
}
