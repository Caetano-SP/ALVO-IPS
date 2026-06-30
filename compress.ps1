$sourcePath = $PSScriptRoot
$destPath = Resolve-Path (Join-Path $PSScriptRoot "..\data") -ErrorAction SilentlyContinue
if (-not $destPath) {
    $destPath = New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot "..\data")
}

$filesToCompress = Get-ChildItem -Path $sourcePath -Include *.html, *.css, *.js, *.json -Exclude compress.ps1 -Recurse

Write-Host "Iniciando compressao Gzip para arquivos do LittleFS..." -ForegroundColor Cyan

foreach ($file in $filesToCompress) {
    if ($file.Name.EndsWith(".gz")) { continue }
    
    $relativeName = $file.FullName.Substring($sourcePath.Length + 1)
    $outputPath = Join-Path $destPath ($relativeName + ".gz")
    
    # Garantir que subdiretorios existam na pasta de destino
    $outputDir = Split-Path $outputPath
    if (-not (Test-Path $outputDir)) {
        New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
    }
    
    Write-Host "Compactando: $($file.Name) -> $($file.Name).gz para data/" -ForegroundColor Gray
    
    try {
        $inputBytes = [System.IO.File]::ReadAllBytes($file.FullName)
        $outputStream = [System.IO.File]::Create($outputPath)
        $gzipStream = New-Object System.IO.Compression.GZipStream($outputStream, [System.IO.Compression.CompressionLevel]::Optimal)
        $gzipStream.Write($inputBytes, 0, $inputBytes.Length)
        $gzipStream.Dispose()
        $outputStream.Dispose()
        
        $oldSize = ($file.Length / 1KB).ToString("F2")
        $newSize = ((Get-Item $outputPath).Length / 1KB).ToString("F2")
        Write-Host "Sucesso: $oldSize KB -> $newSize KB" -ForegroundColor Green
    }
    catch {
        Write-Host "Erro ao compactar $($file.Name): $_" -ForegroundColor Red
    }
}

Write-Host "Compressao concluida!" -ForegroundColor Cyan
