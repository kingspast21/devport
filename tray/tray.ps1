# devport tray icon. Started by server.js; one instance per port.
# Shows the number of running dev servers, lists them in the right-click menu,
# and exits on its own when the devport server stops answering.
param([int]$Port = 7777)

$ErrorActionPreference = 'Stop'
$mutex = New-Object System.Threading.Mutex($false, "Local\devport-tray-$Port")
if (-not $mutex.WaitOne(0)) { exit 0 }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace DevPort -Name Native -MemberDefinition '[DllImport("user32.dll")] public static extern bool DestroyIcon(System.IntPtr h);'
[System.Windows.Forms.Application]::EnableVisualStyles()

$Base = "http://localhost:$Port"
$Lime = [System.Drawing.Color]::FromArgb(200, 241, 105)
$Ink = [System.Drawing.Color]::FromArgb(23, 21, 15)
$Grey = [System.Drawing.Color]::FromArgb(150, 146, 136)

function Invoke-Devport([string]$Method, [string]$Path) {
    $req = [System.Net.HttpWebRequest]::Create("$Base$Path")
    $req.Method = $Method
    $req.Timeout = 4000
    $req.Headers.Add('X-Devport', '1')
    if ($Method -eq 'POST') {
        $req.ContentType = 'application/json'
        $bytes = [Text.Encoding]::UTF8.GetBytes('{}')
        $req.ContentLength = $bytes.Length
        $s = $req.GetRequestStream(); $s.Write($bytes, 0, $bytes.Length); $s.Close()
    }
    $resp = $req.GetResponse()
    try {
        $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
        return ($reader.ReadToEnd() | ConvertFrom-Json)
    } finally { $resp.Close() }
}

