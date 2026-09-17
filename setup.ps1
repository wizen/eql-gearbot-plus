# Lives in the suite root, next to eql-gearbot-plus-source\ - this is the local
# convenience version of setup.ps1, specific to this machine. It builds
# FROM the read-only eql-gearbot-plus-source\ copy (never writes there - only ever
# copies out of it) instead of from a working eql-merc-suite\/gearbot-website\
# folder, so the deploy package always comes from a known-clean source no
# matter what's happened to any other copy on this machine.
#
# What it does:
#   1. Reads !fill_me_out_first.ini (see below) - stops if it's missing or
#      any required value is still a placeholder.
#   2. Copies eql-gearbot-plus-source\eql-merc-suite and eql-gearbot-plus-source\gearbot-website
#      into a fresh FOR_UPLOAD\ folder, created right next to this script
#      (deletes any previous FOR_UPLOAD\ first).
#   3. Generates FOR_UPLOAD\eql-merc-suite\.env and FOR_UPLOAD\gearbot-website\.env
#      from !fill_me_out_first.ini's values - you never hand-edit either
#      .env file, and GUILD_NAME only has to be typed once.
#   4. npm install in FOR_UPLOAD\eql-merc-suite
#   5. npm install + npm run build in FOR_UPLOAD\gearbot-website (using the
#      .env just generated, so VITE_ variables get baked in correctly)
#   6. Copies the built website into FOR_UPLOAD\eql-merc-suite\website-dist
#   7. Zips FOR_UPLOAD\eql-merc-suite's contents - INCLUDING the generated
#      .env - into FOR_UPLOAD\eql-gearbot-plus-deploy.zip. That zip is the
#      thing you upload to your host, already configured: extract it and
#      start the bot, nothing left to fill in on the server. Minus dev-only
#      files and, deliberately, minus any database file (see below).
#
# !fill_me_out_first.ini (next to this script) is the single file you fill
# out - every environment variable used anywhere in the suite has a spot
# in it. If it doesn't exist, this script creates it with placeholders and
# stops so you can fill it in; run the script again once you have.
#
# This does NOT use PowerShell's Compress-Archive cmdlet - on at least one
# real machine it wrote zip entry paths as literal backslashes instead of
# proper forward-slash zip paths, which Windows tolerates but a Linux host's
# unzip does not, silently corrupting the archive. This script instead
# builds the zip directly with .NET's ZipArchive API and forces every entry
# name to use forward slashes explicitly.
#
# No gear_inventory.db ships in the zip - db.js creates a fresh, empty one
# automatically the first time the bot starts against a folder that doesn't
# already have one. If you're updating an existing deployment and want to
# keep its data, just don't delete that file on the server before you
# extract; if you want a clean slate, delete it there first.
#
# The generated .env DOES ship in the zip (see step 7) - unlike a lot of
# advice you'll see elsewhere, that's deliberate here: this zip goes
# straight to your own private host, never anywhere public, and shipping a
# working .env is the whole point of filling out !fill_me_out_first.ini in
# the first place. Never commit FOR_UPLOAD\ or !fill_me_out_first.ini once
# it's filled out - .gitignore should already keep them out of git.
#
# Expected layout (both as siblings of this script):
#   setup.ps1 (this file)
#   setup.bat
#   !fill_me_out_first.ini (auto-created with placeholders on first run if missing)
#   eql-gearbot-plus-source\eql-merc-suite\
#   eql-gearbot-plus-source\gearbot-website\
#
# Usage (from PowerShell, or double-click setup.bat):
#   .\setup.ps1

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.Windows.Forms

$scriptDir = $PSScriptRoot
$srcBot = Join-Path $scriptDir 'eql-gearbot-plus-source\eql-merc-suite'
$srcWebsite = Join-Path $scriptDir 'eql-gearbot-plus-source\gearbot-website'

if (-not (Test-Path $srcBot)) {
    Write-Error "Couldn't find eql-gearbot-plus-source\eql-merc-suite next to this script at $srcBot."
    exit 1
}
if (-not (Test-Path $srcWebsite)) {
    Write-Error "Couldn't find eql-gearbot-plus-source\gearbot-website next to this script at $srcWebsite."
    exit 1
}

