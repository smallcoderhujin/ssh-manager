using System;
using System.Runtime.InteropServices;

class Program {
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("imm32.dll")]  static extern IntPtr ImmGetContext(IntPtr hwnd);
    [DllImport("imm32.dll")]  static extern bool   ImmSetOpenStatus(IntPtr himc, bool fOpen);
    [DllImport("imm32.dll")]  static extern bool   ImmReleaseContext(IntPtr hwnd, IntPtr himc);

    [STAThread]
    static void Main() {
        IntPtr hwnd = GetForegroundWindow();
        IntPtr himc = ImmGetContext(hwnd);
        ImmSetOpenStatus(himc, false);
        ImmReleaseContext(hwnd, himc);
    }
}
