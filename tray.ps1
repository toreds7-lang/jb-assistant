# Todoro tray host. Runs the Todoro server with no console window and keeps a
# Totoro icon in the Windows notification area: click it to open the app,
# right-click for the menu. It also shows a notification when a Claude run or
# the Top 10 finishes while the Todoro window is not in front.
#
#   tray.ps1             start the tray (and the server, if it is not running)
#   tray.ps1 -Open       same, then open the app window
#   tray.ps1 -Install    add Todoro to the Start menu and to Startup
#   tray.ps1 -Uninstall  remove those shortcuts
#
# Keep this file plain ASCII: Windows PowerShell 5.1 reads scripts without a
# BOM in the system code page.
param([switch]$Open, [switch]$Install, [switch]$Uninstall)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$AppDir = $PSScriptRoot
$DataDir = Join-Path $AppDir 'data'
$Port = if ($env:TODORO_PORT) { [int]$env:TODORO_PORT } else { 7878 }
$BaseUrl = "http://127.0.0.1:$Port"
$IcoPath = Join-Path $AppDir 'totoro.ico'
$StartMenuLink = Join-Path ([Environment]::GetFolderPath('Programs')) 'Todoro.lnk'
$StartupLink = Join-Path ([Environment]::GetFolderPath('Startup')) 'Todoro.lnk'

# ---------- icon and shortcuts ----------

# Totoro's head cut from totoro.jpg into a circle; the whole picture is just a
# green blob at tray size.
function New-HeadBitmap([int]$Size) {
  $src = [System.Drawing.Image]::FromFile((Join-Path $AppDir 'totoro.jpg'))
  $crop = New-Object System.Drawing.Bitmap($Size, $Size)
  $g = [System.Drawing.Graphics]::FromImage($crop)
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.PixelOffsetMode = 'HighQuality'
  $g.DrawImage($src, (New-Object System.Drawing.Rectangle(0, 0, $Size, $Size)), (New-Object System.Drawing.Rectangle(155, 60, 250, 250)), ([System.Drawing.GraphicsUnit]::Pixel))
  $g.Dispose()
  $src.Dispose()

  $bmp = New-Object System.Drawing.Bitmap($Size, $Size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb))
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.PixelOffsetMode = 'HighQuality'
  $brush = New-Object System.Drawing.TextureBrush($crop)
  $g.FillEllipse($brush, 0, 0, $Size, $Size)
  $brush.Dispose()
  $g.Dispose()
  $crop.Dispose()
  $bmp
}

# An .ico made of PNG frames, which Explorer reads for the shortcuts.
function Save-Ico {
  $sizes = 16, 20, 24, 32, 40, 48, 64, 256
  $frames = New-Object 'System.Collections.Generic.List[byte[]]'
  foreach ($s in $sizes) {
    $bmp = New-HeadBitmap $s
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $frames.Add($ms.ToArray())
  }
  $w = New-Object System.IO.BinaryWriter([System.IO.File]::Create($IcoPath))
  try {
    $w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
    $offset = 6 + 16 * $sizes.Count
    for ($i = 0; $i -lt $sizes.Count; $i++) {
      $dim = [byte]($sizes[$i] % 256)   # 0 means 256
      $w.Write($dim); $w.Write($dim); $w.Write([byte]0); $w.Write([byte]0)
      $w.Write([uint16]1); $w.Write([uint16]32)
      $w.Write([uint32]$frames[$i].Length); $w.Write([uint32]$offset)
      $offset += $frames[$i].Length
    }
    foreach ($f in $frames) { $w.Write($f) }
  } finally {
    $w.Close()
  }
}

