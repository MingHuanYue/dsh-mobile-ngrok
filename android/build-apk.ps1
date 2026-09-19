# Builds the  DSH phone client APK with nothing but the Android build-tools
# (aapt2 / d8 / zipalign / apksigner) and a JDK. No Gradle, no Android Studio.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1
#
# Output: out\mingyue-dsh.apk
#
# Note: aapt2 on Windows cannot open paths containing non-ASCII characters
# (it uses narrow Win32 APIs), and this workspace is "D:\DSH". So the build
# inputs are staged into an ASCII temp root, built there, and the artifacts are
# copied back. The JDK/SDK tools stay where they are: Java resolves UTF-8 paths.

[CmdletBinding()]
param(
    [string]$Version = "1.0",
    [int]$VersionCode = 1,
    [switch]$SkipSign,
    [switch]$KeepStage
)

$ErrorActionPreference = 'Stop'

$projectRoot = $PSScriptRoot
$workspace   = Split-Path $projectRoot -Parent
$toolsSource = if (Test-Path (Join-Path $workspace '_buildtools')) { Join-Path $workspace '_buildtools' } else { Join-Path $projectRoot '_buildtools' }

# ------------------------------------------------------- ASCII staging root
$stageName = 'mingyue-dsh-build'
$stage = Join-Path $env:TEMP $stageName
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }

Write-Host "staging inputs -> $stage" -ForegroundColor DarkGray
New-Item -ItemType Directory -Force -Path $stage | Out-Null

# copy app/ (the only CJK-path input that aapt2 must open)
Copy-Item (Join-Path $projectRoot 'app') (Join-Path $stage 'app') -Recurse -Force
# helper node scripts are read by node (UTF-8 safe), but keep them together
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'tools') | Out-Null
foreach ($t in @('genicon.js', 'adddex.js', 'verifyapk.js')) {
    Copy-Item (Join-Path $toolsSource $t) (Join-Path $stage 'tools') -Force
}

$app      = Join-Path $stage 'app'
$res      = Join-Path $app 'res'
$src      = Join-Path $app 'src'
$manifest = Join-Path $app 'AndroidManifest.xml'
$work     = Join-Path $stage 'build'
$genDir   = Join-Path $work 'gen'
$classes  = Join-Path $work 'classes'
$dexOut   = Join-Path $work 'dex'
$outDir   = Join-Path $projectRoot 'out'      # final artifact lands in the workspace
$keystore = Join-Path $projectRoot 'mingyue.keystore'

foreach ($d in @($work, $genDir, $classes, $dexOut)) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
}
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# ---------------------------------------------------------------- toolchain
$jdkHome = Get-ChildItem -Path (Join-Path $toolsSource 'jdk_raw') -Directory -ErrorAction SilentlyContinue |
           Where-Object { Test-Path (Join-Path $_.FullName 'bin\javac.exe') } | Select-Object -First 1
if (-not $jdkHome) { throw "JDK not found under $toolsSource\jdk_raw" }

$javac     = Join-Path $jdkHome.FullName 'bin\javac.exe'
$keytool   = Join-Path $jdkHome.FullName 'bin\keytool.exe'
$sdk       = Join-Path $toolsSource 'sdk'
$buildTools= Join-Path $sdk 'build-tools\36.0.0'
$aapt2     = Join-Path $buildTools 'aapt2.exe'
$d8        = Join-Path $buildTools 'd8.bat'
$zipalign  = Join-Path $buildTools 'zipalign.exe'
$apksigner = Join-Path $buildTools 'apksigner.bat'
$androidJar= Join-Path $sdk 'platforms\android-36\android.jar'

foreach ($f in @($javac, $keytool, $aapt2, $d8, $zipalign, $apksigner, $androidJar)) {
    if (-not (Test-Path $f)) { throw "Missing toolchain piece: $f" }
}

