param(
  [Parameter(Mandatory = $true)][long]$WindowHandle,
  [Parameter(Mandatory = $true)][string]$OutputPath
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NativeWindowCapture {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint flags);
  [DllImport("user32.dll")]
  public static extern uint GetDpiForWindow(IntPtr hWnd);
  [DllImport("shcore.dll")]
  public static extern int SetProcessDpiAwareness(int value);
}
"@

[NativeWindowCapture]::SetProcessDpiAwareness(2) | Out-Null
$handle = [IntPtr]::new($WindowHandle)
if ($handle -eq [IntPtr]::Zero) { throw "Invalid zero window handle" }
$rect = New-Object NativeWindowCapture+RECT
if (-not [NativeWindowCapture]::GetWindowRect($handle, [ref]$rect)) { throw "GetWindowRect failed for process $ProcessId" }
[NativeWindowCapture]::SetForegroundWindow($handle) | Out-Null
Start-Sleep -Milliseconds 180
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $hdc = $graphics.GetHdc()
  try {
    if (-not [NativeWindowCapture]::PrintWindow($handle, $hdc, 2)) { throw "PrintWindow failed" }
  } finally {
    $graphics.ReleaseHdc($hdc)
  }
  $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}
[pscustomobject]@{ Width = $width; Height = $height; Dpi = [NativeWindowCapture]::GetDpiForWindow($handle); Path = $OutputPath } | ConvertTo-Json -Compress
