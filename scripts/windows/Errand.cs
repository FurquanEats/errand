// Errand for Windows: the app you click. It starts Errand's server in the background, opens its
// window, and sits by the clock (Open, Start with Windows, Update, Quit). Run from outside an
// install (like Downloads) it is the setup program instead. Built with the C# compiler that comes
// with Windows by scripts/windows/build.ps1; C# 5, .NET Framework 4.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;
#if WEBVIEW
using System.Runtime.InteropServices;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
#endif

[assembly: AssemblyTitle("Errand")]
[assembly: AssemblyProduct("Errand")]
[assembly: AssemblyCompany("Zovle")]
[assembly: AssemblyDescription("Errand, the free, open-source personal AI agent")]
[assembly: AssemblyCopyright("Copyright (c) 2026 Mohammed Furquan, Zovle. MIT License.")]

namespace Errand
{
    static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            var flags = new HashSet<string>(args, StringComparer.OrdinalIgnoreCase);
            var install = new Install(Path.GetDirectoryName(Application.ExecutablePath));
            try
            {
                if (flags.Contains("--uninstall")) return Uninstaller.Run(install, flags.Contains("--quiet"));
                if (flags.Contains("--update")) return Setup.Run(install);
                if (!install.Installed) return Setup.Run(null);
                return Tray.Run(install, flags.Contains("--background"));
            }
            catch (Exception err)
            {
                MessageBox.Show("Errand ran into a problem: " + err.Message, "Errand", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }
    }

    /// <summary>Where this copy of Errand lives and how to reach its server.</summary>
    class Install
    {
        public readonly string Root, AppDir, DataDir, Exe, Log;
        public readonly int Port = 4747;
        public readonly string NodePath;

        public Install(string root)
        {
            Root = root;
            AppDir = Path.Combine(root, "app");
            DataDir = Path.Combine(root, "data");
            Exe = Application.ExecutablePath;
            Log = Path.Combine(root, "errand.log");
            // errand.ini is written by the installer: node=<path to node.exe>, port=<port>.
            var ini = Path.Combine(root, "errand.ini");
            string node = null;
            if (File.Exists(ini))
            {
                foreach (var line in File.ReadAllLines(ini))
                {
                    var i = line.IndexOf('=');
                    if (i < 0) continue;
                    var key = line.Substring(0, i).Trim().ToLowerInvariant();
                    var value = line.Substring(i + 1).Trim();
                    int port;
                    if (key == "node" && File.Exists(value)) node = value;
                    if (key == "port" && int.TryParse(value, out port)) Port = port;
                }
            }
            if (node == null && File.Exists(Path.Combine(root, @"node\node.exe"))) node = Path.Combine(root, @"node\node.exe");
            if (node == null) node = FindOnPath("node.exe");
            NodePath = node;
        }

        public bool Installed { get { return File.Exists(Path.Combine(AppDir, "package.json")); } }
        public bool IsErrandInstall
        {
            get
            {
                if (!Installed || !File.Exists(Path.Combine(Root, "errand.ini"))) return false;
                return File.ReadAllText(Path.Combine(AppDir, "package.json")).Contains("\"name\": \"errand\"");
            }
        }
        public string Url { get { return "http://127.0.0.1:" + Port; } }
        // A short, stable name for this install, so two installs don't share a tray icon.
        public string Id
        {
            get
            {
                uint h = 2166136261;
                foreach (var c in Root.ToLowerInvariant()) { h ^= c; h *= 16777619; }
                return h.ToString("x8");
            }
        }

        static string FindOnPath(string file)
        {
            foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
            {
                try
                {
                    var p = Path.Combine(dir.Trim(), file);
                    if (dir.Trim().Length > 0 && File.Exists(p)) return p;
                }
                catch (ArgumentException) { }
            }
            return null;
        }