$ksPass  = 'mingyue-dsh-local'
$ksAlias = 'mingyue'

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Run($exe, [string[]]$argv) {
    # Native tools write progress to stderr; with ErrorActionPreference=Stop the
    # wrapper would treat that as a terminating error and report a false failure.
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $exe @argv
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
    }
    if ($code -ne 0) { throw "$([IO.Path]::GetFileName($exe)) failed (exit $code)" }
}
function CleanupStage {
    if (-not $KeepStage) {
        Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
    } else {
        Write-Host "stage kept: $stage" -ForegroundColor DarkGray
    }
}

$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm') + 'Z'
$sw = [Diagnostics.Stopwatch]::StartNew()

# ------------------------------------------------------------------- 1. icon
# Generated from the whale-girl art in \whale.png. The old hand-drawn moon
# renderer is kept as genicon-moon.js in case this ever needs to go back.
#
# Everything this script names is ASCII on purpose. Windows PowerShell 5.1
# decodes a BOM-less .ps1 as ANSI/GBK, so a UTF-8 Chinese path inside it turns
# into mojibake; and adding a BOM to dodge that would break javac on the
# generated sources. The Chinese folder name living in $PSScriptRoot is fine -
# that string comes from the filesystem, not from decoding this file.
$assetDir = Join-Path $projectRoot 'assets'
$iconSrc = Get-ChildItem -Path $assetDir -Filter '*.png' -ErrorAction SilentlyContinue |
           Select-Object -First 1
if (-not $iconSrc) { throw "No source image found in $assetDir" }
$iconSrc = $iconSrc.FullName
$iconPng = Join-Path $res 'drawable\ic_launcher_legacy.png'
$iconFg  = Join-Path $res 'drawable\ic_launcher_foreground.png'
Step "Generating launcher icon from $([IO.Path]::GetFileName($iconSrc))"
Run 'node' @((Join-Path $stage 'tools\genicon.js'), $iconSrc, (Join-Path $res 'drawable'), '432')
if (-not (Test-Path $iconPng) -or -not (Test-Path $iconFg)) { throw "icon generation produced nothing" }

# --------------------------------------------------------------- 2. BuildConfig
Step "Writing BuildConfig"
$bcDir = Join-Path $genDir 'com\mingyue\dsh'
New-Item -ItemType Directory -Force -Path $bcDir | Out-Null
$bcText = @"
package com.mingyue.dsh;

/** Generated by build.ps1 - do not edit. */
public final class BuildConfig {
    public static final String VERSION_NAME = "$Version";
    public static final int VERSION_CODE = $VersionCode;
    public static final String BUILD_STAMP = "$stamp";
    private BuildConfig() {}
}
"@
# no BOM: javac treats a leading U+FEFF as an illegal character
[System.IO.File]::WriteAllText((Join-Path $bcDir 'BuildConfig.java'), $bcText,
    (New-Object System.Text.UTF8Encoding($false)))

# ------------------------------------------------------------- 3. compile res
Step "Compiling resources (aapt2 compile)"
$resZip = Join-Path $work 'res.zip'
if (Test-Path $resZip) { Remove-Item $resZip -Force }
Run $aapt2 @('compile', '--dir', $res, '-o', $resZip)

# ---------------------------------------------------------- 4. link + R.java
Step "Linking resources (aapt2 link)"
$resApk = Join-Path $work 'resources.apk'
if (Test-Path $resApk) { Remove-Item $resApk -Force }
Run $aapt2 @(
    'link',
    '-o', $resApk,
    '-I', $androidJar,
    '--manifest', $manifest,
    '--java', $genDir,
    '--min-sdk-version', '26',
    '--target-sdk-version', '36',
    '--version-code', "$VersionCode",
    '--version-name', $Version,
    '--rename-manifest-package', 'com.mingyue.dsh',
    $resZip
)

# ------------------------------------------------------------------ 5. javac
Step "Compiling Java"
$sources = @(Get-ChildItem -Path $src, $genDir -Recurse -Filter *.java | ForEach-Object { $_.FullName })
if ($sources.Count -eq 0) { throw "No Java sources found under $src" }
Remove-Item $classes -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $classes | Out-Null

