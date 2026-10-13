$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) {
    throw 'Le compilateur .NET Framework Windows est absent.'
}
$output = Join-Path $PSScriptRoot '..\..\dist\portable-vault'
New-Item -ItemType Directory -Path $output -Force | Out-Null
$executable = Join-Path $output 'SIRIUS-Coffre-Portable.exe'
& $compiler /nologo /target:winexe /platform:x64 /optimize+ /utf8output /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll "/out:$executable" (Join-Path $PSScriptRoot 'PortableVault.cs')
if ($LASTEXITCODE -ne 0) { throw 'La compilation du coffre portable a échoué.' }
Get-Item -LiteralPath $executable | Select-Object FullName, Length