        /// <summary>HTTP status of a call to the local server, or -1 if nothing answers.</summary>
        public int Call(string method, string path, int timeoutMs)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(Url + path);
                req.Method = method;
                req.Timeout = timeoutMs;
                req.Proxy = null;
                req.Headers["X-Errand"] = "1";
                if (method == "POST") { req.ContentType = "application/json"; req.ContentLength = 0; }
                using (var res = (HttpWebResponse)req.GetResponse()) return (int)res.StatusCode;
            }
            catch (WebException err)
            {
                var res = err.Response as HttpWebResponse;
                return res != null ? (int)res.StatusCode : -1;
            }
        }

        public int Status() { return Call("GET", "/api/status", 1500); }

        public static Icon AppIcon(Size size)
        {
            using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("icon.ico"))
                return s != null ? new Icon(s, size) : SystemIcons.Application;
        }
    }

    /// <summary>The icon by the clock. Owns the server it starts and exits when Errand stops.</summary>
    class Tray : ApplicationContext
    {
        const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        const string OwnKey = @"Software\Zovle\Errand";
        readonly Install install;
        readonly NotifyIcon icon;
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
        readonly object logLock = new object();
        Process node;
        StreamWriter log;
        bool ready, quitting;
        int misses;
        DateTime quitAt;
        int opening;
        volatile bool exiting;
        // Runs notification work on the UI thread (the icon belongs to it).
        readonly Control ui = new Control();

        public static int Run(Install install, bool background)
        {
            bool first;
            using (var mutex = new Mutex(true, @"Local\Errand-" + install.Id, out first))
            using (var show = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\ErrandShow-" + install.Id))
            using (var wake = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\ErrandWake-" + install.Id))
            {
                if (!first)
                {
                    // Already running: ask that copy to show the window (or just to keep Errand running).
                    (background ? wake : show).Set();
                    // If that copy was on its way out, take over once it has gone.
                    try { first = mutex.WaitOne(3000); } catch (AbandonedMutexException) { first = true; }
                    if (!first) return 0;
                }
                var tray = new Tray(install, background);
                var waiter = new Thread(() =>
                {
                    var handles = new WaitHandle[] { show, wake };
                    while (true) tray.Wanted(WaitHandle.WaitAny(handles) == 0);
                });
                waiter.IsBackground = true;
                waiter.Start();
                Application.Run(tray);
            }
            return 0;
        }

        // Someone clicked the icon (open = true) or started Errand with Windows. If Errand is on its way
        // out, start it again once it has stopped instead of leaving nothing running.
        volatile bool restartWanted, openAfterRestart;

        void Wanted(bool open)
        {
            var status = install.Status();
            var running = node;
            var stopping = quitting || status == 503 || (running == null ? status != 200 : running.HasExited);
            if (!stopping)
            {
                if (open) OpenWindow();
                return;
            }
            if (open) openAfterRestart = true;
            restartWanted = true;
        }

        void Restart()
        {
            if (install.Status() == 503) return; // still shutting down; try on the next tick
            restartWanted = false;
            quitting = false;
            ready = false;
            misses = 0;
            var open = openAfterRestart;
            openAfterRestart = false;
            if (install.Status() == 200) { if (open) OpenWindow(); return; }
            StartServer(!open);
            if (open && OwnWindow) OpenWindow(); // it shows "Starting Errand…" until the server answers
        }

        Tray(Install install, bool background)
        {
            this.install = install;
            icon = new NotifyIcon();
            icon.Icon = Install.AppIcon(SystemInformation.SmallIconSize);
            icon.Text = "Errand";
            icon.ContextMenuStrip = BuildMenu();
            icon.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) OpenWindow(); };
            icon.BalloonTipClicked += (s, e) => OpenWindow();
            icon.Visible = true;
            ui.CreateControl();

            var status = install.Status();
            for (var i = 0; status == 503 && i < 40; i++) { Thread.Sleep(500); status = install.Status(); } // the last one is quitting
            if (status == 200)
            {
                ready = true;
                if (!background) OpenWindow();
            }
            else
            {
                StartServer(background);
                if (!background && OwnWindow) OpenWindow();
            }

            if (!background) FirstRunTip();
            timer.Interval = 2000;
            timer.Tick += (s, e) => Check();
            timer.Start();
            var listener = new Thread(Listen);
            listener.IsBackground = true;
            listener.Start();
        }

        // Things Errand wants you to know ("Raycast moved your application to Interview") arrive here
        // only while no Errand window is open; then they show as Windows notifications.
        void Listen()
        {
            var json = new JavaScriptSerializer();
            while (!exiting)
            {
                try
                {
                    var req = (HttpWebRequest)WebRequest.Create(install.Url + "/api/events?client=tray");
                    req.Proxy = null;
                    req.Timeout = 5000;
                    req.ReadWriteTimeout = 90000; // Errand pings every 25 s
                    using (var res = req.GetResponse())
                    using (var reader = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                    {
                        string line;
                        while (!exiting && (line = reader.ReadLine()) != null)
                        {
                            if (!line.StartsWith("data: ") || line.Length <= 6) continue;
                            var e = json.Deserialize<Dictionary<string, object>>(line.Substring(6));
                            object type, title, body, urgent;
                            if (!e.TryGetValue("type", out type) || (type as string) != "notify" || !e.TryGetValue("title", out title)) continue;
                            e.TryGetValue("body", out body);
                            e.TryGetValue("urgent", out urgent);
                            ShowNotification(title as string, body as string, urgent is bool && (bool)urgent);
                        }
                    }
                }
                catch (WebException err)
                {
                    var res = err.Response as HttpWebResponse;
                    if (res != null && (res.StatusCode == HttpStatusCode.Unauthorized || res.StatusCode == HttpStatusCode.Forbidden)) return; // password-protected
                }
                catch (Exception) { }
                Thread.Sleep(5000);
            }
        }

        void ShowNotification(string title, string body, bool urgent)
        {
            if (string.IsNullOrEmpty(title) || exiting) return;
            try
            {
                ui.BeginInvoke((MethodInvoker)(() =>
                {
                    if (!exiting) icon.ShowBalloonTip(10000, title, string.IsNullOrEmpty(body) ? title : body, urgent ? ToolTipIcon.Warning : ToolTipIcon.Info);
                }));
            }
            catch (InvalidOperationException) { }
        }

        ContextMenuStrip BuildMenu()
        {
            var menu = new ContextMenuStrip();
            var open = new ToolStripMenuItem("Open Errand", null, (s, e) => OpenWindow());
            open.Font = new Font(open.Font, FontStyle.Bold);
            menu.Items.Add(open);
            menu.Items.Add(new ToolStripSeparator());
            var startup = new ToolStripMenuItem("Start with Windows");
            startup.Checked = StartsWithWindows();
            startup.Click += (s, e) => { SetStartsWithWindows(!StartsWithWindows()); startup.Checked = StartsWithWindows(); };
            // It can also be changed in Settings or from chat, so check again each time the menu opens.
            menu.Opening += (s, e) => startup.Checked = StartsWithWindows();
            menu.Items.Add(startup);
            menu.Items.Add(new ToolStripMenuItem("Update Errand…", null, (s, e) => Update()));
            menu.Items.Add(new ToolStripMenuItem("Show log", null, (s, e) => ShowLog()));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(new ToolStripMenuItem("Quit Errand", null, (s, e) => Quit()));
            return menu;
        }

        void StartServer(bool background)
        {
            if (install.NodePath == null)
            {
                Fail("Errand can't find Node.js, which it runs on. Run Errand's setup again to fix it.");
                return;
            }
            var psi = new ProcessStartInfo(install.NodePath, "--disable-warning=ExperimentalWarning --import tsx server/index.ts");
            psi.WorkingDirectory = install.AppDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            psi.EnvironmentVariables["ERRAND_DATA_DIR"] = install.DataDir;
            psi.EnvironmentVariables["ERRAND_PORT"] = install.Port.ToString();
            psi.EnvironmentVariables["ERRAND_LAUNCHER"] = install.Exe;
            psi.EnvironmentVariables["PATH"] = Path.GetDirectoryName(install.NodePath) + ";" + Environment.GetEnvironmentVariable("PATH");
            // Errand's own window opens from here; otherwise the server opens one in the browser.
            if (!background && !OwnWindow) psi.EnvironmentVariables["ERRAND_OPEN"] = "1";
            try
            {
                log = new StreamWriter(new FileStream(install.Log, FileMode.Create, FileAccess.Write, FileShare.ReadWrite), new UTF8Encoding(false));
                log.AutoFlush = true;
            }
            catch (IOException) { log = null; }
            node = new Process();
            node.StartInfo = psi;
            node.OutputDataReceived += (s, e) => WriteLog(e.Data);
            node.ErrorDataReceived += (s, e) => WriteLog(e.Data);
            node.Start();
            node.BeginOutputReadLine();
            node.BeginErrorReadLine();
        }

        void WriteLog(string line)
        {
            if (line == null || log == null) return;
            lock (logLock) { try { log.WriteLine(line); } catch (IOException) { } }
        }

        void Check()
        {
            if (node != null)
            {
                if (!node.HasExited)
                {
                    if (!ready && install.Status() == 200) ready = true;
                    if (quitting && DateTime.Now - quitAt > TimeSpan.FromSeconds(15)) { try { node.Kill(); } catch (InvalidOperationException) { } }
                    return;
                }
                var code = node.ExitCode;
                node = null;
                // It found Errand already running (and opened its window): keep the icon for that one.
                if (!quitting && install.Status() == 200) { ready = true; return; }
                if (restartWanted) { Restart(); return; }
                if (!quitting && code != 0)
                {
                    Fail(ready
                        ? "Errand stopped unexpectedly. Click its icon to start it again."
                        : "Errand could not start.");
                    return;
                }
                Exit();
                return;
            }
            // Watching an Errand this icon didn't start: leave when it stops.
            if (restartWanted) Restart();
            else if (install.Status() == 200) misses = 0;
            else if (++misses >= 3) Exit();
        }

#if WEBVIEW
        // Errand's own window (WebView2), when this copy was built with it and Windows has the runtime.
        static readonly bool OwnWindow = AppWindow.Available;
        AppWindow window;

        void ShowOwnWindow()
        {
            if (window != null && !window.IsDisposed) { window.Bring(); return; }
            window = new AppWindow(install);
            window.FormClosed += (s, e) => window = null;
            window.Show();
        }
#else
        const bool OwnWindow = false;
#endif

        public void OpenWindow()
        {
#if WEBVIEW
            if (OwnWindow)
            {
                try { ui.BeginInvoke((MethodInvoker)ShowOwnWindow); } catch (InvalidOperationException) { }
                return;
            }
#endif
            if (Interlocked.Exchange(ref opening, 1) == 1) return;
            ThreadPool.QueueUserWorkItem(_ =>
            {
                try
                {
                    // While it's still starting, keep asking for a little while.
                    for (var i = 0; i < 60; i++)
                    {
                        var code = install.Call("POST", "/api/window", 2000);
                        if (code == 200) return;
                        if (code == 404) break; // an older Errand without /api/window
                        if (node == null && !ready && i > 6) break;
                        Thread.Sleep(500);
                    }
                    Process.Start(install.Url);
                }
                catch (Exception) { }
                finally { Interlocked.Exchange(ref opening, 0); }
            });
        }

        void Quit()
        {
            quitting = true;
            quitAt = DateTime.Now;
            if (install.Call("POST", "/api/quit", 3000) < 0 && node == null) Exit();
        }

        void Update()
        {
            var answer = MessageBox.Show(
                "Errand will close, install the latest version and open again in a minute or two. Your chats, memories and settings stay.",
                "Update Errand", MessageBoxButtons.OKCancel, MessageBoxIcon.Information);
            if (answer != DialogResult.OK) return;
            Process.Start(install.Exe, "--update");
        }

        void ShowLog()
        {
            if (File.Exists(install.Log)) Process.Start("notepad.exe", "\"" + install.Log + "\"");
            else MessageBox.Show("There is no log yet.", "Errand");
        }

        void Fail(string text)
        {
            timer.Stop();
            icon.Visible = false;
            var answer = MessageBox.Show(text + "\n\nOpen the log to see what happened?", "Errand", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
            if (answer == DialogResult.Yes) ShowLog();
            Exit();
        }

        void Exit()
        {
            exiting = true;
            timer.Stop();
            icon.Visible = false;
            icon.Dispose();
            if (log != null) lock (logLock) { log.Dispose(); log = null; }
            ExitThread();
        }

        void FirstRunTip()
        {
            using (var key = Registry.CurrentUser.CreateSubKey(OwnKey))
            {
                if (key.GetValue("TrayTipShown") != null) return;
                key.SetValue("TrayTipShown", 1);
            }
            icon.ShowBalloonTip(10000, "Errand is running",
                "It keeps working in the background, here by the clock, so it can notice things and run your scheduled tasks. Right-click it to quit.",
                ToolTipIcon.Info);
        }

        string StartupCommand { get { return "\"" + install.Exe + "\" --background"; } }

        bool StartsWithWindows()
        {
            using (var key = Registry.CurrentUser.OpenSubKey(RunKey))
                return key != null && string.Equals(key.GetValue("Errand") as string, StartupCommand, StringComparison.OrdinalIgnoreCase);
        }

        void SetStartsWithWindows(bool on)
        {
            using (var key = Registry.CurrentUser.CreateSubKey(RunKey))
            {
                if (on) key.SetValue("Errand", StartupCommand);
                else key.DeleteValue("Errand", false);
            }
        }
    }

#if WEBVIEW
    /// <summary>
    /// Errand's own window: the app in WebView2 with no title bar of Windows' own. Errand's top bar is
    /// the title bar (drag it, double-click it) and draws minimise, maximise and close. Sign-ins and
    /// other sites open in your browser.
    /// </summary>
    class AppWindow : Form
    {
        const int WM_NCCALCSIZE = 0x83, WM_NCHITTEST = 0x84, HTCLIENT = 1, HTTOP = 12, HTTOPLEFT = 13, HTTOPRIGHT = 14;
        const string OwnKey = @"Software\Zovle\Errand";
        readonly Install install;
        readonly WebView2 view = new WebView2();
        readonly System.Windows.Forms.Timer waiting = new System.Windows.Forms.Timer();
        bool loaded;

        [StructLayout(LayoutKind.Sequential)]
        struct RECT { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)]
        struct NCCALCSIZE_PARAMS { public RECT Rgrc0, Rgrc1, Rgrc2; public IntPtr Pos; }
        [DllImport("user32.dll")]
        static extern int GetSystemMetrics(int index);

        public static bool Available
        {
            get
            {
                try { return !string.IsNullOrEmpty(CoreWebView2Environment.GetAvailableBrowserVersionString()); }
                catch (Exception) { return false; } // no runtime, or built without the WebView2 files next to it
            }
        }

        static bool Dark
        {
            get
            {
                using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
                    return key != null && key.GetValue("AppsUseLightTheme") is int && (int)key.GetValue("AppsUseLightTheme") == 0;
            }
        }

        public AppWindow(Install install)
        {
            this.install = install;
            Text = "Errand";
            Icon = Install.AppIcon(new Size(32, 32));
            MinimumSize = new Size(720, 500);
            BackColor = Dark ? Color.FromArgb(0x15, 0x14, 0x12) : Color.FromArgb(0xF2, 0xEF, 0xE8);
            StartPosition = FormStartPosition.Manual;
            var screen = Screen.FromPoint(Cursor.Position).WorkingArea;
            Bounds = SavedBounds() ?? new Rectangle(screen.X + screen.Width / 12, screen.Y + screen.Height / 14, screen.Width * 5 / 6, screen.Height * 6 / 7);
            using (var key = Registry.CurrentUser.OpenSubKey(OwnKey))
                if (key != null && (key.GetValue("WindowMaximized") as int?) == 1) WindowState = FormWindowState.Maximized;
            view.Dock = DockStyle.Fill;
            view.DefaultBackgroundColor = BackColor;
            Controls.Add(view);
            Resize += (s, e) => Framed();
            FormClosing += (s, e) => SaveBounds();
            Load += (s, e) => Start();
            Framed();
        }

        public void Bring()
        {
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
        }

        // A thin strip above the page, so the top edge can still be dragged to resize.
        void Framed()
        {
            Padding = new Padding(0, WindowState == FormWindowState.Maximized ? 0 : 4, 0, 0);
            if (loaded) view.CoreWebView2.PostWebMessageAsString(WindowState == FormWindowState.Maximized ? "maximized" : "restored");
        }

        async void Start()
        {
            try
            {
                var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(install.Root, "webview"));
                await view.EnsureCoreWebView2Async(env);
            }
            catch (Exception err)
            {
                MessageBox.Show("Errand couldn't open its window: " + err.Message, "Errand");
                Close();
                return;
            }
            var web = view.CoreWebView2;
            web.Settings.IsStatusBarEnabled = false;
            web.Settings.AreDevToolsEnabled = false;
            web.Settings.IsNonClientRegionSupportEnabled = true; // CSS app-region: drag moves the window
            web.DocumentTitleChanged += (s, e) => Text = web.DocumentTitle;
            web.NewWindowRequested += (s, e) => { e.Handled = true; OpenOutside(e.Uri); };
            web.NavigationStarting += (s, e) =>
            {
                // Sign-ins (Google, Microsoft, ChatGPT, OpenRouter) run start to finish in your browser:
                // providers block embedded windows, and the flow must stay in one browser.
                if (Own(e.Uri) && e.Uri.IndexOf("/api/oauth/", StringComparison.OrdinalIgnoreCase) < 0) return;
                e.Cancel = true;
                OpenOutside(e.Uri);
            };
            web.PermissionRequested += (s, e) =>
            {
                if (Own(e.Uri) && (e.PermissionKind == CoreWebView2PermissionKind.Microphone || e.PermissionKind == CoreWebView2PermissionKind.Notifications))
                    e.State = CoreWebView2PermissionState.Allow;
            };
            web.WebMessageReceived += (s, e) =>
            {
                string message;
                try { message = e.TryGetWebMessageAsString(); } catch (ArgumentException) { return; }
                if (message == "minimize") WindowState = FormWindowState.Minimized;
                else if (message == "maximize") WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
                else if (message == "close") Close();
            };
            web.NavigationCompleted += (s, e) => { if (loaded) Framed(); };
            loaded = true;
            web.NavigateToString(Splash());
            // Show Errand as soon as its server answers (it may still be starting).
            waiting.Interval = 400;
            waiting.Tick += (s, e) =>
            {
                waiting.Stop();
                ThreadPool.QueueUserWorkItem(_ =>
                {
                    var up = install.Status() == 200;
                    try { BeginInvoke((MethodInvoker)(() => { if (up) web.Navigate(install.Url + "/"); else waiting.Start(); })); }
                    catch (InvalidOperationException) { }
                });
            };
            waiting.Start();
        }

        bool Own(string uri)
        {
            if (uri.StartsWith("about:") || uri.StartsWith("data:")) return true;
            Uri u;
            return Uri.TryCreate(uri, UriKind.Absolute, out u) && u.Port == install.Port && (u.Host == "127.0.0.1" || u.Host == "localhost");
        }

        static void OpenOutside(string uri)
        {
            Uri u;
            if (Uri.TryCreate(uri, UriKind.Absolute, out u) && (u.Scheme == "http" || u.Scheme == "https" || u.Scheme == "mailto"))
                try { Process.Start(u.AbsoluteUri); } catch (Exception) { }
        }

        string Splash()
        {
            var dark = Dark;
            return "<!doctype html><html><body style=\"margin:0;height:100vh;display:grid;place-items:center;background:" + (dark ? "#151412" : "#f2efe8") +
                ";color:" + (dark ? "#8f897c" : "#6f695e") + ";font:14px 'Segoe UI Variable Text','Segoe UI',sans-serif;-webkit-app-region:drag\">" +
                "<div style=\"text-align:center\"><svg width=\"56\" height=\"56\" viewBox=\"0 0 512 512\"><rect width=\"512\" height=\"512\" rx=\"116\" fill=\"#1a1917\"/>" +
                "<path d=\"M128 262h184a92 92 0 1 0-26 66\" fill=\"none\" stroke=\"#f6f4ef\" stroke-width=\"44\"/><circle cx=\"372\" cy=\"340\" r=\"32\" fill=\"#e2531f\"/></svg>" +
                "<p>Starting Errand…</p></div></body></html>";
        }

        Rectangle? SavedBounds()
        {
            using (var key = Registry.CurrentUser.OpenSubKey(OwnKey))
            {
                var v = key == null ? null : key.GetValue("WindowBounds") as string;
                if (v == null) return null;
                var p = v.Split(',');
                int x, y, w, h;
                if (p.Length != 4 || !int.TryParse(p[0], out x) || !int.TryParse(p[1], out y) || !int.TryParse(p[2], out w) || !int.TryParse(p[3], out h)) return null;
                var r = new Rectangle(x, y, w, h);
                // Only if it's still on a screen (a monitor may have been unplugged).
                foreach (var s in Screen.AllScreens) if (s.WorkingArea.IntersectsWith(r)) return r;
                return null;
            }
        }

        void SaveBounds()
        {
            var r = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            using (var key = Registry.CurrentUser.CreateSubKey(OwnKey))
            {
                key.SetValue("WindowBounds", r.X + "," + r.Y + "," + r.Width + "," + r.Height);
                key.SetValue("WindowMaximized", WindowState == FormWindowState.Maximized ? 1 : 0);
            }
        }

        protected override void WndProc(ref Message m)
        {
            // No title bar: the client area starts at the top of the window. The side and bottom
            // borders stay (they're invisible on Windows 10 and 11, and resize the window).
            if (m.Msg == WM_NCCALCSIZE && m.WParam != IntPtr.Zero)
            {
                var top = ((NCCALCSIZE_PARAMS)Marshal.PtrToStructure(m.LParam, typeof(NCCALCSIZE_PARAMS))).Rgrc0.Top;
                base.WndProc(ref m);
                var p = (NCCALCSIZE_PARAMS)Marshal.PtrToStructure(m.LParam, typeof(NCCALCSIZE_PARAMS));
                // A maximised window hangs over the screen edge by its frame; keep the page on screen.
                p.Rgrc0.Top = top + (WindowState == FormWindowState.Maximized ? GetSystemMetrics(33) + GetSystemMetrics(92) : 0);
                Marshal.StructureToPtr(p, m.LParam, false);
                m.Result = IntPtr.Zero;
                return;
            }
            base.WndProc(ref m);
            if (m.Msg == WM_NCHITTEST && (int)m.Result == HTCLIENT && WindowState == FormWindowState.Normal)
            {
                var pt = PointToClient(new Point((short)((long)m.LParam & 0xFFFF), (short)(((long)m.LParam >> 16) & 0xFFFF)));
                if (pt.Y < 5) m.Result = (IntPtr)(pt.X < 12 ? HTTOPLEFT : pt.X > ClientSize.Width - 12 ? HTTOPRIGHT : HTTOP);
            }
        }
    }
