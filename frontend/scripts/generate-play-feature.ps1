$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$public = Join-Path (Split-Path $PSScriptRoot -Parent) 'public'
$output = Join-Path $public 'play-feature-1024x500.png'
$bitmap = [System.Drawing.Bitmap]::new(1024, 500, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$source = [System.Drawing.Image]::FromFile((Join-Path $public 'icon-source.png'))
$background = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    [System.Drawing.Rectangle]::new(0, 0, 1024, 500),
    [System.Drawing.Color]::FromArgb(5, 19, 32),
    [System.Drawing.Color]::FromArgb(12, 38, 55),
    [single]0
)
$gold = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(238, 203, 109))
$white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(231, 239, 245))
$muted = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(163, 186, 201))
$line = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(125, 103, 54), 1)
$titleFont = [System.Drawing.Font]::new('Segoe UI', 34, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$bodyFont = [System.Drawing.Font]::new('Segoe UI', 26, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$smallFont = [System.Drawing.Font]::new('Segoe UI', 19, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)

try {
    $graphics.FillRectangle($background, 0, 0, 1024, 500)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $graphics.DrawImage($source, [System.Drawing.Rectangle]::new(64, 74, 352, 352))
    $graphics.DrawLine($line, 456, 112, 456, 388)
    $graphics.DrawString('VOTRE ASSISTANT', $titleFont, $gold, [single]496, [single]145)
    $graphics.DrawString('AU QUOTIDIEN', $titleFont, $gold, [single]496, [single]191)
    $graphics.DrawString('Notes, t' + [char]0x00E2 + 'ches et dossiers', $bodyFont, $white, [single]496, [single]263)
    $graphics.DrawString('Organisez. Pr' + [char]0x00E9 + 'parez. Gardez la main.', $smallFont, $muted, [single]496, [single]315)
    $bitmap.Save($output, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
    $smallFont.Dispose()
    $bodyFont.Dispose()
    $titleFont.Dispose()
    $line.Dispose()
    $muted.Dispose()
    $white.Dispose()
    $gold.Dispose()
    $background.Dispose()
    $source.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
}

$check = [System.Drawing.Image]::FromFile($output)
try {
    if ($check.Width -ne 1024 -or $check.Height -ne 500 -or
        $check.PixelFormat -ne [System.Drawing.Imaging.PixelFormat]::Format24bppRgb -or
        (Get-Item -LiteralPath $output).Length -gt 15MB) {
        throw 'Format de la banniere Google Play invalide.'
    }
} finally {
    $check.Dispose()
}
Write-Output "Banniere Google Play verifiee : $output"