function Set-Shortcut([string]$Link, [string]$Arguments) {
  if (-not (Test-Path $IcoPath)) { Save-Ico }
  $lnk = (New-Object -ComObject WScript.Shell).CreateShortcut($Link)
  $lnk.TargetPath = Join-Path $PSHOME 'powershell.exe'
  $lnk.Arguments = "-NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" $Arguments".Trim()
  $lnk.WorkingDirectory = $AppDir
  $lnk.IconLocation = "$IcoPath,0"
  $lnk.WindowStyle = 7   # minimized, so the console does not flash before it hides
  $lnk.Description = 'Todoro, your personal assistant powered by Claude Code'
  $lnk.Save()
}

if ($Install) {
  Save-Ico
  Set-Shortcut $StartMenuLink '-Open'
  Set-Shortcut $StartupLink ''
  Write-Host "Added Todoro to the Start menu and to Startup:`n  $StartMenuLink`n  $StartupLink"
  exit
}
if ($Uninstall) {
  foreach ($l in $StartMenuLink, $StartupLink) { if (Test-Path $l) { Remove-Item $l } }
  Write-Host 'Removed the Todoro shortcuts.'
  exit
}

# ---------- single instance ----------

Add-Type -Namespace Todoro -Name Win32 -MemberDefinition @'
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int pid);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
'@

# One tray per user. A second launch only asks the first one to show the window,
# handing over its right to bring a window to the front.
$created = $false
$wake = New-Object System.Threading.EventWaitHandle($false, 'AutoReset', 'Local\Todoro.Tray.Open', [ref]$created)
if (-not $created) {
  if ($Open) {
    [void][Todoro.Win32]::AllowSetForegroundWindow(-1)
    [void]$wake.Set()
  }
  exit
}

# ---------- server ----------

function Write-TrayLog([string]$Message) {
  try { Add-Content -Encoding UTF8 -Path (Join-Path $DataDir 'tray.log') -Value "$(Get-Date -Format s)  $Message" } catch { }
}

# Windows takes about 2 s to refuse a connection to a closed local port, which
# would freeze the tray; the listener table answers instantly.
function Test-Listening {
  @([System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object { $_.Port -eq $Port }).Count -gt 0
}

function Invoke-Todoro([string]$Method, [string]$Path, $Body = $null, [int]$TimeoutMs = 2000) {
  if (-not (Test-Listening)) { throw 'The Todoro server is not running.' }
  $req = [System.Net.HttpWebRequest]::Create($BaseUrl + $Path)
  $req.Method = $Method
  $req.Timeout = $TimeoutMs
  $req.Proxy = $null       # skips proxy auto-detection, which can stall for seconds
  $req.KeepAlive = $false
  if ($Method -ne 'GET') {
    $req.Headers.Add('x-todoro', '1')
    $bytes = if ($Body) { [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Compress)) } else { [byte[]]@() }
    $req.ContentType = 'application/json'
    $req.ContentLength = $bytes.Length
    if ($bytes.Length) {
      $stream = $req.GetRequestStream()
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Close()
    }
  }
  $res = $req.GetResponse()
  try {
    (New-Object System.IO.StreamReader($res.GetResponseStream(), [Text.Encoding]::UTF8)).ReadToEnd() | ConvertFrom-Json
  } finally {
    $res.Close()
  }
}

$script:state = 'down'          # down | starting | up
$script:server = $null          # the server process, when this tray started it
$script:startedAt = Get-Date
$script:boot = ''               # which server process the notification cursor belongs to
$script:after = 0
$script:fails = 0
$script:ticks = 0
$script:pendingOpen = [bool]$Open
$script:lastSpawn = [datetime]::MinValue
$script:notifyOn = $true

function Start-Server {
  New-Item -ItemType Directory -Force $DataDir | Out-Null
  $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if (-not $node) { $node = Join-Path $env:ProgramFiles 'nodejs\node.exe' }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  # Through cmd so the server's console output lands in data\server.log.
  $psi.FileName = Join-Path $env:SystemRoot 'System32\cmd.exe'
  $psi.Arguments = '/d /s /c ""{0}" server.mjs > "{1}" 2>&1"' -f $node, (Join-Path $DataDir 'server.log')
  $psi.WorkingDirectory = $AppDir
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $script:server = [System.Diagnostics.Process]::Start($psi)
  $script:state = 'starting'
  $script:startedAt = Get-Date
  $script:fails = 0
  Update-Status
}