$argFile = Join-Path $work 'sources.txt'
# javac argument files treat backslash as an escape character - always use
# forward slashes here or the paths silently lose their separators.
$sources | ForEach-Object { '"' + ($_ -replace '\\', '/') + '"' } |
    Set-Content -Path $argFile -Encoding ASCII

# android.jar does not carry java.lang.invoke.LambdaMetafactory, which javac
# needs for the invokedynamic call sites behind `->` lambdas.
$lambdaStubs = Join-Path $buildTools 'core-lambda-stubs.jar'
if (-not (Test-Path $lambdaStubs)) { throw "Missing $lambdaStubs" }

Run $javac @(
    '-encoding', 'UTF-8',
    '-source', '8',
    '-target', '8',
    '-bootclasspath', $androidJar,
    '-classpath', "$androidJar;$lambdaStubs",
    '-d', $classes,
    '-nowarn',
    "@$argFile"
)

# --------------------------------------------------------------------- 6. d8
Step "Dexing (d8)"
# d8.bat / apksigner.bat locate java through JAVA_HOME (no java on PATH here).
$env:JAVA_HOME = $jdkHome.FullName
Remove-Item $dexOut -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $dexOut | Out-Null
$classFiles = @(Get-ChildItem -Path $classes -Recurse -Filter *.class | ForEach-Object { $_.FullName })
$d8Args = @('--release', '--lib', $androidJar, '--min-api', '26', '--output', $dexOut) + $classFiles
Run $d8 $d8Args

# ----------------------------------------------------------------- 7. package
Step "Packaging APK"
$unaligned = Join-Path $work 'unaligned.apk'
Copy-Item $resApk $unaligned -Force
Run 'node' @((Join-Path $stage 'tools\adddex.js'), $unaligned, (Join-Path $dexOut 'classes.dex'))

$aligned = Join-Path $work 'aligned.apk'
if (Test-Path $aligned) { Remove-Item $aligned -Force }
Run $zipalign @('-f', '-p', '4', $unaligned, $aligned)

$finalApk = Join-Path $outDir 'mingyue-dsh.apk'

if ($SkipSign) {
    Copy-Item $aligned $finalApk -Force
    CleanupStage
    Write-Host "`nUnsigned APK: $finalApk" -ForegroundColor Yellow
    exit 0
}

# -------------------------------------------------------------------- 8. sign
Step "Signing"
if (-not (Test-Path $keystore)) {
    Write-Host "   creating local keystore (self-signed; password: $ksPass)"
    Run $keytool @(
        '-genkeypair', '-v',
        '-keystore', $keystore,
        '-alias', $ksAlias,
        '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10950',
        '-storepass', $ksPass,
        '-keypass', $ksPass,
        '-dname', 'CN=Mingyue DSH, OU=phone, O=local, L=local, ST=local, C=CN'
    )
}
if (Test-Path $finalApk) { Remove-Item $finalApk -Force }
Run $apksigner @(
    'sign',
    '--ks', $keystore,
    '--ks-key-alias', $ksAlias,
    '--ks-pass', "pass:$ksPass",
    '--key-pass', "pass:$ksPass",
    '--v1-signing-enabled', 'true',
    '--v2-signing-enabled', 'true',
    '--out', $finalApk,
    $aligned
)
Run $apksigner @('verify', '--print-certs', $finalApk)

# ------------------------------------------------------------------ 9. verify
Step "Verifying APK structure"
Run 'node' @((Join-Path $stage 'tools\verifyapk.js'), $finalApk)

$size = [math]::Round((Get-Item $finalApk).Length / 1KB, 1)
CleanupStage
Write-Host "`n============================================" -ForegroundColor Green
Write-Host " APK : $finalApk" -ForegroundColor Green
Write-Host " size: $size KB   built in $([math]::Round($sw.Elapsed.TotalSeconds,1))s" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
