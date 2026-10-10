# LabelDesk - Windows 驱动打印辅助脚本
# 由 Rust 后端以「隐藏窗口 + 无配置文件」方式调用：把单色位图按真实物理尺寸交给 Windows 打印驱动。
# 约定：stdout 的最后一行必须是 JSON，供 Rust 解析。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File printer.ps1 -Action Print `
#     -Printer "Deli DL-888D(NEW)" -ImagePath C:\...\x.png -ImageDpi 203 `
#     -DrawWidthHundredths 4000 -DrawHeightHundredths 3000 -Copies 1 -JobName "标签"
#
# 说明：不使用 PrinterSettings.Copies（驱动支持程度不一），而是用多页循环，
# 保证每台打印机、每个品牌驱动都能稳定输出多份。

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('Print')][string]$Action,
    [Parameter(Mandatory = $true)][string]$Printer,
    [Parameter(Mandatory = $true)][string]$ImagePath,
    [double]$ImageDpi = 203,
    [int]$DrawWidthHundredths = 0,
    [int]$DrawHeightHundredths = 0,
    [int]$Copies = 1,
    [string]$JobName = 'LabelDesk 标签'
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

function Write-Result {
    param([bool]$Ok, [string]$Message, [int]$Bytes = 0, [int]$Pages = 0)
    $obj = [ordered]@{ Ok = $Ok; Message = $Message; Bytes = $Bytes; Pages = $Pages }
    Write-Output ($obj | ConvertTo-Json -Compress)
}

function Invoke-Print {
    Add-Type -AssemblyName System.Drawing

    if (-not (Test-Path -LiteralPath $ImagePath)) {
        Write-Result -Ok $false -Message "找不到图像文件：$ImagePath"
        return
    }
    if ($ImageDpi -le 1) { $ImageDpi = 203 }
    if ($Copies -lt 1) { $Copies = 1 }
    if ($Copies -gt 500) { $Copies = 500 }

    $src = [System.Drawing.Image]::FromFile($ImagePath)
    $doc = $null
    try {
        $drawW = if ($DrawWidthHundredths -gt 0) { [double]$DrawWidthHundredths } else { ($src.Width / $ImageDpi) * 100.0 }
        $drawH = if ($DrawHeightHundredths -gt 0) { [double]$DrawHeightHundredths } else { ($src.Height / $ImageDpi) * 100.0 }

        $doc = New-Object System.Drawing.Printing.PrintDocument
        $doc.PrinterSettings.PrinterName = $Printer
        if (-not $doc.PrinterSettings.IsValid) {
            Write-Result -Ok $false -Message "打印机「$Printer」不可用（可能已离线或未安装）"
            return
        }
        $doc.DocumentName = $JobName
        $doc.PrintController = New-Object System.Drawing.Printing.StandardPrintController

        $script:printed = 0
        $script:src = $src
        $script:total = $Copies
        $script:drawW = $drawW
        $script:drawH = $drawH

        $handler = {
            param($sender, $e)
            $g = $e.Graphics
            try { $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic } catch { }
            try { $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality } catch { }
            try { $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality } catch { }

            # 只画图像本身，不铺白底：热敏标签机的空白区域必须保持未加热，否则整张会发黑。
            $rect = New-Object System.Drawing.RectangleF(
                [single]0, [single]0, [single]$script:drawW, [single]$script:drawH)
            $g.DrawImage($script:src, $rect)

            $script:printed++
            $e.HasMorePages = ($script:printed -lt $script:total)
        }
        $doc.add_PrintPage($handler)

        try {
            $doc.Print()
        }
        finally {
            $doc.remove_PrintPage($handler)
        }

        # 走文件端口的虚拟打印机（PDF/XPS）需要调用方自行保存，这里给出明确提示
        $port = ''
        try { $port = $doc.PrinterSettings.PrintFileName } catch { }
        $hint = ''
        if ($port -and $port.Length -gt 0) { $hint = '（该打印机为文件输出，请在弹出的保存对话框中确认位置）' }

        Write-Result -Ok $true -Message ("已提交到打印队列" + $hint) -Bytes ([int](Get-Item -LiteralPath $ImagePath).Length) -Pages $script:printed
    }
    finally {
        if ($null -ne $doc) { $doc.Dispose() }
        $src.Dispose()
    }
}

try {
    switch ($Action) {
        'Print' { Invoke-Print }
    }
}
catch {
    Write-Result -Ok $false -Message ("打印异常：" + $_.Exception.Message)
}
