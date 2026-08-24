using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        string projectRoot = AppDomain.CurrentDomain.BaseDirectory;
        string electronPath = Path.Combine(
            projectRoot,
            "node_modules",
            "electron",
            "dist",
            "electron.exe"
        );
        string applicationPath = Path.Combine(
            projectRoot,
            "apps",
            "control-panel",
            "dist",
            "main",
            "main",
            "main.js"
        );

        if (!File.Exists(electronPath) || !File.Exists(applicationPath))
        {
            MessageBox.Show(
                "El panel de Dotty todavia no esta preparado. Ejecuta npm install y npm run panel:build desde la carpeta del proyecto.",
                "Dotty - Falta preparar el panel",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning
            );
            return;
        }

        var process = new ProcessStartInfo
        {
            FileName = electronPath,
            Arguments = "\"" + applicationPath + "\"",
            WorkingDirectory = projectRoot,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden
        };

        Process.Start(process);
    }
}
