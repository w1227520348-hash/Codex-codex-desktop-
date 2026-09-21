# ============================================================
#  Codex 驾驶舱 —— 撤销 install.ps1 做的所有改动
#  用法：powershell -ExecutionPolicy Bypass -File launch\uninstall.ps1
# ============================================================

[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'

$LaunchDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# 快捷方式
$targets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Codex 驾驶舱.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'Codex 驾驶舱.lnk')
)
foreach ($t in $targets) {
  if (Test-Path $t) {
    Remove-Item $t -Force
    Write-Host "已删除快捷方式：$t"
  }
}

# PATH
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath) {
  $parts = $userPath.Split(';') | Where-Object { $_ -ne '' -and $_ -ne $LaunchDir }
  [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
  Write-Host "已从用户 PATH 中移除 $LaunchDir"
}

# 右键菜单
foreach ($base in @('HKCU:\Software\Classes\Directory\shell', 'HKCU:\Software\Classes\Directory\Background\shell')) {
  $key = Join-Path $base 'CodexDesktop'
  if (Test-Path $key) {
    Remove-Item $key -Recurse -Force
    Write-Host "已移除右键菜单项：$key"
  }
}

Write-Host '卸载完成（应用本体与 ~/.codex-desktop 数据未删除）。'