# ---- !fill_me_out_first.ini: single source of truth for every env value ----

$iniTemplate = @'
; !fill_me_out_first.ini
;
; The one file to fill out before running setup.ps1. Every environment
; variable used anywhere in the suite - the Discord bot, its web API, and
; the companion website - has a spot here. Fill this in once, save it, and
; setup.ps1 generates eql-merc-suite/.env and gearbot-website/.env for you
; from these values (into FOR_UPLOAD, ready to zip and deploy) - you never
; hand-edit either .env file directly.
;
; Lines starting with ; or # are comments and are ignored, as are blank
; lines. Leave WEBSITE_DIST_PATH commented out unless you actually need to
; override it (see below).

; ---------------------------------------------------------------------
; Discord application (create one at https://discord.com/developers/applications)
; ---------------------------------------------------------------------
DISCORD_TOKEN=your_discord_bot_token_here
CLIENT_ID=your_discord_application_client_id_here
DISCORD_CLIENT_SECRET=your_discord_application_client_secret_here
GUILD_ID=your_guild_id_here
AUTHORIZED_ROLE_IDS=123456789012345678,987654321098765432

; ---------------------------------------------------------------------
; Your guild - used once here, written into both the bot's GUILD_NAME and
; the website's VITE_GUILD_NAME automatically. No <> tag brackets needed.
; ---------------------------------------------------------------------
GUILD_NAME=your_guild_name_here

; ---------------------------------------------------------------------
; Where this is deployed. One process serves the bot, the API, and the
; built website together, so WEBSITE_URL, OAUTH_REDIRECT_URI, and
; VITE_API_URL all point at wherever that process is reachable. Under
; OAuth2 in the Discord Developer Portal, add a redirect URL that matches
; OAUTH_REDIRECT_URI exactly.
;
; Shown below with example values for a domain with TLS terminated for you
; (most PaaS-style hosts, including Wispbyte) - swap your-domain-here for
; your real one and set API_PORT to whatever your host assigns. If your
; host does NOT terminate TLS for you, use http:// instead and set
; COOKIE_SECURE to false - a browser silently refuses to send a cookie
; marked Secure over plain HTTP, so getting this backwards looks like
; login "does nothing" after the Discord redirect.
; ---------------------------------------------------------------------
WEBSITE_URL=https://your-domain-here
OAUTH_REDIRECT_URI=https://your-domain-here/auth/callback
VITE_API_URL=https://your-domain-here
API_PORT=3001
COOKIE_SECURE=true

; ---------------------------------------------------------------------
; Session security - generate a random string with:
;   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
; ---------------------------------------------------------------------
SESSION_SECRET=change_this_to_a_random_string

; ---------------------------------------------------------------------
; Usually fine left as-is.
; ---------------------------------------------------------------------
NODE_ENV=production

; On Linux hosts, cardRenderer.js prefers a self-contained Chromium build
; (@sparticuz/chromium) so /g-card rendering works with no system Chromium
; installed. Leave this true; it only matters if that path breaks and it
; falls back to downloading a full Chromium at npm-install time.
PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

; Only set this if you're putting the built website somewhere other than
; the default ./website-dist folder inside eql-merc-suite. Leave commented
; out otherwise.
;WEBSITE_DIST_PATH=./website-dist
'@

# Fields that must be changed from their shipped placeholder before this
# script will proceed. Anything not listed here (API_PORT, NODE_ENV,
# COOKIE_SECURE, PUPPETEER_SKIP_CHROMIUM_DOWNLOAD, WEBSITE_DIST_PATH) has a
# sensible default and doesn't require action.
$requiredPlaceholders = [ordered]@{
    DISCORD_TOKEN          = 'your_discord_bot_token_here'
    CLIENT_ID              = 'your_discord_application_client_id_here'
    DISCORD_CLIENT_SECRET  = 'your_discord_application_client_secret_here'
    GUILD_ID               = 'your_guild_id_here'
    AUTHORIZED_ROLE_IDS    = '123456789012345678,987654321098765432'
    GUILD_NAME             = 'your_guild_name_here'
    WEBSITE_URL            = 'https://your-domain-here'
    OAUTH_REDIRECT_URI     = 'https://your-domain-here/auth/callback'
    VITE_API_URL           = 'https://your-domain-here'
    SESSION_SECRET         = 'change_this_to_a_random_string'
}

function Read-IniValues {
    param($path)
    $values = @{}
    foreach ($line in Get-Content $path) {
        $trimmed = $line.Trim()
        if ($trimmed -eq '' -or $trimmed.StartsWith('#') -or $trimmed.StartsWith(';')) { continue }
        if ($trimmed -match '^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            $values[$matches[1]] = $matches[2].Trim()
        }
    }
    return $values
}

function Get-FillMeOutValues {
    param($path)

    if (-not (Test-Path $path)) {
        Set-Content -Path $path -Value $iniTemplate -Encoding utf8
        Write-Error "Created !fill_me_out_first.ini next to this script - open it, fill in your values, and run this script again."
        exit 1
    }

    $values = Read-IniValues -path $path

    $unfilled = @()
    foreach ($key in $requiredPlaceholders.Keys) {
        $current = $values[$key]
        if ((-not $current) -or ($current -eq $requiredPlaceholders[$key])) {
            $unfilled += $key
        }
    }
    if ($unfilled.Count -gt 0) {
        Write-Error "!fill_me_out_first.ini still has placeholder values for: $($unfilled -join ', '). Open it and fill those in, then run this script again."
        exit 1
    }

    return $values
}

$iniPath = Join-Path $scriptDir '!fill_me_out_first.ini'
$envValues = Get-FillMeOutValues -path $iniPath
Write-Host "Using values from !fill_me_out_first.ini (guild: '$($envValues['GUILD_NAME'])')"

$uploadDir = Join-Path $scriptDir 'FOR_UPLOAD'
$botFolder = Join-Path $uploadDir 'eql-merc-suite'
$website = Join-Path $uploadDir 'gearbot-website'
$distOut = Join-Path $botFolder 'website-dist'

Write-Host "Setting up a fresh FOR_UPLOAD folder from eql-gearbot-plus-source (eql-gearbot-plus-source is only ever read, never written)..."
if (Test-Path $uploadDir) {
    Remove-Item -Recurse -Force $uploadDir
}
New-Item -ItemType Directory -Path $uploadDir | Out-Null
Copy-Item -Recurse -Force $srcBot $botFolder
Copy-Item -Recurse -Force $srcWebsite $website

# ---- Generate both real .env files from !fill_me_out_first.ini ----

$botEnvLines = @(
    "# Generated by setup.ps1 from !fill_me_out_first.ini - do not edit by hand,"
    "# edit !fill_me_out_first.ini instead and re-run setup.ps1."
    "DISCORD_TOKEN=$($envValues['DISCORD_TOKEN'])"
    "CLIENT_ID=$($envValues['CLIENT_ID'])"
    "GUILD_ID=$($envValues['GUILD_ID'])"
    "AUTHORIZED_ROLE_IDS=$($envValues['AUTHORIZED_ROLE_IDS'])"
    "GUILD_NAME=$($envValues['GUILD_NAME'])"
    "PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=$($envValues['PUPPETEER_SKIP_CHROMIUM_DOWNLOAD'])"
    "DISCORD_CLIENT_SECRET=$($envValues['DISCORD_CLIENT_SECRET'])"
    "WEBSITE_URL=$($envValues['WEBSITE_URL'])"
    "OAUTH_REDIRECT_URI=$($envValues['OAUTH_REDIRECT_URI'])"
    "API_PORT=$($envValues['API_PORT'])"
    "SESSION_SECRET=$($envValues['SESSION_SECRET'])"
    "NODE_ENV=$($envValues['NODE_ENV'])"
    "COOKIE_SECURE=$($envValues['COOKIE_SECURE'])"
)
if ($envValues.ContainsKey('WEBSITE_DIST_PATH') -and $envValues['WEBSITE_DIST_PATH']) {
    $botEnvLines += "WEBSITE_DIST_PATH=$($envValues['WEBSITE_DIST_PATH'])"
}
Set-Content -Path (Join-Path $botFolder '.env') -Value $botEnvLines -Encoding utf8

$websiteEnvLines = @(
    "# Generated by setup.ps1 from !fill_me_out_first.ini - do not edit by hand,"
    "# edit !fill_me_out_first.ini instead and re-run setup.ps1."
    "VITE_API_URL=$($envValues['VITE_API_URL'])"
    "VITE_GUILD_NAME=$($envValues['GUILD_NAME'])"
)
Set-Content -Path (Join-Path $website '.env') -Value $websiteEnvLines -Encoding utf8

Write-Host "Generated .env for both eql-merc-suite and gearbot-website from !fill_me_out_first.ini."

Write-Host "Installing eql-merc-suite dependencies..."
Push-Location $botFolder
try {
    npm install
} finally {
    Pop-Location
}

Write-Host "Installing gearbot-website dependencies and building..."
Push-Location $website
try {
    npm install
    npm run build
} finally {
    Pop-Location
}

if (Test-Path $distOut) {
    Remove-Item -Recurse -Force $distOut
}
Copy-Item -Recurse (Join-Path $website 'dist') $distOut
Write-Host "Website build copied to $distOut"

# Files/folders to leave OUT of the deploy zip. gear_inventory.db is
# excluded so a fresh deploy always starts from an empty database unless
# you keep an existing one on the server yourself (see header). Unlike an
# earlier version of this script, .env is NOT excluded - it's generated
# fresh from !fill_me_out_first.ini for this deploy and is meant to ship.
$excludeNames = @('.git', 'gear_inventory.db', 'node_modules', 'website-src', '.install-stamp', 'scripts')

function Get-PackageFiles {
    param($root, $excludeNames)
    Get-ChildItem -Path $root -Recurse -File -Force | Where-Object {
        $rel = $_.FullName.Substring($root.Length + 1)
        $parts = $rel -split '[\\/]'
        -not ($parts | Where-Object { $excludeNames -contains $_ })
    }
}

$zipOut = Join-Path $uploadDir 'eql-gearbot-plus-deploy.zip'
if (Test-Path $zipOut) {
    Remove-Item -Force $zipOut
}

Write-Host "Assembling $zipOut ..."
$zip = [System.IO.Compression.ZipFile]::Open($zipOut, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    $files = Get-PackageFiles -root $botFolder -excludeNames $excludeNames
    foreach ($f in $files) {
        $relativePath = $f.FullName.Substring($botFolder.Length + 1)
        $entryName = $relativePath -replace '\\', '/'
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $entryName, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
    Write-Host "Added $($files.Count) files."
} finally {
    $zip.Dispose()
}

Write-Host ""
Write-Host "Done: $zipOut"
Write-Host "eql-gearbot-plus-source was only read, never written to. Everything else is inside FOR_UPLOAD, which you can delete any time - it's regenerated from scratch on the next run."
Write-Host "No database file is in this package - the bot creates a fresh one on first start."
Write-Host "A working .env (generated from !fill_me_out_first.ini) IS in this package - nothing left to fill in on the server."
Write-Host ""
Write-Host "On your server:"
Write-Host "  1. If you want a clean slate, delete gear_inventory.db there (otherwise your existing data is kept)."
Write-Host "  2. Extract $($zipOut | Split-Path -Leaf) into the bot's folder there - its .env is already filled in."
Write-Host "  3. Start the bot (npm install first if your host doesn't do that automatically)."

# Popup, not just console text, since it's easy to miss a warning scrolled
# past in a terminal - this one's worth actually seeing. You probably
# already know and intend this (that's the whole point of the ini), but
# better to say it plainly than have it happen silently.
$popupMessage = "Deploy package ready:`n$zipOut`n`n" +
    "Heads up: your real secrets (Discord bot token, client secret, " +
    "session secret) are filled into FOR_UPLOAD\eql-merc-suite\.env AND " +
    "into the zip itself - not just placeholders. That's meant to go " +
    "straight to your own private host. Don't upload or share this zip " +
    "anywhere public."
[System.Windows.Forms.MessageBox]::Show(
    $popupMessage,
    "EQL Gearbot Plus - deploy package ready",
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Information
) | Out-Null
