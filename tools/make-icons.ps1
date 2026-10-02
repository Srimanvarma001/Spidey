# Regenerates extension/icons/icon{16,32,48,128}.png.
#
# The artwork is drawn on a 128 unit grid at 8x and scaled down, which gives much cleaner
# edges than drawing at the final size. Small sizes use a simpler drawing: a zigzag leg with
# three joints is noise at 16 px.
#
#   .\tools\make-icons.ps1                      write the icons
#   .\tools\make-icons.ps1 -Preview sheet.png   also write a sheet with every size enlarged
param([string]$Preview)

Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot '..\extension\icons'
New-Item -ItemType Directory -Force $outDir | Out-Null

$sizes = 16, 32, 48, 128
$super = 8

function Get-Color([string]$hex, [int]$alpha = 255) {
    $c = [System.Drawing.ColorTranslator]::FromHtml($hex)
    [System.Drawing.Color]::FromArgb($alpha, $c.R, $c.G, $c.B)
}

function New-RoundRect([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    $p
}

function New-RoundPen([System.Drawing.Color]$color, [single]$width) {
    $pen = New-Object System.Drawing.Pen $color, $width
    $pen.StartCap = 'Round'; $pen.EndCap = 'Round'; $pen.LineJoin = 'Round'
    $pen
}

# Legs as point lists (x, y, x, y, ...) for the left side; the right side is mirrored.
function Draw-Legs($g, $legs, [single]$width, [single]$dot, [bool]$allJoints) {
    $pen = New-RoundPen (Get-Color '#56b6f6') $width
    $joint = New-Object System.Drawing.SolidBrush (Get-Color '#ff3e6e')
    foreach ($leg in $legs) {
        foreach ($mirror in $false, $true) {
            $pts = for ($i = 0; $i -lt $leg.Count; $i += 2) {
                $x = if ($mirror) { 128 - $leg[$i] } else { $leg[$i] }
                New-Object System.Drawing.PointF $x, $leg[$i + 1]
            }
            $g.DrawLines($pen, [System.Drawing.PointF[]]$pts)
            $first = if ($allJoints) { 1 } else { $pts.Count - 1 }
            foreach ($p in $pts[$first..($pts.Count - 1)]) {
                $g.FillEllipse($joint, $p.X - $dot, $p.Y - $dot, $dot * 2, $dot * 2)
            }
        }
    }
}

function Draw-Body($g, [single]$w, [single]$h, [single]$stroke, [single]$head) {
    $x = 64 - $w / 2; $y = 64 - $h / 2
    $body = New-RoundRect $x $y $w $h ($w * 0.36)
    $fill = New-Object System.Drawing.Drawing2D.LinearGradientBrush `
        (New-Object System.Drawing.PointF 0, $y), (New-Object System.Drawing.PointF 0, ($y + $h)), `
        (Get-Color '#2a3391'), (Get-Color '#141a55')
    $g.FillPath($fill, $body)
    $g.DrawPath((New-RoundPen (Get-Color '#5a6eff') $stroke), $body)
    $hy = $y + $stroke / 2 + $head + 2
    $g.FillEllipse((New-Object System.Drawing.SolidBrush (Get-Color '#46e2ff')), 64 - $head, $hy - $head, $head * 2, $head * 2)
}

function Draw-Icon($g, [bool]$detailed) {
    # Tile: a dark rounded square, lighter at the top, with a soft blue glow under the spider.
    $tile = New-RoundRect 0 0 128 128 28
    $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush `
        (New-Object System.Drawing.PointF 0, 0), (New-Object System.Drawing.PointF 0, 128), `
        (Get-Color '#1b2145'), (Get-Color '#090b17')
    $g.FillPath($bg, $tile)

    $halo = New-Object System.Drawing.Drawing2D.GraphicsPath
    $halo.AddEllipse(4, 12, 120, 120)
    $glow = New-Object System.Drawing.Drawing2D.PathGradientBrush $halo
    $glow.CenterColor = Get-Color '#5a6eff' 85
    $glow.SurroundColors = @((Get-Color '#5a6eff' 0))
    $g.SetClip($tile)
    $g.FillPath($glow, $halo)
    $g.ResetClip()

    if (-not $detailed) {
        # Small sizes: upright, thick strokes, one bend per leg, dots on the feet only.
        Draw-Legs $g @(
            @(58, 46, 30, 30, 14, 46),
            @(58, 64, 30, 60, 12, 78),
            @(58, 82, 30, 98, 14, 112)
        ) 9 7.5 $false
        Draw-Body $g 30 66 9 7
        return
    }

    # The link the spider is holding: a cyan box with a line of "text", top right.
    $cyan = Get-Color '#46e2ff'
    $g.DrawPath((New-RoundPen $cyan 3.5), (New-RoundRect 84 14 34 16 4))
    $g.DrawLine((New-RoundPen (Get-Color '#46e2ff' 150) 3.5), 91, 22, 111, 22)

    # The thread from the head to the box, then the spider itself, turned toward the box.
    $g.DrawLine((New-RoundPen (Get-Color '#56b6f6') 3.5), 68, 57, 92, 30)

    $state = $g.Save()
    $g.TranslateTransform(62, 72)
    $g.RotateTransform(22)
    $g.ScaleTransform(0.8, 0.8)
    $g.TranslateTransform(-64, -64)
    Draw-Legs $g @(
        @(58, 48, 38, 24, 28, 46, 10, 24),
        @(58, 64, 36, 52, 26, 76, 8, 62),
        @(58, 80, 38, 104, 28, 82, 10, 104)
    ) 4.6 5 $true
    Draw-Body $g 24 58 5.5 5.5
    $g.Restore($state)
}

$made = @()
foreach ($size in $sizes) {
    $big = New-Object System.Drawing.Bitmap ($size * $super), ($size * $super)
    $g = [System.Drawing.Graphics]::FromImage($big)
    $g.SmoothingMode = 'AntiAlias'
    $g.PixelOffsetMode = 'HighQuality'
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.ScaleTransform($size * $super / 128, $size * $super / 128)
    Draw-Icon $g ($size -ge 64)
    $g.Dispose()

    $icon = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($icon)
    $g.InterpolationMode = 'HighQualityBicubic'
    $g.PixelOffsetMode = 'HighQuality'
    $g.CompositingQuality = 'HighQuality'
    $g.DrawImage($big, 0, 0, $size, $size)
    $g.Dispose()
    $big.Dispose()

    $icon.Save((Join-Path $outDir "icon$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $made += $icon
}
Write-Host "Icons written to $outDir"

if ($Preview) {
    # Every size blown up to 128 px without smoothing, on light and dark toolbars.
    $sheet = New-Object System.Drawing.Bitmap (148 * $made.Count + 20), 316
    $g = [System.Drawing.Graphics]::FromImage($sheet)
    $g.InterpolationMode = 'NearestNeighbor'
    $g.PixelOffsetMode = 'Half'
    $g.FillRectangle((New-Object System.Drawing.SolidBrush (Get-Color '#f1f3f4')), 0, 0, $sheet.Width, 158)
    $g.FillRectangle((New-Object System.Drawing.SolidBrush (Get-Color '#202124')), 0, 158, $sheet.Width, 158)
    for ($i = 0; $i -lt $made.Count; $i++) {
        $g.DrawImage($made[$i], 20 + $i * 148, 15, 128, 128)
        $g.DrawImage($made[$i], 20 + $i * 148, 173, 128, 128)
    }
    $g.Dispose()
    $sheet.Save($Preview, [System.Drawing.Imaging.ImageFormat]::Png)
    $sheet.Dispose()
    Write-Host "Preview written to $Preview"
}
$made | ForEach-Object { $_.Dispose() }