function Stop-Server {
  try { [void](Invoke-Todoro POST '/api/quit') } catch { }
  if ($script:server) {
    if (-not $script:server.WaitForExit(5000)) {
      & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /pid $script:server.Id /T /F | Out-Null
    }
  } else {
    # A server this tray did not start: wait for it to let go of the port.
    for ($i = 0; $i -lt 20 -and (Test-Listening); $i++) { Start-Sleep -Milliseconds 250 }
  }
}

function Restart-Server {
  if ($script:state -ne 'down') { Stop-Server }
  Start-Server
}

function Set-Down([string]$Message) {
  $script:state = 'down'
  $script:server = $null
  $script:pendingOpen = $false
  Update-Status
  $tray.ShowBalloonTip(10000, 'Todoro stopped', "$Message Click to start it again.", 'Error')
  Write-TrayLog $Message
}

# The server stopped answering. Exit code 0 means it was told to quit (the Quit
# button in the app), so the tray goes too; anything else is a crash.
function Test-ServerGone {
  $script:fails++
  $proc = $script:server
  if ($proc -and $proc.HasExited) {
    if ($script:state -eq 'up' -and $proc.ExitCode -eq 0) { Exit-Tray }
    else { Set-Down "The server exited with code $($proc.ExitCode). See data\server.log." }
  } elseif ($script:state -eq 'starting') {
    if (((Get-Date) - $script:startedAt).TotalSeconds -gt 30) { Set-Down 'The server did not answer within 30 seconds. See data\server.log.' }
  } elseif (-not $proc -and $script:fails -ge 2) {
    Exit-Tray   # a server this tray did not start has gone away
  }
}

# ---------- window ----------

# Edge app windows are titled after the page, so this finds Todoro's own window
# but not a browser tab showing it.
function Find-AppWindow { [Todoro.Win32]::FindWindow('Chrome_WidgetWin_1', 'Todoro') }

function Show-Todoro {
  if ($script:state -ne 'up') {
    $script:pendingOpen = $true
    if ($script:state -eq 'down') { Start-Server }
    return
  }
  $h = Find-AppWindow
  if ($h -ne [IntPtr]::Zero) {
    if ([Todoro.Win32]::IsIconic($h)) { [void][Todoro.Win32]::ShowWindow($h, 9) }   # SW_RESTORE
    [void][Todoro.Win32]::SetForegroundWindow($h)
  } elseif (((Get-Date) - $script:lastSpawn).TotalSeconds -gt 5) {
    # A new window takes a moment to appear; don't open a second one meanwhile.
    $script:lastSpawn = Get-Date
    try { [void](Invoke-Todoro POST '/api/window') } catch { Start-Process $BaseUrl }
  }
}

function Close-AppWindow {
  $h = Find-AppWindow
  if ($h -ne [IntPtr]::Zero) { [void][Todoro.Win32]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }   # WM_CLOSE
}

# ---------- tray ----------

function Update-Status {
  $tray.Text = switch ($script:state) { 'up' { 'Todoro' } 'starting' { 'Todoro (starting...)' } default { 'Todoro (stopped)' } }
  $miRestart.Text = if ($script:state -eq 'down') { 'Start server' } else { 'Restart server' }
}

function Exit-Tray {
  $timer.Stop()
  $tray.Visible = $false
  $tray.Dispose()
  [System.Windows.Forms.Application]::Exit()
}

function Switch-Notifications {
  $script:notifyOn = (Invoke-Todoro PUT '/api/settings' @{ notify = -not $script:notifyOn }).notify
}

function Switch-Startup {
  if (Test-Path $StartupLink) { Remove-Item $StartupLink } else { Set-Shortcut $StartupLink '' }
}

