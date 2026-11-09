// Forge Vault inside SOLIDWORKS: a Forge tab on the ribbon for parts, assemblies and
// drawings, and a Forge Vault panel in the Task Pane showing the open file's state.
//
// Pull, push, lock and the rest run the same Forge Vault program the right-click menu uses
// (%LOCALAPPDATA%\ForgeVault\ForgeVault.ps1), so there is one set of rules and one record of
// what was pulled. This add-in closes and reopens the file around a pull, saves before a
// push, and makes the open file writable or read-only to match. The panel reads the file's
// state from Forge with the PC's own key.
//
// Written for the C# 5 compiler that comes with Windows, so it builds without Visual Studio.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;
using SolidWorks.Interop.swpublished;

namespace ForgeVault
{
    // ---------- Forge ----------
    public class ForgeApi
    {
        public string Url;
        public string Root;
        public string Script;
        private readonly HttpClient http;
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };

        public ForgeApi()
        {
            string file = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"ForgeVault\config.json");
            if (!File.Exists(file)) throw new InvalidOperationException("Forge Vault is not set up on this PC yet. Run this PC's Forge Vault file from Forge first.");
            Dictionary<string, object> config = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(file));
            Url = ((string)config["url"]).TrimEnd('/');
            Root = ((string)config["root"]).TrimEnd('\\');
            Script = (string)config["script"];
            http = new HttpClient();
            http.Timeout = TimeSpan.FromSeconds(20);
            http.DefaultRequestHeaders.Add("x-forge-agent-key", (string)config["key"]);
        }

        public string RelativePath(string full)
        {
            if (string.IsNullOrEmpty(full)) return null;
            string prefix = Root + "\\";
            if (!full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return null;
            return full.Substring(prefix.Length).Replace('\\', '/');
        }

        // The file's state, or null if the vault does not have it (or this person may not see it).
        public Dictionary<string, object> Status(string rel)
        {
            HttpResponseMessage response = http.GetAsync(Url + "/api/v1/vault-agent/status?path=" + Uri.EscapeDataString(rel)).Result;
            string body = response.Content.ReadAsStringAsync().Result;
            if ((int)response.StatusCode == 404) return null;
            Dictionary<string, object> parsed = null;
            try { parsed = Json.Deserialize<Dictionary<string, object>>(body); } catch { }
            if (response.IsSuccessStatusCode && parsed != null) return parsed["data"] as Dictionary<string, object>;
            string message = "Forge answered " + (int)response.StatusCode + ".";
            if (parsed != null && parsed.ContainsKey("error"))
            {
                Dictionary<string, object> error = parsed["error"] as Dictionary<string, object>;
                if (error != null && error.ContainsKey("message")) message = (string)error["message"];
            }
            throw new InvalidOperationException(message);
        }

        public static string Sha256(string file)
        {
            using (FileStream stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            using (SHA256 sha = SHA256.Create())
                return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
        }

        // Runs one Forge Vault action on a file and waits. The program shows its own windows.
        public void Run(string action, string path)
        {
            ProcessStartInfo start = new ProcessStartInfo("powershell.exe",
                "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + Script + "\" -Action " + action + " -Target \"" + path + "\"");
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            using (Process p = Process.Start(start)) p.WaitForExit();
        }
    }

    internal static class Values
    {
        public static string Text(Dictionary<string, object> d, string key)
        {
            object v;
            return d != null && d.TryGetValue(key, out v) && v != null ? Convert.ToString(v) : "";
        }
        public static bool Flag(Dictionary<string, object> d, string key)
        {
            object v;
            return d != null && d.TryGetValue(key, out v) && v is bool && (bool)v;
        }
    }

    // ---------- The add-in ----------
    [ComVisible(true)]
    [Guid("0FE1B387-CA1F-4E82-98F5-E72BA4922E80")]
    public class ForgeVaultAddin : ISwAddin
    {
        private const int GroupId = 7301;
        private const string Title = "Forge";
        private ISldWorks sw;
        private int cookie;
        private CommandManager commands;
        private TaskpaneView taskView;
        private VaultPane pane;
        private ForgeApi forgeApi;

        // Same order as the pictures in commands-<size>.png.
        private static readonly string[][] Buttons = {
            new[] { "Pull", "Get the latest version from Forge (closes and reopens the file)", "OnPull" },
            new[] { "Push", "Send your changes to Forge as a new version, with a message", "OnPush" },
            new[] { "Lock", "Tell everyone you are changing this file; makes it editable", "OnLock" },
            new[] { "Unlock", "Let others change it again", "OnUnlock" },
            new[] { "Send for review", "Ask for this file to be reviewed", "OnSubmit" },
            new[] { "Release", "Approve and release: the file gets its next revision letter", "OnRelease" },
            new[] { "New revision", "Start changing a released file", "OnNewRevision" },
            new[] { "Show in Forge", "Open this file's page in Forge: versions, pushes, where used", "OnOpen" },
            new[] { "Refresh", "Read this file's state from Forge again", "OnRefresh" },
        };

        private string Here { get { return Path.GetDirectoryName(typeof(ForgeVaultAddin).Assembly.Location); } }

        public bool ConnectToSW(object ThisSW, int Cookie)
        {
            sw = (ISldWorks)ThisSW;
            cookie = Cookie;
            sw.SetAddinCallbackInfo(0, this, cookie);
            commands = sw.GetCommandManager(cookie);
            try { AddCommands(); } catch (Exception e) { Log("Ribbon: " + e.Message); }
            try { AddPane(); } catch (Exception e) { Log("Task pane: " + e.Message); }
            try
            {
                SldWorks events = (SldWorks)sw;
                events.ActiveDocChangeNotify += OnActiveDocChange;
                events.FileOpenPostNotify += OnFileOpened;
            }
            catch (Exception e) { Log("Events: " + e.Message); }
            return true;
        }

        public bool DisconnectFromSW()
        {
            try
            {
                SldWorks events = (SldWorks)sw;
                events.ActiveDocChangeNotify -= OnActiveDocChange;
                events.FileOpenPostNotify -= OnFileOpened;
            }
            catch { }
            try { commands.RemoveCommandGroup(GroupId); } catch { }
            try { if (taskView != null) taskView.DeleteView(); } catch { }
            if (pane != null) pane.Dispose();
            Marshal.ReleaseComObject(commands);
            commands = null;
            Marshal.ReleaseComObject(sw);
            sw = null;
            GC.Collect();
            GC.WaitForPendingFinalizers();
            return true;
        }

        private void AddCommands()
        {
            int errors = 0;
            CommandGroup group = commands.CreateCommandGroup2(GroupId, Title, "Forge drawing vault", "Forge drawing vault", -1, true, ref errors);
            int[] sizes = { 20, 32, 40, 64, 96, 128 };
            string[] icons = new string[sizes.Length];
            string[] mainIcons = new string[sizes.Length];
            for (int i = 0; i < sizes.Length; i++)
            {
                icons[i] = Path.Combine(Here, "commands-" + sizes[i] + ".png");
                mainIcons[i] = Path.Combine(Here, "main-" + sizes[i] + ".png");
            }
            group.IconList = icons;
            group.MainIconList = mainIcons;
            int options = (int)(swCommandItemType_e.swMenuItem | swCommandItemType_e.swToolbarItem);
            int[] indexes = new int[Buttons.Length];
            for (int i = 0; i < Buttons.Length; i++)
                indexes[i] = group.AddCommandItem2(Buttons[i][0], -1, Buttons[i][1], Buttons[i][0], i, Buttons[i][2], "", i + 1, options);
            group.HasToolbar = true;
            group.HasMenu = true;
            group.Activate();

            int[] docTypes = { (int)swDocumentTypes_e.swDocPART, (int)swDocumentTypes_e.swDocASSEMBLY, (int)swDocumentTypes_e.swDocDRAWING };
            foreach (int docType in docTypes)
            {
                CommandTab tab = commands.GetCommandTab(docType, Title);
                if (tab != null) commands.RemoveCommandTab(tab);
                tab = commands.AddCommandTab(docType, Title);
                CommandTabBox box = tab.AddCommandTabBox();
                int[] ids = new int[Buttons.Length];
                int[] text = new int[Buttons.Length];
                for (int i = 0; i < Buttons.Length; i++)
                {
                    ids[i] = group.get_CommandID(indexes[i]);
                    text[i] = (int)swCommandTabButtonTextDisplay_e.swCommandTabButton_TextBelow;
                }
                box.AddCommands(ids, text);
            }
        }

        private void AddPane()
        {
            taskView = (TaskpaneView)sw.CreateTaskpaneView2(Path.Combine(Here, "taskpane.bmp"), "Forge Vault");
            pane = new VaultPane(this);
            taskView.DisplayWindowFromHandlex64(pane.Handle.ToInt64());
        }

        private int OnActiveDocChange()
        {
            if (pane != null) pane.ShowFor(ActivePath());
            return 0;
        }

        private int OnFileOpened(string fileName)
        {
            if (pane != null) pane.ShowFor(ActivePath());
            return 0;
        }

        internal ForgeApi Forge
        {
            get
            {
                if (forgeApi == null) forgeApi = new ForgeApi();
                return forgeApi;
            }
        }

        internal string ActivePath()
        {
            ModelDoc2 model = sw == null ? null : (ModelDoc2)sw.ActiveDoc;
            return model == null ? null : model.GetPathName();
        }

        internal static void Warn(string text)
        {
            MessageBox.Show(text, "Forge Vault", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }

        internal static void Log(string text)
        {
            try
            {
                string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ForgeVault");
                Directory.CreateDirectory(dir);
                File.AppendAllText(Path.Combine(dir, "solidworks.log"), DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + text + Environment.NewLine);
            }
            catch { }
        }

        // The open file, if it is in the Forge Vault folder; otherwise says why not.
        private bool OpenFile(out ModelDoc2 model, out string path)
        {
            model = (ModelDoc2)sw.ActiveDoc;
            path = model == null ? null : model.GetPathName();
            if (model == null) { Warn("Open a part, assembly or drawing first."); return false; }
            if (string.IsNullOrEmpty(path)) { Warn("Save the file into the Forge Vault folder first."); return false; }
            try
            {
                if (Forge.RelativePath(path) == null) { Warn("This file is not in the Forge Vault folder (" + Forge.Root + "). Save it there to keep it in the vault."); return false; }
            }
            catch (Exception e) { Warn(e.Message); return false; }
            return true;
        }

        // Makes SOLIDWORKS treat the open file as the file on disk now is: writable or
        // read-only. Late bound, so one build works across SOLIDWORKS versions.
        private static void MatchDisk(ModelDoc2 model, string path)
        {
            bool readOnly = (File.GetAttributes(path) & FileAttributes.ReadOnly) != 0;
            dynamic doc = model;
            try { doc.SetReadOnlyState(readOnly); }
            catch
            {
                try { doc.ReloadOrReplace(readOnly, "", true); }
                catch { if (!readOnly) Warn("Close and open the file again to edit it."); }
            }
        }

        private void Safely(Action act)
        {
            try { act(); }
            catch (Exception e)
            {
                Exception inner = e is AggregateException && e.InnerException != null ? e.InnerException : e;
                Log("Action failed: " + inner);
                Warn("Forge Vault could not do that." + Environment.NewLine + Environment.NewLine + inner.Message);
            }
            if (pane != null) pane.ShowFor(ActivePath());
        }

        public void OnPull()
        {
            ModelDoc2 model; string path;
            if (!OpenFile(out model, out path)) return;
            Safely(() =>
            {
                if (model.GetSaveFlag()) { Warn("This file has changes that are not saved. Save and push them, or close without saving, before pulling."); return; }
                int type = model.GetType();
                sw.CloseDoc(path);
                Forge.Run("pull", path);
                int errors = 0, warnings = 0;
                sw.OpenDoc6(path, type, (int)swOpenDocOptions_e.swOpenDocOptions_Silent, "", ref errors, ref warnings);
            });
        }

        public void OnPush()
        {
            ModelDoc2 model; string path;
            if (!OpenFile(out model, out path)) return;
            Safely(() =>
            {
                int errors = 0, warnings = 0;
                if (model.GetSaveFlag()) model.Save3((int)swSaveAsOptions_e.swSaveAsOptions_Silent, ref errors, ref warnings);
                Forge.Run("push", path);
                MatchDisk(model, path);
            });
        }

        private void RunOnOpenFile(string action)
        {
            ModelDoc2 model; string path;
            if (!OpenFile(out model, out path)) return;
            Safely(() =>
            {
                Forge.Run(action, path);
                MatchDisk(model, path);
            });
        }

        public void OnLock() { RunOnOpenFile("lock"); }
        public void OnUnlock() { RunOnOpenFile("unlock"); }
        public void OnSubmit() { RunOnOpenFile("submit"); }
        public void OnRelease() { RunOnOpenFile("release"); }
        public void OnReject() { RunOnOpenFile("reject"); }
        public void OnNewRevision() { RunOnOpenFile("newrev"); }
        public void OnOpen() { RunOnOpenFile("open"); }
        public void OnRefresh() { if (pane != null) pane.ShowFor(ActivePath()); }

        // ---------- registration (RegAsm /codebase) ----------
        [ComRegisterFunction]
        public static void Register(Type t)
        {
            string id = "{" + t.GUID.ToString().ToUpperInvariant() + "}";
            using (RegistryKey key = Registry.LocalMachine.CreateSubKey(@"SOFTWARE\SolidWorks\Addins\" + id))
            {
                key.SetValue(null, 1);
                key.SetValue("Description", "Forge drawing vault: pull, push, lock, release, and file state");
                key.SetValue("Title", "Forge Vault");
            }
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\SolidWorks\AddInsStartup\" + id))
                key.SetValue(null, 1);
        }

        [ComUnregisterFunction]
        public static void Unregister(Type t)
        {
            string id = "{" + t.GUID.ToString().ToUpperInvariant() + "}";
            Registry.LocalMachine.DeleteSubKeyTree(@"SOFTWARE\SolidWorks\Addins\" + id, false);
            Registry.CurrentUser.DeleteSubKeyTree(@"Software\SolidWorks\AddInsStartup\" + id, false);
        }
    }

    // ---------- The Task Pane panel ----------
    public class VaultPane : UserControl
    {
        private readonly ForgeVaultAddin addin;
        private readonly Label fileName = new Label();
        private readonly Label state = new Label();
        private readonly Label details = new Label();
        private readonly FlowLayoutPanel buttons = new FlowLayoutPanel();
        private readonly ListView versions = new ListView();
        private readonly ListBox history = new ListBox();
        private readonly Timer timer = new Timer();
        private string shownPath;

        public VaultPane(ForgeVaultAddin owner)
        {
            addin = owner;
            BackColor = Color.White;
            Font = new Font("Segoe UI", 9f);
            Padding = new Padding(8);

            Label heading = new Label { Text = "Forge Vault", Font = new Font("Segoe UI Semibold", 12f), ForeColor = Color.FromArgb(31, 95, 168), Dock = DockStyle.Top, Height = 28 };
            fileName.Dock = DockStyle.Top; fileName.Height = 22; fileName.Font = new Font("Segoe UI Semibold", 9.5f); fileName.AutoEllipsis = true;
            state.Dock = DockStyle.Top; state.Height = 26; state.TextAlign = ContentAlignment.MiddleLeft; state.ForeColor = Color.White; state.Padding = new Padding(6, 0, 0, 0);
            details.Dock = DockStyle.Top; details.Height = 92; details.Padding = new Padding(0, 6, 0, 0);
            buttons.Dock = DockStyle.Top; buttons.Height = 132; buttons.WrapContents = true;
            AddButton("Pull", owner.OnPull);
            AddButton("Push", owner.OnPush);
            AddButton("Lock", owner.OnLock);
            AddButton("Unlock", owner.OnUnlock);
            AddButton("Send for review", owner.OnSubmit);
            AddButton("Release", owner.OnRelease);
            AddButton("Send back", owner.OnReject);
            AddButton("New revision", owner.OnNewRevision);
            AddButton("Show in Forge", owner.OnOpen);

            Label versionsTitle = new Label { Text = "Versions", Dock = DockStyle.Top, Height = 20, Font = new Font("Segoe UI Semibold", 9f) };
            versions.Dock = DockStyle.Top; versions.Height = 150; versions.View = View.Details; versions.FullRowSelect = true; versions.HeaderStyle = ColumnHeaderStyle.Nonclickable;
            versions.Columns.Add("Ver", 40); versions.Columns.Add("Rev", 40); versions.Columns.Add("Pushed", 110); versions.Columns.Add("By", 90); versions.Columns.Add("Message", 160);
            Label historyTitle = new Label { Text = "History", Dock = DockStyle.Top, Height = 20, Font = new Font("Segoe UI Semibold", 9f) };
            history.Dock = DockStyle.Fill; history.IntegralHeight = false; history.BorderStyle = BorderStyle.None;

            // Docked controls stack from the last added, so add bottom first.
            Controls.Add(history);
            Controls.Add(historyTitle);
            Controls.Add(versions);
            Controls.Add(versionsTitle);
            Controls.Add(buttons);
            Controls.Add(details);
            Controls.Add(state);
            Controls.Add(fileName);
            Controls.Add(heading);

            timer.Interval = 30000;
            timer.Tick += (s, e) => ShowFor(addin.ActivePath());
            timer.Start();
            ShowFor(null);
        }

        private void AddButton(string text, Action click)
        {
            Button b = new Button { Text = text, Width = 112, Height = 28, FlatStyle = FlatStyle.System };
            b.Click += (s, e) => click();
            buttons.Controls.Add(b);
        }

        private void ShowState(string label, Color colour)
        {
            state.Text = label;
            state.BackColor = colour;
        }

        public void ShowFor(string path)
        {
            shownPath = path;
            if (string.IsNullOrEmpty(path))
            {
                fileName.Text = "No file open";
                ShowState("", Color.White);
                details.Text = "Open a part, assembly or drawing from the Forge Vault folder to see its state here.";
                versions.Items.Clear(); history.Items.Clear();
                return;
            }
            fileName.Text = Path.GetFileName(path);
            ForgeApi forge;
            try { forge = addin.Forge; }
            catch (Exception e) { ShowState("Not set up", Color.Gray); details.Text = e.Message; return; }
            string rel = forge.RelativePath(path);
            if (rel == null)
            {
                ShowState("Outside the vault", Color.Gray);
                details.Text = "This file is not in " + forge.Root + ". Save it there to keep it in the vault.";
                versions.Items.Clear(); history.Items.Clear();
                return;
            }
            ShowState("Reading from Forge...", Color.Gray);
            Task.Factory.StartNew(() =>
            {
                Dictionary<string, object> s = forge.Status(rel);
                bool differs = s != null && File.Exists(path) && ForgeApi.Sha256(path) != Values.Text(s, "sha256");
                return Tuple.Create(s, differs);
            }).ContinueWith(t =>
            {
                if (IsDisposed || shownPath != path) return;
                BeginInvoke(new Action(() => Fill(t)));
            });
        }

        private void Fill(Task<Tuple<Dictionary<string, object>, bool>> t)
        {
            versions.Items.Clear();
            history.Items.Clear();
            if (t.IsFaulted)
            {
                ShowState("Cannot reach Forge", Color.FromArgb(192, 46, 46));
                details.Text = t.Exception.GetBaseException().Message;
                return;
            }
            Dictionary<string, object> s = t.Result.Item1;
            bool differs = t.Result.Item2;
            if (s == null)
            {
                ShowState("Not in the vault yet", Color.Gray);
                details.Text = "Push it to add it to the vault.";
                return;
            }
            string st = Values.Text(s, "state");
            string by = Values.Text(s, "checkedOutBy");
            if (Values.Flag(s, "mine")) ShowState("Locked by you", Color.FromArgb(44, 122, 75));
            else if (by.Length > 0) ShowState("Locked by " + by, Color.FromArgb(192, 46, 46));
            else if (st == "RELEASED") ShowState("Released, revision " + Values.Text(s, "revision"), Color.FromArgb(31, 95, 168));
            else if (st == "REVIEW") ShowState("In review", Color.FromArgb(194, 132, 16));
            else if (st == "OBSOLETE") ShowState("Obsolete", Color.FromArgb(95, 107, 122));
            else ShowState("Being worked on", Color.FromArgb(95, 107, 122));
            bool canPush = Values.Text(s, "level") == "PUSH";
            details.Text = "Forge has version " + Values.Text(s, "version") + (Values.Text(s, "revision").Length > 0 ? ", revision " + Values.Text(s, "revision") : ", not released yet") + Environment.NewLine +
                (differs ? "Your copy differs from it: pull to get it, or push your change." : "Your copy is the same as Forge's.") + Environment.NewLine +
                (canPush ? "You can pull and push this file." : "You can pull this file, not push it.") + Environment.NewLine +
                (Values.Text(s, "itemCode").Length > 0 ? "Item " + Values.Text(s, "itemCode") : "");
            object list;
            if (s.TryGetValue("versions", out list) && list is IEnumerable)
                foreach (object o in (IEnumerable)list)
                {
                    Dictionary<string, object> v = o as Dictionary<string, object>;
                    if (v == null) continue;
                    DateTime at;
                    string when = DateTime.TryParse(Values.Text(v, "at"), out at) ? at.ToLocalTime().ToString("dd MMM yy HH:mm") : "";
                    versions.Items.Add(new ListViewItem(new[] { "v" + Values.Text(v, "version"), Values.Text(v, "revision"), when, Values.Text(v, "by"), Values.Text(v, "note") }));
                }
            if (s.TryGetValue("history", out list) && list is IEnumerable)
                foreach (object o in (IEnumerable)list)
                {
                    Dictionary<string, object> h = o as Dictionary<string, object>;
                    if (h != null) history.Items.Add(Values.Text(h, "action") + " - " + Values.Text(h, "by") + (Values.Text(h, "note").Length > 0 ? " - " + Values.Text(h, "note") : ""));
                }
        }
    }
}
