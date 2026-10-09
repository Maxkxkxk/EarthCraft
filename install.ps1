# EarthCraft installer: builds the mod and installs it into the normal Minecraft launcher.
# Run in PowerShell:  powershell -ExecutionPolicy Bypass -File install.ps1
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$mc = Join-Path $env:APPDATA ".minecraft"
$mcVersion = "1.21.1"
$fabricApi = "0.116.17+1.21.1"

Write-Host "== 1/5 Service dependencies (npm install)"
Push-Location (Join-Path $root "service")
npm install --no-audit --no-fund
Pop-Location

$prebuilt = Get-ChildItem $root -Filter "earthcraft-*.jar" -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch "sources" } | Select-Object -First 1
if ($prebuilt) {
    Write-Host "== 2/5 Using the prebuilt mod $($prebuilt.Name)"
    $jar = $prebuilt
} else {
    Write-Host "== 2/5 Building the mod"
    Push-Location (Join-Path $root "mod")
    $env:GRADLE_OPTS = "-Djavax.net.ssl.trustStoreType=Windows-ROOT"
    .\gradlew.bat build --console=plain
    Pop-Location
    $jar = Get-ChildItem (Join-Path $root "moduild\libs") -Filter "earthcraft-*.jar" | Where-Object { $_.Name -notmatch "sources" } | Select-Object -First 1
}

Write-Host "== 3/5 Fabric Loader for Minecraft $mcVersion"
$tmp = Join-Path $env:TEMP "earthcraft-install"
New-Item -ItemType Directory -Force $tmp | Out-Null
$installer = Join-Path $tmp "fabric-installer.jar"
Invoke-WebRequest "https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.1.2/fabric-installer-1.1.2.jar" -OutFile $installer
java -jar $installer client -mcversion $mcVersion -dir $mc

# More memory for the photorealistic tiles (Fabric profile only).
$profilesFile = Join-Path $mc "launcher_profiles.json"
if (Test-Path $profilesFile) {
    Copy-Item $profilesFile "$profilesFile.bak" -Force
    $profiles = Get-Content $profilesFile -Raw | ConvertFrom-Json
    foreach ($p in $profiles.profiles.PSObject.Properties) {
        if ($p.Value.lastVersionId -like "fabric-loader-*-$mcVersion") {
            $p.Value | Add-Member -Force NoteProperty javaArgs "-Xmx6G -XX:+UseG1GC"
        }
    }
    [IO.File]::WriteAllText($profilesFile, ($profiles | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding $false))
}

Write-Host "== 4/5 Mods (Fabric API + EarthCraft)"
$mods = Join-Path $mc "mods"
New-Item -ItemType Directory -Force $mods | Out-Null
Get-ChildItem $mods -Filter "earthcraft-*.jar" | Remove-Item
Copy-Item $jar.FullName $mods
$apiJar = Join-Path $mods "fabric-api-$fabricApi.jar"
if (-not (Test-Path $apiJar)) {
    Invoke-WebRequest "https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/$fabricApi/fabric-api-$fabricApi.jar" -OutFile $apiJar
}

Write-Host "== 5/5 Config (the mod starts the service by itself)"
$cfgDir = Join-Path $mc "config"
New-Item -ItemType Directory -Force $cfgDir | Out-Null
$cfgFile = Join-Path $cfgDir "earthcraft.json"
if (Test-Path $cfgFile) { $cfg = Get-Content $cfgFile -Raw | ConvertFrom-Json } else { $cfg = [pscustomobject]@{} }
$cfg | Add-Member -Force NoteProperty serviceDir ((Join-Path $root "service") -replace '\\', '/')
[IO.File]::WriteAllText($cfgFile, ($cfg | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))

$svcCfg = Join-Path $root "service\config.json"
if (-not (Test-Path $svcCfg)) { Copy-Item (Join-Path $root "service\config.example.json") $svcCfg }
$key = ""
if (Test-Path $svcCfg) { $key = (Get-Content $svcCfg -Raw | ConvertFrom-Json).apiKey }
Write-Host ""
Write-Host "Fertig. Im Minecraft Launcher das Profil 'fabric-loader-$mcVersion' starten."
if ((-not $key) -or ($key -like "PASTE_*")) {
    Write-Host "WICHTIG: Trage noch deinen Google API-Schluessel in service\config.json ein (siehe README.md)." -ForegroundColor Yellow
}
