# 撤销 dsh-neighbor 的安装（改坏了就跑这个）
$ErrorActionPreference = 'Stop'
$prof = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$link = Join-Path $prof 'node_modules\dsh-neighbor'

if (Test-Path -LiteralPath $link) {
  (Get-Item -LiteralPath $link -Force).Delete()
  Write-Host 'junction 已删除'
} else {
  Write-Host 'junction 不存在，跳过'
}

$bak = Get-ChildItem -LiteralPath $prof -Filter 'package.json.bak_bridge_*' |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($bak) {
  Copy-Item -LiteralPath $bak.FullName -Destination (Join-Path $prof 'package.json') -Force
  Write-Host "package.json 已恢复：$($bak.Name)"
} else {
  Write-Host '找不到备份，package.json 未改动'
}
Write-Host '完成。重启 DSH 即回到装插件之前。'
