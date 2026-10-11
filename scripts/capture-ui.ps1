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
    [string]$RepoRoot = "",
    [int]$ClickX = 0,
    [int]$ClickY = 0
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
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, IntPtr dwExtraInfo);
  public static void Click(IntPtr h, int relX, int relY) {
    SetForegroundWindow(h);
    ShowWindow(h, 5);
    System.Threading.Thread.Sleep(400);
    RECT r;
    GetWindowRect(h, out r);
    int x = r.Left + relX;
    int y = r.Top + relY;
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(150);
    mouse_event(0x0002, 0, 0, 0, IntPtr.Zero);   // left down
    System.Threading.Thread.Sleep(60);
    mouse_event(0x0004, 0, 0, 0, IntPtr.Zero);   // left up
    System.Threading.Thread.Sleep(900);
  }
  /// 从屏幕直接抓取窗口矩形。PrintWindow 对 WebView2 有时会返回黑屏
  /// （尤其窗口刚被激活时），这种情况下用屏幕抓取更可靠。
  public static bool GrabFromScreen(IntPtr h, string path, out int w, out int ht) {
    RECT r; w = 0; ht = 0;
    SetForegroundWindow(h);
    ShowWindow(h, 5);
    System.Threading.Thread.Sleep(900);
    if (!GetWindowRect(h, out r)) return false;
    w = r.Right - r.Left; ht = r.Bottom - r.Top;
    if (w <= 0 || ht <= 0) return false;
    using (var bmp = new System.Drawing.Bitmap(w, ht))
    using (var g = System.Drawing.Graphics.FromImage(bmp)) {
      g.CopyFromScreen(r.Left, r.Top, 0, 0, new System.Drawing.Size(w, ht));
      bmp.Save(path, System.Drawing.Imaging.ImageFormat.Png);
    }
    return true;
  }
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
    if ($ClickX -gt 0 -and $ClickY -gt 0) {
        [WinCap]::Click($handle, $ClickX, $ClickY)
        Start-Sleep -Seconds 2
    }
    $grabbed = [WinCap]::GrabFromScreen($handle, $outPath, [ref]$winW, [ref]$winH)
    if (-not $grabbed) {
        # 屏幕抓取不可用时退回 PrintWindow
        $grabbed = [WinCap]::Grab($handle, $outPath, [ref]$winW, [ref]$winH)
    }
    if (-not $grabbed) { throw "抓取失败" }
    Write-Output "已截图 ${winW}x${winH} -> $outPath"
}
finally {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
}
