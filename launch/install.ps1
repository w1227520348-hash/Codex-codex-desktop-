# ============================================================
#  Codex 驾驶舱 —— 安装「任意文件夹启动」的入口
#
#  做了四件事（全部只影响当前用户，不需要管理员）：
#    1. 确保应用已构建
#    2. 桌面快捷方式
#    3. 开始菜单快捷方式
#    4. 把 <app>\launch 加进用户 PATH —— 之后任意终端敲 codex-desktop 即可
#    5. 资源管理器右键文件夹 → 「在 Codex 驾驶舱中打开」（加 -NoContextMenu 可跳过）
#
#  用法：
#    powershell -ExecutionPolicy Bypass -File launch\install.ps1
#    powershell -ExecutionPolicy Bypass -File launch\install.ps1 -NoContextMenu
# ============================================================

[CmdletBinding()]
param(
  [switch]$NoContextMenu,
  [switch]$NoPath
)

$ErrorActionPreference = 'Stop'

$LaunchDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppDir = (Resolve-Path (Join-Path $LaunchDir '..')).Path
$Entry = Join-Path $AppDir 'out\main\index.js'
$Electron = Join-Path $AppDir 'node_modules\electron\dist\electron.exe'
$Launcher = Join-Path $LaunchDir 'codex-desktop.cmd'

Write-Host "应用目录：$AppDir"

# ---------- 1. 构建 ----------
if (-not (Test-Path $Entry)) {
  Write-Host '未找到构建产物，正在构建…'
  Push-Location $AppDir
  try {
    & npm run build
  } finally {
    Pop-Location
  }
}
if (-not (Test-Path $Entry)) { throw "构建失败：找不到 $Entry" }
if (-not (Test-Path $Electron)) { throw "缺少 Electron 运行时：$Electron`n请先执行 npm install（或 node node_modules\electron\install.js）" }

# ---------- 2/3. 快捷方式 ----------
function New-Shortcut([string]$Path) {
  $dir = Split-Path -Parent $Path
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $shell = New-Object -ComObject WScript.Shell
  $sc = $shell.CreateShortcut($Path)
  $sc.TargetPath = $Electron
  $sc.Arguments = '"' + $Entry + '"'
  $sc.WorkingDirectory = $AppDir
  $sc.Description = 'Codex 驾驶舱（Codex CLI + DeepSeek 图形化驾驶舱）'
  $sc.IconLocation = "$Electron,0"
  $sc.Save()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell) | Out-Null
}

$desktop = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Codex 驾驶舱.lnk'
New-Shortcut (Join-Path $desktop 'Codex 驾驶舱.lnk')
New-Shortcut $startMenu
Write-Host "已创建快捷方式：$desktop\Codex 驾驶舱.lnk"
Write-Host "已创建快捷方式：$startMenu"

# ---------- 4. PATH ----------
if (-not $NoPath) {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not $userPath) { $userPath = '' }
  $parts = $userPath.Split(';') | Where-Object { $_ -ne '' }
  if ($parts -notcontains $LaunchDir) {
    $newPath = (@($parts) + $LaunchDir) -join ';'
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    Write-Host "已把 $LaunchDir 加入用户 PATH（新开的终端生效）"
  } else {
    Write-Host "用户 PATH 中已包含 $LaunchDir"
  }
}

# ---------- 5. 右键菜单 ----------
if (-not $NoContextMenu) {
  $cmd = '"' + $Electron + '" "' + $Entry + '" "%V"'
  foreach ($base in @('HKCU:\Software\Classes\Directory\shell', 'HKCU:\Software\Classes\Directory\Background\shell')) {
    $key = Join-Path $base 'CodexDesktop'
    New-Item -Path $key -Force | Out-Null
    New-ItemProperty -Path $key -Name '(default)' -Value '在 Codex 驾驶舱中打开' -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $key -Name 'Icon' -Value $Electron -PropertyType String -Force | Out-Null
    New-Item -Path (Join-Path $key 'command') -Force | Out-Null
    New-ItemProperty -Path (Join-Path $key 'command') -Name '(default)' -Value $cmd -PropertyType String -Force | Out-Null
  }
  Write-Host '已注册资源管理器右键菜单：在 Codex 驾驶舱中打开'
}

Write-Host ''
Write-Host '完成。现在可以：'
Write-Host '  * 双击桌面「Codex 驾驶舱」'
Write-Host '  * 任意终端里执行：codex-desktop .    （用当前目录作为工作区）'
Write-Host '  * 在资源管理器里右键文件夹 →「在 Codex 驾驶舱中打开」'
Write-Host ''
Write-Host '卸载：powershell -ExecutionPolicy Bypass -File launch\uninstall.ps1'