#endif

    /// <summary>Runs the installer that is built into this program, in a window that shows progress.</summary>
    static class Setup
    {
        public static int Run(Install update)
        {
            var script = Path.Combine(Path.GetTempPath(), "errand-setup-" + Guid.NewGuid().ToString("N") + ".ps1");
            using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("install.ps1"))
            using (var f = File.Create(script))
            {
                // Windows PowerShell reads a script without a byte order mark in the old code page.
                f.Write(new byte[] { 0xEF, 0xBB, 0xBF }, 0, 3);
                s.CopyTo(f);
            }
            var quoted = script.Replace("'", "''");
            var psi = new ProcessStartInfo(
                Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe"),
                "-NoProfile -ExecutionPolicy Bypass -Command \"& '" + quoted + "'; Remove-Item -LiteralPath '" + quoted + "' -ErrorAction SilentlyContinue\"");
            psi.UseShellExecute = false;
            psi.EnvironmentVariables["ERRAND_SETUP_PAUSE"] = "1";
            psi.EnvironmentVariables["ERRAND_SETUP_EXE"] = Application.ExecutablePath;
            if (update != null)
            {
                psi.EnvironmentVariables["ERRAND_HOME"] = update.Root;
                psi.EnvironmentVariables["ERRAND_PORT"] = update.Port.ToString();
            }
            Process.Start(psi);
            return 0;
        }
    }

    /// <summary>Apps → Installed apps → Errand → Uninstall. Keeps your data unless you say otherwise.</summary>
    static class Uninstaller
    {
        public static int Run(Install install, bool quiet)
        {
            // Only ever remove a folder the installer made (it writes errand.ini next to app\).
            if (!install.IsErrandInstall)
            {
                if (!quiet) MessageBox.Show("This copy of Errand isn't installed, so there is nothing to remove.", "Uninstall Errand");
                return 1;
            }
            var removeData = false;
            if (!quiet)
            {
                if (MessageBox.Show("Remove Errand from this computer?", "Uninstall Errand", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes)
                    return 1;
                removeData = MessageBox.Show(
                    "Also delete your chats, memories, saved passwords and settings?\n\nChoose No to keep them in " + install.DataDir + ". Installing Errand again picks them up.",
                    "Uninstall Errand", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) == DialogResult.Yes;
            }

            // Stop Errand, then the icon by the clock (it leaves once Errand stops).
            if (install.Status() >= 0)
            {
                install.Call("POST", "/api/quit", 3000);
                for (var i = 0; i < 40 && install.Status() >= 0; i++) Thread.Sleep(250);
            }
            var self = Process.GetCurrentProcess().Id;
            foreach (var p in Process.GetProcessesByName("Errand"))
            {
                try
                {
                    if (p.Id == self || !string.Equals(p.MainModule.FileName, install.Exe, StringComparison.OrdinalIgnoreCase)) continue;
                    if (!p.WaitForExit(8000)) p.Kill();
                }
                catch (Exception) { }
            }

            // Only shortcuts and entries that belong to this install (another copy may live elsewhere).
            foreach (var folder in new[] { Environment.GetFolderPath(Environment.SpecialFolder.Desktop), Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs") })
            {
                var lnk = Path.Combine(folder, "Errand.lnk");
                try { if (File.Exists(lnk) && PointsInto(lnk, install.Root)) File.Delete(lnk); } catch (Exception) { }
            }
            using (var run = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true))
            {
                var value = run == null ? null : run.GetValue("Errand") as string;
                if (value != null && value.IndexOf(install.Exe, StringComparison.OrdinalIgnoreCase) >= 0) run.DeleteValue("Errand", false);
            }
            const string entry = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Errand";
            bool listed;
            using (var key = Registry.CurrentUser.OpenSubKey(entry))
                listed = key != null && SamePath(key.GetValue("InstallLocation") as string, install.Root);
            if (listed)
            {
                Registry.CurrentUser.DeleteSubKeyTree(entry, false);
                Registry.CurrentUser.DeleteSubKeyTree(@"Software\Zovle\Errand", false);
            }

            // This program can't delete itself while running, so a short script finishes after it exits.
            // Paths go in through the environment, so any name works.
            var script = Path.Combine(Path.GetTempPath(), "errand-uninstall-" + Guid.NewGuid().ToString("N") + ".cmd");
            File.WriteAllText(script, string.Join("\r\n", new[]
            {
                "@echo off",
                "ping 127.0.0.1 -n 3 > nul",
                "rd /s /q \"%ERRAND_ROOT%\\app\" 2> nul",
                "rd /s /q \"%ERRAND_ROOT%\\node\" 2> nul",
                "for %%f in (Errand.cmd Errand.vbs Errand.ico errand.log errand.ini update.log Errand.exe.new webview2.version Microsoft.Web.WebView2.Core.dll Microsoft.Web.WebView2.WinForms.dll WebView2Loader.dll) do del /f /q \"%ERRAND_ROOT%\\%%f\" 2> nul",
                "rd /s /q \"%ERRAND_ROOT%\\webview\" 2> nul",
                "if \"%ERRAND_REMOVE_DATA%\"==\"1\" rd /s /q \"%ERRAND_ROOT%\\data\" 2> nul",
                "del /f /q \"%ERRAND_EXE%\" 2> nul",
                "rd \"%ERRAND_ROOT%\" 2> nul",
                "(goto) 2> nul & del \"%~f0\"",
            }) + "\r\n", Encoding.ASCII);
            var psi = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "cmd.exe"), "/c \"" + script + "\"");
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.EnvironmentVariables["ERRAND_ROOT"] = install.Root;
            psi.EnvironmentVariables["ERRAND_EXE"] = install.Exe;
            psi.EnvironmentVariables["ERRAND_REMOVE_DATA"] = removeData ? "1" : "0";
            Process.Start(psi);

            if (!quiet)
                MessageBox.Show(removeData ? "Errand was removed." : "Errand was removed. Your data is still in " + install.DataDir + ".",
                    "Uninstall Errand", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 0;
        }

        static bool SamePath(string a, string b)
        {
            if (string.IsNullOrEmpty(a) || string.IsNullOrEmpty(b)) return false;
            return string.Equals(Path.GetFullPath(a).TrimEnd('\\'), Path.GetFullPath(b).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
        }

        // Whether a shortcut opens something inside this install (Errand.exe, or an older launcher).
        static bool PointsInto(string lnk, string root)
        {
            var shellType = Type.GetTypeFromProgID("WScript.Shell");
            var shell = Activator.CreateInstance(shellType);
            var link = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnk });
            var target = (string)link.GetType().InvokeMember("TargetPath", BindingFlags.GetProperty, null, link, null) ?? "";
            var args = (string)link.GetType().InvokeMember("Arguments", BindingFlags.GetProperty, null, link, null) ?? "";
            var prefix = root.TrimEnd('\\') + "\\";
            return target.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) || args.IndexOf(prefix, StringComparison.OrdinalIgnoreCase) >= 0;
        }
    }
}