function New-CountIcon([int]$Count, [int]$Size = 0) {
    # Draw at the real tray size so the digit is hinted, not downscaled into mush.
    if ($Size -le 0) { $Size = [Math]::Max(16, [System.Windows.Forms.SystemInformation]::SmallIconSize.Width) }
    $s = [single]$Size
    $bmp = New-Object System.Drawing.Bitmap $Size, $Size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.TextRenderingHint = 'AntiAliasGridFit'
    if ($Count -gt 0) {
        $g.FillEllipse((New-Object System.Drawing.SolidBrush $Lime), 0, 0, $s - 1, $s - 1)
        $text = if ($Count -gt 9) { '9+' } else { [string]$Count }
        $px = if ($text.Length -gt 1) { $s * 0.56 } else { $s * 0.8 }
        $font = New-Object System.Drawing.Font('Segoe UI', $px, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
        $fmt = New-Object System.Drawing.StringFormat
        $fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'
        $g.DrawString($text, $font, (New-Object System.Drawing.SolidBrush $Ink), (New-Object System.Drawing.RectangleF(0, ($s * 0.04), $s, $s)), $fmt)
        $font.Dispose()
    } else {
        $w = [Math]::Max(2, $s / 8)
        $pen = New-Object System.Drawing.Pen($Grey, $w)
        $g.DrawEllipse($pen, $w, $w, $s - 2 * $w - 1, $s - 2 * $w - 1)
        $pen.Dispose()
    }
    $g.Dispose()
    $h = $bmp.GetHicon()
    $icon = ([System.Drawing.Icon]::FromHandle($h)).Clone()
    [void][DevPort.Native]::DestroyIcon($h)
    $bmp.Dispose()
    return $icon
}

function Format-Mem([double]$Bytes) {
    if ($Bytes -ge 1GB) { return ('{0:N1} GB' -f ($Bytes / 1GB)) }
    return ('{0:N0} MB' -f ($Bytes / 1MB))
}

$script:state = $null
$script:shownCount = -1
$script:failures = 0
# Alert keys ("pid:reason") already announced, so each fires once.
$script:announced = New-Object 'System.Collections.Generic.HashSet[string]'

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = New-CountIcon 0
$notify.Text = 'devport'
$notify.Visible = $true
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$notify.ContextMenuStrip = $menu

function Open-Dashboard { Start-Process "$Base/" }

function Exit-Tray {
    $timer.Stop()
    $notify.Visible = $false
    $notify.Dispose()
    [System.Windows.Forms.Application]::Exit()
}

function Show-Alerts($Alerts) {
    if ($env:DEVPORT_TRAY_DEBUG) { Write-TrayLog ("alerts in: {0} [{1}]" -f @($Alerts).Count, (@($Alerts | ForEach-Object { $_.key }) -join ',')) }
    $live = @{}
    foreach ($srv in $script:state.servers) { $live[[string]$srv.pid] = $true }
    # Forget alerts for servers that are gone, so a recycled PID can alert again.
    foreach ($k in @($script:announced)) { if (-not $live[$k.Split(':')[0]]) { [void]$script:announced.Remove($k) } }
    $new = @($Alerts | Where-Object { $_ -and -not $script:announced.Contains($_.key) })
    if (-not $new.Count) { return }
    foreach ($a in $new) { [void]$script:announced.Add($a.key) }
    if ($new.Count -eq 1) {
        $title = if ($new[0].reason -eq 'heavy') { 'A dev server is using a lot of memory' } else { 'A dev server looks forgotten' }
        $text = $new[0].text
    } else {
        $title = "$($new.Count) dev servers need a look"
        $text = ($new | Select-Object -First 4 | ForEach-Object { $_.text }) -join "`n"
        if ($new.Count -gt 4) { $text += "`n+$($new.Count - 4) more" }
    }
    $text += "`nClick to open devport."
    $notify.BalloonTipTitle = $title
    $notify.BalloonTipText = $text.Substring(0, [Math]::Min(250, $text.Length))
    $notify.BalloonTipIcon = 'Warning'
    $notify.ShowBalloonTip(15000)
    if ($env:DEVPORT_TRAY_DEBUG) { Write-TrayLog "balloon: $title" }
}

function Write-TrayLog([string]$Message) {
    try {
        $dir = Join-Path $env:LOCALAPPDATA 'devport'
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        Add-Content -Path (Join-Path $dir 'tray.log') -Value ("{0:s}  {1}" -f (Get-Date), $Message)
    } catch {}
}

function Update-State {
    # Only an unreachable server counts toward exiting; anything else is a bug
    # in this script, so log it instead of quietly shutting the tray down.
    try {
        $s = Invoke-Devport 'GET' '/api/summary'
        $script:failures = 0
    } catch {
        $script:failures++
        if ($script:failures -ge 3) { Exit-Tray }
        return
    }
    try {
        if (-not $s.ready) { return }
        $script:state = $s
        if ($s.alerts) { Show-Alerts $s.alerts }
        if ($s.count -ne $script:shownCount) {
            $old = $notify.Icon
            $notify.Icon = New-CountIcon $s.count
            if ($old) { $old.Dispose() }
            $script:shownCount = $s.count
        }
        $label = if ($s.count -eq 1) { '1 dev server' } elseif ($s.count -gt 1) { "$($s.count) dev servers" } else { 'No dev servers' }
        $tip = "devport: $label"
        if ($s.count -gt 0) { $tip += " ($(Format-Mem $s.mem))" }
        $notify.Text = $tip.Substring(0, [Math]::Min(63, $tip.Length))
    } catch {
        Write-TrayLog ("{0} (line {1})" -f $_.Exception.Message, $_.InvocationInfo.ScriptLineNumber)
    }
}

$menu.Add_Opening({
    $menu.Items.Clear()
    $s = $script:state
    $count = if ($s) { [int]$s.count } else { 0 }
    $head = $menu.Items.Add($(if ($count -eq 0) { 'No dev servers running' } elseif ($count -eq 1) { "1 dev server, $(Format-Mem $s.mem)" } else { "$count dev servers, $(Format-Mem $s.mem)" }))
    $head.Enabled = $false
    if ($count -gt 0) {
        [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
        foreach ($srv in $s.servers) {
            $name = if ($srv.name) { $srv.name } else { 'Unknown repo' }
            $why = @()
            if ($srv.flags.stale) { $why += 'running long' }
            if ($srv.flags.heavy) { $why += 'heavy' }
            $suffix = if ($why.Count) { "  - $($why -join ', ')" } else { '' }
            $item = $menu.Items.Add(":$($srv.port)    $name  ($($srv.stack))$suffix")
            $item.Tag = $srv.port
            $item.ToolTipText = "Open http://localhost:$($srv.port)/"
            $item.Add_Click({ Start-Process ("http://localhost:{0}/" -f $this.Tag) })
        }
    }
    [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
    $open = $menu.Items.Add('Open dashboard')
    $open.Font = New-Object System.Drawing.Font($open.Font, [System.Drawing.FontStyle]::Bold)
    $open.Add_Click({ Open-Dashboard })
    $stop = $menu.Items.Add('Stop all dev servers')
    $stop.Enabled = $count -gt 0
    $stop.Add_Click({
        $n = if ($script:state) { $script:state.count } else { 0 }
        $answer = [System.Windows.Forms.MessageBox]::Show("Stop $n dev server$(if ($n -ne 1) { 's' })?", 'devport', 'YesNo', 'Warning')
        if ($answer -eq 'Yes') {
            try { [void](Invoke-Devport 'POST' '/api/kill-all') } catch {}
            Update-State
        }
    })
    [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
    $quit = $menu.Items.Add('Quit devport')
    $quit.ToolTipText = 'Stops the dashboard. Your dev servers keep running.'
    $quit.Add_Click({
        try { [void](Invoke-Devport 'POST' '/api/shutdown') } catch {}
        Exit-Tray
    })
    $_.Cancel = $false
})

$notify.Add_MouseClick({ if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Open-Dashboard } })
$notify.Add_BalloonTipClicked({ Open-Dashboard })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({ Update-State })
Update-State
$timer.Start()

[System.Windows.Forms.Application]::Run()
$mutex.ReleaseMutex()