# Every second: answer a second launch; while the server is up, poll it every
# third second for notifications (every second while it is starting).
function Invoke-Tick {
  if ($wake.WaitOne(0)) { Show-Todoro }
  $script:ticks++
  if ($script:state -eq 'down' -or ($script:state -eq 'up' -and $script:ticks % 3)) { return }
  try {
    $n = Invoke-Todoro GET "/api/notifications?after=$($script:after)&boot=$($script:boot)"
  } catch {
    Test-ServerGone
    return
  }
  $script:fails = 0
  $script:notifyOn = $n.enabled
  if ($script:state -eq 'starting') {
    $script:state = 'up'
    Update-Status
    if ($script:pendingOpen) {
      $script:pendingOpen = $false
      Show-Todoro
    }
  }
  # First contact with a server that was already running: skip its backlog.
  $firstContact = -not $script:boot
  $script:boot = $n.boot
  $script:after = $n.seq
  $items = @($n.items)
  if ($firstContact -or -not $items.Count) { return }
  $last = $items[-1]
  $text = $last.text
  if ($items.Count -gt 1) { $text += " (and $($items.Count - 1) more)" }
  $tray.ShowBalloonTip(10000, $last.title, $text, $(if ($last.level -eq 'error') { 'Error' } else { 'Info' }))
}

try {
  [void][Todoro.Win32]::SetProcessDPIAware()
  [System.Windows.Forms.Application]::EnableVisualStyles()
  [System.Windows.Forms.Application]::SetUnhandledExceptionMode('CatchException')
  [System.Windows.Forms.Application]::add_ThreadException({ param($s, $e) Write-TrayLog "error: $($e.Exception.Message)" })

  $menu = New-Object System.Windows.Forms.ContextMenuStrip
  function Add-MenuItem([string]$Text, [scriptblock]$OnClick) {
    $item = New-Object System.Windows.Forms.ToolStripMenuItem($Text)
    $item.add_Click($OnClick)
    [void]$menu.Items.Add($item)
    $item
  }
  $miOpen = Add-MenuItem 'Open Todoro' { Show-Todoro }
  $miOpen.Font = New-Object System.Drawing.Font($miOpen.Font, [System.Drawing.FontStyle]::Bold)
  [void](Add-MenuItem 'Open folder' { Start-Process explorer.exe $AppDir })
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  $miNotify = Add-MenuItem 'Notifications' { Switch-Notifications }
  $miStartup = Add-MenuItem 'Start with Windows' { Switch-Startup }
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  $miRestart = Add-MenuItem 'Restart server' { Restart-Server }
  [void](Add-MenuItem 'Quit Todoro' { Stop-Server; Close-AppWindow; Exit-Tray })
  $menu.add_Opening({
    $miStartup.Checked = Test-Path $StartupLink
    $miNotify.Checked = $script:notifyOn
    $miNotify.Enabled = $script:state -eq 'up'
  })

  $tray = New-Object System.Windows.Forms.NotifyIcon
  $tray.Icon = [System.Drawing.Icon]::FromHandle((New-HeadBitmap ([System.Windows.Forms.SystemInformation]::SmallIconSize.Width)).GetHicon())
  $tray.ContextMenuStrip = $menu
  $tray.add_MouseClick({ param($s, $e) if ($e.Button -eq 'Left') { Show-Todoro } })
  $tray.add_BalloonTipClicked({ Show-Todoro })
  $tray.Visible = $true

  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 1000
  $timer.add_Tick({ try { Invoke-Tick } catch { Write-TrayLog "tick: $_" } })

  # Attach to a server that is already running, otherwise start one.
  if (Test-Listening) {
    $script:state = 'starting'
    Update-Status
  } else {
    Start-Server
  }
  $timer.Start()
  [System.Windows.Forms.Application]::Run()
} catch {
  Write-TrayLog "fatal: $_"
  [void][System.Windows.Forms.MessageBox]::Show("Todoro's tray icon could not start:`n`n$_", 'Todoro', 'OK', 'Error')
}
