# OCR image files with the Windows built-in engine (zh-Hans, which also reads Latin text).
#   powershell -NoProfile -File ocr.ps1 <list.txt>      list.txt: one image path per line (UTF-8)
# Prints a JSON array [{ path, lines: [...] }]; non-ASCII is \u-escaped so the caller's code page is irrelevant.
param([Parameter(Mandatory = $true)][string]$ListFile)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
[void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
[void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
[void][Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

# WinRT calls are async; PowerShell 5.1 has no await, so go through Task.
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
function Await($op, [Type]$type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
    $task.Wait() | Out-Null
    $task.Result
}

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('zh-Hans-CN'))
if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if (-not $engine) { throw 'no OCR language installed' }

$out = New-Object System.Collections.Generic.List[object]
foreach ($path in [IO.File]::ReadAllLines($ListFile, [Text.Encoding]::UTF8)) {
    if (-not $path) { continue }
    try {
        $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
        $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
        $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
        $out.Add(@{ path = $path; lines = @($result.Lines | ForEach-Object { $_.Text }) })
        $stream.Dispose()
    } catch {
        $out.Add(@{ path = $path; lines = @(); error = $_.Exception.Message })
    }
}
$json = ConvertTo-Json -InputObject $out.ToArray() -Depth 4 -Compress
[regex]::Replace($json, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
