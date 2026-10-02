$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$frontend = Split-Path $PSScriptRoot -Parent
$public = Join-Path $frontend 'public'
$sourcePath = Join-Path $public 'icon-source.png'
$source = [System.Drawing.Image]::FromFile($sourcePath)

try {
    foreach ($icon in @(
        @{ Name = 'icon-180.png'; Size = 180 },
        @{ Name = 'icon-192.png'; Size = 192 },
        @{ Name = 'icon-512.png'; Size = 512 },
        @{ Name = 'icon.png'; Size = 512 }
    )) {
        $bitmap = [System.Drawing.Bitmap]::new($icon.Size, $icon.Size)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.Clear([System.Drawing.Color]::Transparent)
            $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
            $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $graphics.DrawImage($source, 0, 0, $icon.Size, $icon.Size)
            $bitmap.Save((Join-Path $public $icon.Name), [System.Drawing.Imaging.ImageFormat]::Png)
        } finally {
            $graphics.Dispose()
            $bitmap.Dispose()
        }
    }

    $frames = @(
        foreach ($size in @(16, 24, 32, 48, 64, 128, 256)) {
            $bitmap = [System.Drawing.Bitmap]::new($size, $size)
            $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
            try {
                $graphics.Clear([System.Drawing.Color]::Transparent)
                $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
                $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
                $graphics.DrawImage($source, 0, 0, $size, $size)
                $stream = [System.IO.MemoryStream]::new()
                try {
                    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
                    @{ Size = $size; Data = $stream.ToArray() }
                } finally {
                    $stream.Dispose()
                }
            } finally {
                $graphics.Dispose()
                $bitmap.Dispose()
            }
        }
    )

    $stream = [System.IO.File]::Create((Join-Path $public 'icon.ico'))
    $writer = [System.IO.BinaryWriter]::new($stream)
    try {
        $writer.Write([uint16]0)
        $writer.Write([uint16]1)
        $writer.Write([uint16]$frames.Count)
        $offset = 6 + 16 * $frames.Count
        foreach ($frame in $frames) {
            $writer.Write([byte]($frame.Size % 256))
            $writer.Write([byte]($frame.Size % 256))
            $writer.Write([byte]0)
            $writer.Write([byte]0)
            $writer.Write([uint16]1)
            $writer.Write([uint16]32)
            $writer.Write([uint32]$frame.Data.Length)
            $writer.Write([uint32]$offset)
            $offset += $frame.Data.Length
        }
        foreach ($frame in $frames) {
            $writer.Write([byte[]]$frame.Data)
        }
    } finally {
        $writer.Dispose()
    }
} finally {
    $source.Dispose()
}

& (Join-Path $PSScriptRoot 'generate-android-icons.ps1')
