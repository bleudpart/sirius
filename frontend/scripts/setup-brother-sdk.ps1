param([switch]$AcceptLicense)
$ErrorActionPreference = 'Stop'
$license = 'https://support.brother.com/g/s/agreement/English/es_mobilesdk.html'
if (-not $AcceptLicense) {
    throw "Lire et accepter la licence $license puis relancer avec -AcceptLicense. Aucun telechargement sans acceptation."
}
$libs = Join-Path $PSScriptRoot '..\android\app\libs'
New-Item -ItemType Directory -Force -Path $libs | Out-Null
$archive = Join-Path $libs 'bpsdkaall4132.zip'
$aar = Join-Path $libs 'BrotherPrintLibrary.aar'
$url = 'https://download.brother.com/welcome/dlfp100900/bpsdkaall4132.zip'
Invoke-WebRequest -Uri $url -OutFile $archive
if ((Get-FileHash $archive -Algorithm SHA256).Hash -ne '73620CA61039B0D2B262F811EA81E21BF0E3142745D3871E037E0168436A7BC3') {
    throw 'Archive Brother inattendue : ne pas utiliser ce fichier. Verifier le telechargement officiel 4.13.2.'
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$outer = [IO.Compression.ZipFile]::OpenRead($archive)
try {
    $innerEntry = @($outer.Entries | Where-Object { $_.Name -eq 'bpsdka4132.zip' })
    if ($innerEntry.Count -ne 1) { throw 'Structure archive Brother inattendue.' }
    $memory = New-Object IO.MemoryStream
    $stream = $innerEntry[0].Open()
    try { $stream.CopyTo($memory) } finally { $stream.Dispose() }
    $memory.Position = 0
    $inner = New-Object IO.Compression.ZipArchive($memory, [IO.Compression.ZipArchiveMode]::Read)
    try {
        $entries = @($inner.Entries | Where-Object { $_.FullName -match '(^|/)libs/BrotherPrintLibrary\.aar$' })
        if ($entries.Count -ne 1) { throw 'AAR Brother officiel introuvable ou ambigu.' }
        $content = New-Object IO.MemoryStream
        $source = $entries[0].Open()
        try { $source.CopyTo($content) } finally { $source.Dispose() }
        try {
            $bytes = $content.ToArray()
            $hash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bytes)).Replace('-', '')
            if ($hash -ne 'DEF6BCCC7415DA38B771186D571757C0A44ADD5358B6DC7A1855FFF77BCED64E') {
                throw 'AAR Brother inattendu, aucun remplacement.'
            }
            [IO.File]::WriteAllBytes($aar, $bytes)
        } finally { $content.Dispose() }
        $legal = Join-Path $PSScriptRoot '..\android\app\src\main\assets\brother-sdk'
        New-Item -ItemType Directory -Force -Path $legal | Out-Null
        foreach ($name in @('EULA.pdf', 'Redist.txt', 'Redist2.txt')) {
            $entry = @($inner.Entries | Where-Object { $_.FullName -eq "bpsdka4132/$name" })
            if ($entry.Count -ne 1) { throw "Notice officielle Brother absente : $name" }
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry[0], (Join-Path $legal $name), $true)
        }
    } finally { $inner.Dispose(); $memory.Dispose() }
} finally { $outer.Dispose() }
Write-Output 'SDK Brother 4.13.2 officiel verifie, accord et listes Redist joints aux assets locaux. Ne pas redistribuer le SDK brut.'
