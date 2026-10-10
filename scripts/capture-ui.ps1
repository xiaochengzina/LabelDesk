# 启动 LabelDesk 并抓取窗口截图（开发验证用）
#
# 用法：
#   pwsh -File scripts/capture-ui.ps1 -Out docs/screenshot-operator.png
#
# 注意：C# 源码必须放在**单引号** here-string 里。用双引号时 PowerShell 会展开
# 其中的 $w / $ht 等标识符，把 C# 代码改坏（这个坑踩过一次）。

param(
    [string]$Out = "docs/screenshot-operator.png",
    [int]$WaitSeconds = 8,
    [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

if (-not ("WinCap" -as [type])) {
    Add-Type -ReferencedAssemblies System.Drawing @'
using System;
using System.Runtime.InteropServices;
public class WinCap {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static bool Grab(IntPtr h, string path, out int w, out int ht) {
    RECT r; w = 0; ht = 0;
    if (!GetWindowRect(h, out r)) return false;
    w = r.Right - r.Left; ht = r.Bottom - r.Top;
    if (w <= 0 || ht <= 0) return false;
    using (var bmp = new System.Drawing.Bitmap(w, ht))
    using (var g = System.Drawing.Graphics.FromImage(bmp)) {
      IntPtr hdc = g.GetHdc();
      PrintWindow(h, hdc, 2);
      g.ReleaseHdc(hdc);
      bmp.Save(path, System.Drawing.Imaging.ImageFormat.Png);
    }
    return true;
  }
}
'@
}

# 允许从任意工作目录调用：优先用参数，其次用当前目录
$repoRoot = if ($RepoRoot) { $RepoRoot } elseif ($PSScriptRoot) { Split-Path -Parent $PSScriptRoot } else { (Get-Location).Path }
$exe = Join-Path $repoRoot "src-tauri\target\release\labeldesk.exe"
if (-not (Test-Path $exe)) { throw "找不到可执行文件：$exe（先运行 npm run app:build）" }

$proc = Start-Process -FilePath $exe -PassThru
try {
    $handle = [IntPtr]::Zero
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 400
        $p = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
        if ($p -and $p.MainWindowHandle -ne 0) { $handle = $p.MainWindowHandle; break }
    }
    if ($handle -eq [IntPtr]::Zero) { throw "窗口未就绪" }
    Start-Sleep -Seconds $WaitSeconds

    $outPath = Join-Path $repoRoot $Out
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $outPath) | Out-Null
    $winW = 0
    $winH = 0
    if (-not [WinCap]::Grab($handle, $outPath, [ref]$winW, [ref]$winH)) { throw "抓取失败" }
    Write-Output "已截图 ${winW}x${winH} -> $outPath"
}
finally {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
}
