Add-Type -AssemblyName System.Drawing

$frontend = Split-Path $PSScriptRoot -Parent
$sourcePath = Join-Path $frontend 'public/icon-apk-source.png'
$resources = Join-Path $frontend 'android/app/src/main/res'
$source = [System.Drawing.Image]::FromFile($sourcePath)

try {
    foreach ($density in @(
        @{ Name = 'mdpi'; Size = 48; Foreground = 108 },
        @{ Name = 'hdpi'; Size = 72; Foreground = 162 },
        @{ Name = 'xhdpi'; Size = 96; Foreground = 216 },
        @{ Name = 'xxhdpi'; Size = 144; Foreground = 324 },
        @{ Name = 'xxxhdpi'; Size = 192; Foreground = 432 }
    )) {
        $directory = Join-Path $resources "mipmap-$($density.Name)"
        foreach ($variant in @(
            @{ Name = 'ic_launcher.png'; Size = $density.Size; Scale = 1; Round = $false },
            @{ Name = 'ic_launcher_round.png'; Size = $density.Size; Scale = 0.68; Round = $true },
            @{ Name = 'ic_launcher_foreground.png'; Size = $density.Foreground; Scale = (2 / 3); Round = $false }
        )) {
            $size = [int]$variant.Size
            $bitmap = [System.Drawing.Bitmap]::new($size, $size)
            $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
            try {
                $graphics.Clear([System.Drawing.Color]::Transparent)
                $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
                $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
                if ($variant.Round) {
                    $circle = [System.Drawing.Drawing2D.GraphicsPath]::new()
                    try {
                        $circle.AddEllipse(0, 0, $size, $size)
                        $graphics.SetClip($circle)
                        $graphics.Clear([System.Drawing.Color]::FromArgb(3, 6, 12))
                    } finally {
                        $circle.Dispose()
                    }
                }
                $inner = [int][math]::Round($size * $variant.Scale)
                $offset = [int][math]::Floor(($size - $inner) / 2)
                $graphics.DrawImage($source, [System.Drawing.Rectangle]::new($offset, $offset, $inner, $inner))
                $bitmap.Save((Join-Path $directory $variant.Name), [System.Drawing.Imaging.ImageFormat]::Png)
            } finally {
                $graphics.Dispose()
                $bitmap.Dispose()
            }
        }
    }
} finally {
    $source.Dispose()
}