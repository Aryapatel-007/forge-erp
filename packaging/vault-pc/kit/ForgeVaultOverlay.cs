// Badges on files in the Forge Vault folder, drawn by File Explorer:
//   green pencil  checked out to you
//   red lock      checked out by someone else
//   blue tick     released
//
// Explorer asks every badge handler about every file it shows, so this must be quick: it
// answers from a small status file the sync program keeps (%LOCALAPPDATA%\ForgeVault\
// status.txt), read again only when it changes. Files outside the vault folder are
// answered "no" after one string comparison.
//
// Written for the C# 5 compiler that comes with Windows, so it builds without Visual Studio.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace ForgeVault
{
    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("0C6C4200-C589-11D0-999A-00C04FD655E1")]
    public interface IShellIconOverlayIdentifier
    {
        [PreserveSig]
        int IsMemberOf([MarshalAs(UnmanagedType.LPWStr)] string path, uint attributes);
        [PreserveSig]
        int GetOverlayInfo(IntPtr iconFileBuffer, int iconFileBufferSize, out int iconIndex, out uint flags);
        [PreserveSig]
        int GetPriority(out int priority);
    }

    internal static class VaultStatus
    {
        private static readonly object Gate = new object();
        private static Dictionary<string, char> flags = new Dictionary<string, char>();
        private static string root = null;
        private static DateTime statusWritten = DateTime.MinValue;
        private static DateTime lastLook = DateTime.MinValue;

        private static string Home
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ForgeVault"); }
        }

        // Reads the status again at most every 2 seconds, and only if it was rewritten.
        private static void Refresh()
        {
            if ((DateTime.UtcNow - lastLook).TotalSeconds < 2) return;
            lastLook = DateTime.UtcNow;
            try
            {
                if (root == null)
                {
                    string config = File.ReadAllText(Path.Combine(Home, "config.json"));
                    Match m = Regex.Match(config, "\"root\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
                    if (m.Success) root = Regex.Unescape(m.Groups[1].Value).TrimEnd('\\').ToLowerInvariant() + "\\";
                }
                string file = Path.Combine(Home, "status.txt");
                DateTime written = File.GetLastWriteTimeUtc(file);
                if (written == statusWritten) return;
                Dictionary<string, char> next = new Dictionary<string, char>(StringComparer.OrdinalIgnoreCase);
                foreach (string line in File.ReadAllLines(file, Encoding.UTF8))
                {
                    string[] parts = line.Split('\t');
                    if (parts.Length >= 2 && parts[1].Length == 1) next[parts[0]] = parts[1][0];
                }
                flags = next;
                statusWritten = written;
            }
            catch
            {
                // No status yet, or being rewritten: keep what we had.
            }
        }

        public static bool Has(string path, char flag)
        {
            if (string.IsNullOrEmpty(path)) return false;
            lock (Gate)
            {
                Refresh();
                if (root == null || !path.StartsWith(root, StringComparison.OrdinalIgnoreCase)) return false;
                char found;
                return flags.TryGetValue(path, out found) && found == flag;
            }
        }
    }

    public abstract class OverlayBase : IShellIconOverlayIdentifier
    {
        protected abstract char Flag { get; }
        protected abstract string IconName { get; }

        public int IsMemberOf(string path, uint attributes)
        {
            try { return VaultStatus.Has(path, Flag) ? 0 : 1; }
            catch { return 1; }
        }

        public int GetOverlayInfo(IntPtr iconFileBuffer, int iconFileBufferSize, out int iconIndex, out uint flags)
        {
            string dir = Path.GetDirectoryName(typeof(OverlayBase).Assembly.Location);
            string icon = Path.Combine(dir, IconName) + "\0";
            iconIndex = 0;
            flags = 1 | 2; // ISIOI_ICONFILE | ISIOI_ICONINDEX
            if (icon.Length > iconFileBufferSize) return unchecked((int)0x80004005);
            Marshal.Copy(icon.ToCharArray(), 0, iconFileBuffer, icon.Length);
            return 0;
        }

        public int GetPriority(out int priority)
        {
            priority = 0;
            return 0;
        }

        // Windows shows only the first 15 badge handlers, in name order. Leading spaces put
        // these ahead of most cloud-drive handlers.
        protected static void Register(Type type, string name)
        {
            string clsid = type.GUID.ToString("B").ToUpperInvariant();
            using (RegistryKey key = Registry.LocalMachine.CreateSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\ShellIconOverlayIdentifiers\   " + name))
                key.SetValue(null, clsid);
            using (RegistryKey key = Registry.LocalMachine.CreateSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Shell Extensions\Approved"))
                key.SetValue(clsid, "Forge Vault " + name);
        }

        protected static void Unregister(Type type, string name)
        {
            string clsid = type.GUID.ToString("B").ToUpperInvariant();
            Registry.LocalMachine.DeleteSubKeyTree(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\ShellIconOverlayIdentifiers\   " + name, false);
            using (RegistryKey key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Shell Extensions\Approved", true))
                if (key != null) key.DeleteValue(clsid, false);
        }
    }

    [ComVisible(true)]
    [Guid("670CB109-5E9D-4197-8050-AD4503204FB5")]
    [ClassInterface(ClassInterfaceType.None)]
    public class OverlayMine : OverlayBase
    {
        protected override char Flag { get { return 'M'; } }
        protected override string IconName { get { return "overlay-mine.ico"; } }
        [ComRegisterFunction] public static void Reg(Type t) { Register(t, "ForgeVault1Mine"); }
        [ComUnregisterFunction] public static void Unreg(Type t) { Unregister(t, "ForgeVault1Mine"); }
    }

    [ComVisible(true)]
    [Guid("43739E98-7DDA-4726-894B-CABCAF478381")]
    [ClassInterface(ClassInterfaceType.None)]
    public class OverlayLocked : OverlayBase
    {
        protected override char Flag { get { return 'L'; } }
        protected override string IconName { get { return "overlay-locked.ico"; } }
        [ComRegisterFunction] public static void Reg(Type t) { Register(t, "ForgeVault2Locked"); }
        [ComUnregisterFunction] public static void Unreg(Type t) { Unregister(t, "ForgeVault2Locked"); }
    }

    [ComVisible(true)]
    [Guid("9E95E6FB-1643-4BC4-943F-31705DF41B65")]
    [ClassInterface(ClassInterfaceType.None)]
    public class OverlayReleased : OverlayBase
    {
        protected override char Flag { get { return 'R'; } }
        protected override string IconName { get { return "overlay-released.ico"; } }
        [ComRegisterFunction] public static void Reg(Type t) { Register(t, "ForgeVault3Released"); }
        [ComUnregisterFunction] public static void Unreg(Type t) { Unregister(t, "ForgeVault3Released"); }
    }
}
