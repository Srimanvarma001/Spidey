# Regenerates extension/icons/icon{16,48,128}.png: the spider on a dark tile.
Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot '..\extension\icons'
New-Item -ItemType Directory -Force $outDir | Out-Null

function Get-Color([string]$hex) { [System.Drawing.ColorTranslator]::FromHtml($hex) }

foreach ($size in 16, 48, 128) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.Clear([System.Drawing.Color]::Transparent)
    # Everything below is drawn on a 128 unit grid.
    $g.ScaleTransform($size / 128, $size / 128)

    # Rounded dark tile
    $tile = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = 48
    $tile.AddArc(0, 0, $d, $d, 180, 90)
    $tile.AddArc(128 - $d, 0, $d, $d, 270, 90)
    $tile.AddArc(128 - $d, 128 - $d, $d, $d, 0, 90)
    $tile.AddArc(0, 128 - $d, $d, $d, 90, 90)
    $tile.CloseFigure()
    $g.FillPath((New-Object System.Drawing.SolidBrush (Get-Color '#101418')), $tile)

    # Legs: hip -> knee -> foot, mirrored left and right
    $legPen = New-Object System.Drawing.Pen (Get-Color '#4fc3ff'), 6
    $legPen.StartCap = 'Round'; $legPen.EndCap = 'Round'; $legPen.LineJoin = 'Round'
    $joint = New-Object System.Drawing.SolidBrush (Get-Color '#ff4f7b')
    $legs = @(
        @(58, 46, 34, 22, 16, 40),
        @(58, 58, 28, 46, 10, 66),
        @(58, 70, 28, 82, 10, 62),
        @(58, 82, 34, 106, 16, 88)
    )
    foreach ($l in $legs) {
        foreach ($mirror in $false, $true) {
            $p = $l | ForEach-Object { $_ }
            if ($mirror) { $p[0] = 128 - $p[0]; $p[2] = 128 - $p[2]; $p[4] = 128 - $p[4] }
            $g.DrawLines($legPen, [System.Drawing.PointF[]]@(
                (New-Object System.Drawing.PointF $p[0], $p[1]),
                (New-Object System.Drawing.PointF $p[2], $p[3]),
                (New-Object System.Drawing.PointF $p[4], $p[5])))
            $g.FillEllipse($joint, $p[2] - 6, $p[3] - 6, 12, 12)
            $g.FillEllipse($joint, $p[4] - 6, $p[5] - 6, 12, 12)
        }
    }

    # Body and head dot
    $g.FillRectangle((New-Object System.Drawing.SolidBrush (Get-Color '#12163a')), 52, 34, 24, 60)
    $g.DrawRectangle((New-Object System.Drawing.Pen (Get-Color '#5b7cfa'), 6), 52, 34, 24, 60)
    $g.FillEllipse((New-Object System.Drawing.SolidBrush (Get-Color '#5ef0ff')), 58, 40, 12, 12)

    $g.Dispose()
    $bmp.Save((Join-Path $outDir "icon$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

Write-Host "Icons written to $outDir"
