// 手机网关控制台 —— 把「网关 / ngrok 隧道 / 防火墙 / 聊天入口」收进一个窗口
//
// 为什么要有它：原来要双击三个 bat、手改 ngrok.yml、还要单独去点放行防火墙，
// 任何一步漏了手机就连不上，而且出错时看不出是哪一环。
//
// 编译（本机自带 .NET Framework 编译器，不用装任何东西）：
//   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:winexe ^
//     /codepage:65001 /out:"手机网关控制台.exe" /r:System.Windows.Forms.dll ^
//     /r:System.Drawing.dll /r:System.Web.Extensions.dll gateway-console.cs
//
// 所有状态都靠"真去看一眼"得来：查端口、查进程、问 ngrok 的本地 API、查防火墙规则。
// 不做任何猜测，所以界面上显示的在跑/没跑是准的。

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class GatewayConsole
{
    private const int PORT_DSH = 3080;      // DSH 本体
    private const int PORT_GATEWAY = 3081;  // 网关
    private const int PORT_NGROK_API = 4040; // ngrok 本地管理 API
    private const string FW_RULE = "Mingyue DSH gateway";

    private static string baseDir;
    private static string cfgPath;
    private static string iniPath;

    private static Form form;
    private static Label lblDsh, lblGw, lblTunnel, lblFw;
    private static Label lblUrl, lblLocal, lblHint;
    private static TextBox log;
    private static Button btnAll, btnGw, btnTunnel, btnFw, btnChat;
    private static TextBox txtToken;
    private static System.Windows.Forms.Timer poll;
    private static int refreshing = 0;              // 防重入：上一轮没跑完就不开新的
    private static DateTime lastSlow = DateTime.MinValue;
    private static bool cDsh, cGw, cTunnel, cFw;
    private static string cUrl;                     // 缓存的状态，UI 只读这些，不做探测


    private static Ini ini;
    private static Process procGw, procTunnel;

    // ------------------------------------------------------------------ 入口

    [STAThread]
    private static void Main(string[] args)
    {
        baseDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\', '/');
        iniPath = Path.Combine(baseDir, "gateway-console.ini");
        cfgPath = Path.Combine(baseDir, "gateway.config.json");
        ini = Ini.Load(iniPath);

        // 每次启动清空日志文件，避免上次的旧记录混进来
        try { File.WriteAllText(LogPath(), "==== " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " 启动 ====" + Environment.NewLine, new UTF8Encoding(false)); }
        catch { }

        // 自检模式：不开窗，直接把状态打到控制台。
        // 用途：界面出问题（比如想确认"防火墙为什么显示没放行"）时，
        // 不用靠截图和猜，让程序自己说。
        bool selftest = false;
        foreach (string a in args) if (a == "--selftest") selftest = true;
        if (selftest) { RunSelfTest(); return; }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        form = BuildForm();
        form.Shown += delegate
        {
            Refresh_Status();
            poll = new System.Windows.Forms.Timer();
            poll.Interval = 2000;
            poll.Tick += delegate { try { Refresh_Status(); } catch { } };
            poll.Start();
        };
        Application.Run(form);
    }

    // ------------------------------------------------------------ 状态采集

    /// 把四个服务的真实状态查一遍并返回。界面和自检共用这一份逻辑，
    /// 保证"看到什么"和"报什么"一定一致。
    private static string Probe()
    {
        bool dsh = PortOpen(PORT_DSH);
        bool gw = PortOpen(PORT_GATEWAY);
        bool ngrokApi = PortOpen(PORT_NGROK_API);
        string url = ngrokApi ? NgrokPublicUrl() : null;
        bool fw = FirewallRuleExists();

        StringBuilder sb = new StringBuilder();
        sb.AppendLine("---- 手机网关控制台 · 自检 ----");
        sb.AppendLine("程序目录     : " + baseDir);
        sb.AppendLine("DSH 本体 3080: " + (dsh ? "运行中" : "没运行"));
        sb.AppendLine("网关     3081: " + (gw ? "运行中" : "没运行"));
        sb.AppendLine("ngrok   API  : " + (ngrokApi ? "在跑" : "没跑") + "   网址: " + (url ?? "（还没拿到）"));
        sb.AppendLine("防火墙放行   : " + (fw ? "有规则" : "没有规则") + "   规则名: " + FW_RULE);
        sb.AppendLine("ngrok 令牌   : " + (txtToken != null && txtToken.Text.Trim().Length > 0 ? "界面上有输入"
                                        : (File.Exists(NgrokConfig()) ? "已写入 ngrok.yml" : "还没有")));
        sb.AppendLine("ngrok.exe    : " + NgrokExe() + (File.Exists(NgrokExe()) ? "  [在]" : "  [找不到]"));
        sb.AppendLine("node         : " + NodeExe());
        sb.Append("本机地址     :");
        foreach (string a in LocalIPv4()) sb.Append("  http://" + a + ":" + PORT_GATEWAY);
        sb.AppendLine();
        sb.AppendLine("手机要填     : " + (url ?? "（先把网关和隧道起来）"));
        sb.AppendLine("---- end ----");
        return sb.ToString();
    }

    private static void RunSelfTest()
    {
        // 设置控制台编码要包起来。
        // 没有控制台句柄时（比如输出被重定向、或者被别的程序拉起来）
        // 这行会抛 System.IO.IOException: 句柄无效，直接把 -selftest 弄崩。
        try { Console.OutputEncoding = Encoding.UTF8; } catch { }
        Console.Write(Probe());
    }

    // -------------------------------------------------------------------- UI

    private static Form BuildForm()
    {
        Form f = new Form();
        f.Text = "手机网关控制台";
        f.ClientSize = new Size(720, 600);
        f.MinimumSize = new Size(640, 520);
        f.StartPosition = FormStartPosition.CenterScreen;
        f.Font = new Font("Microsoft YaHei UI", 9F);

        int y = 10;

        // ---- 四个服务的状态行 ----
        Button bDsh;
        y = AddServiceRow(f, "DSH 本体 (3080)", out lblDsh, out bDsh, y, null);
        y = AddServiceRow(f, "网关 (3081)", out lblGw, out btnGw, y, delegate { ToggleGateway(); });
        y = AddServiceRow(f, "ngrok 隧道", out lblTunnel, out btnTunnel, y, delegate { ToggleTunnel(); });
        y = AddServiceRow(f, "防火墙放行", out lblFw, out btnFw, y, delegate { FixFirewall(); });

        // ---- 一行大按钮 ----
        btnAll = new Button();
        btnAll.Text = "一键启动（网关 + 隧道）";
        btnAll.SetBounds(14, y + 4, 200, 34);
        btnAll.Click += delegate { StartAll(); };
        f.Controls.Add(btnAll);

        Button bLocal = new Button();
        bLocal.Text = "本机打开聊天";
        bLocal.SetBounds(222, y + 4, 130, 34);
        bLocal.Click += delegate { OpenBrowser("http://127.0.0.1:" + PORT_GATEWAY + "/"); };
        f.Controls.Add(bLocal);

        btnChat = new Button();
        btnChat.Text = "复制手机要填的地址";
        btnChat.SetBounds(360, y + 4, 170, 34);
        btnChat.Click += delegate { CopyPhoneUrl(); };
        f.Controls.Add(btnChat);

        Button bRefresh = new Button();
        bRefresh.Text = "刷新";
        bRefresh.SetBounds(538, y + 4, 80, 34);
        bRefresh.Click += delegate { Refresh_Status(); };
        f.Controls.Add(bRefresh);

        Button bStop = new Button();
        bStop.Text = "全部停止";
        bStop.SetBounds(626, y + 4, 80, 34);
        bStop.Click += delegate { StopAll(); };
        f.Controls.Add(bStop);
        y += 46;

        // ---- ngrok 令牌 ----
        Label lt = new Label();
        lt.Text = "ngrok 令牌";
        lt.SetBounds(14, y + 6, 76, 20);
        f.Controls.Add(lt);

        txtToken = new TextBox();
        txtToken.SetBounds(94, y + 3, 300, 24);
        txtToken.UseSystemPasswordChar = false;
        txtToken.Text = ini.Get("ngrok_token");
        // 有些环境里 Ctrl+V 进不来（输入法/安全软件拦剪贴板），所以另给按钮
        f.Controls.Add(txtToken);

        Button bPasteTok = new Button();
        bPasteTok.Text = "粘贴";
        bPasteTok.SetBounds(400, y + 2, 66, 26);
        bPasteTok.Click += delegate { PasteToken(); };
        f.Controls.Add(bPasteTok);

        Button bClearTok = new Button();
        bClearTok.Text = "清空";
        bClearTok.SetBounds(470, y + 2, 60, 26);
        bClearTok.Click += delegate { txtToken.Clear(); Log("令牌输入框已清空（还没保存）"); };
        f.Controls.Add(bClearTok);

        Button bSaveTok = new Button();
        bSaveTok.Text = "保存令牌";
        bSaveTok.SetBounds(534, y + 2, 88, 26);
        bSaveTok.Click += delegate { SaveToken(); };
        f.Controls.Add(bSaveTok);

        Button bGet = new Button();
        bGet.Text = "去注册";
        bGet.SetBounds(626, y + 2, 80, 26);
        bGet.Click += delegate { OpenBrowser("https://dashboard.ngrok.com/get-started/your-authtoken"); };
        f.Controls.Add(bGet);
        y += 34;

        // ---- 地址显示 ----
        lblLocal = new Label();
        lblLocal.Text = "本机地址：—";
        lblLocal.ForeColor = Color.DimGray;
        lblLocal.SetBounds(14, y, 692, 18);
        f.Controls.Add(lblLocal);
        y += 20;

        lblUrl = new Label();
        lblUrl.Text = "手机要填的地址：—";
        lblUrl.ForeColor = Color.FromArgb(0, 100, 0);
        lblUrl.Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold);
        lblUrl.SetBounds(14, y, 692, 20);
        f.Controls.Add(lblUrl);
        y += 26;

        // ---- 日志 ----
        log = new TextBox();
        log.Multiline = true;
        log.ReadOnly = true;
        log.ScrollBars = ScrollBars.Vertical;
        log.Font = new Font("Consolas", 9F);
        log.SetBounds(14, y, 692, 150);
        log.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;
        f.Controls.Add(log);
        y += 156;

        // ---- 底部提示 ----
        lblHint = new Label();
        lblHint.Text = "提示：三个窗口/进程缺一不可。关掉这个控制台不会停掉网关和隧道（想停请点「全部停止」）。";
        lblHint.ForeColor = Color.Gray;
        lblHint.SetBounds(14, y, 692, 32);
        lblHint.Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;
        f.Controls.Add(lblHint);

        return f;
    }

    private static int AddServiceRow(Form f, string name, out Label status, out Button action, int y, EventHandler onClick)
    {
        Label ln = new Label();
        ln.Text = name;
        ln.SetBounds(14, y, 150, 22);
        f.Controls.Add(ln);

        status = new Label();
        status.Text = "○ 检测中…";
        status.ForeColor = Color.Gray;
        status.SetBounds(170, y, 300, 22);
        f.Controls.Add(status);

        action = new Button();
        if (onClick == null)
        {
            action.Text = "由你自己的启动器管理";
            action.Enabled = false;
            action.SetBounds(478, y - 3, 228, 28);
        }
        else
        {
            action.Text = "启动";
            action.SetBounds(478, y - 3, 110, 28);
            action.Click += onClick;
        }
        f.Controls.Add(action);

        return y + 32;
    }

    // ---------------------------------------------------------------- 状态刷新

    private static bool PortOpen(int port)
    {
        try
        {
            using (TcpClient c = new TcpClient())
            {
                IAsyncResult ar = c.BeginConnect("127.0.0.1", port, null, null);
                bool ok = ar.AsyncWaitHandle.WaitOne(300, false);
                if (!ok) return false;
                c.EndConnect(ar);
                return true;
            }
        }
        catch { return false; }
    }

    private static string HttpGet(string url, int ms)
    {
        try
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
            req.Timeout = ms; req.ReadWriteTimeout = ms;
            using (HttpWebResponse r = (HttpWebResponse)req.GetResponse())
            using (StreamReader sr = new StreamReader(r.GetResponseStream(), Encoding.UTF8))
                return sr.ReadToEnd();
        }
        catch { return null; }
    }

    private static string NgrokPublicUrl()
    {
        string j = HttpGet("http://127.0.0.1:" + PORT_NGROK_API + "/api/tunnels", 1200);
        if (j == null) return null;
        try
        {
            JavaScriptSerializer ser = new JavaScriptSerializer();
            Dictionary<string, object> o = (Dictionary<string, object>)ser.DeserializeObject(j);
            object[] tunnels = (object[])o["tunnels"];
            foreach (object t in tunnels)
            {
                Dictionary<string, object> d = (Dictionary<string, object>)t;
                string u = d.ContainsKey("public_url") ? (string)d["public_url"] : null;
                if (!string.IsNullOrEmpty(u) && u.StartsWith("https")) return u;
            }
            if (tunnels.Length > 0)
            {
                Dictionary<string, object> d = (Dictionary<string, object>)tunnels[0];
                return d.ContainsKey("public_url") ? (string)d["public_url"] : null;
            }
        }
        catch { }
        return null;
    }

    /// 规则是否存在。走两条路，任一命中即算存在：
    ///   ① 读注册表（普通权限就能读，实测可用）
    ///   ② netsh（有时普通权限读不到，作为兜底）
    /// 只用 netsh 时曾误报「没有规则」，把用户引去重复放行。
    private static bool FirewallRuleExists()
    {
        // ---- ① 注册表 ----
        try
        {
            using (Microsoft.Win32.RegistryKey k = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(
                @"SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters\FirewallPolicy\FirewallRules"))
            {
                if (k != null)
                {
                    foreach (string name in k.GetValueNames())
                    {
                        object v = k.GetValue(name);
                        string s = v as string;
                        if (s != null && s.IndexOf("Name=" + FW_RULE, StringComparison.OrdinalIgnoreCase) >= 0)
                        {
                            return true;
                        }
                    }
                }
            }
        }
        catch { }

        // ---- ② netsh ----
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo("netsh",
                "advfirewall firewall show rule name=\"" + FW_RULE + "\"");
            psi.UseShellExecute = false;
            psi.RedirectStandardOutput = true;
            psi.CreateNoWindow = true;
            using (Process p = Process.Start(psi))
            {
                string o = p.StandardOutput.ReadToEnd();
                p.WaitForExit(4000);
                bool hit = o != null && o.IndexOf("LocalPort", StringComparison.OrdinalIgnoreCase) >= 0;
                if (hit) return true;
            }
        }
        catch { }

        return false;
    }

    private static void SetStatus(Label l, bool on, string onText, string offText)
    {
        if (form == null || !form.IsHandleCreated) return;
        form.BeginInvoke((MethodInvoker)delegate
        {
            l.Text = (on ? "● " : "○ ") + (on ? onText : offText);
            l.ForeColor = on ? Color.FromArgb(0, 130, 0) : Color.Gray;
        });
    }

    /// 触发一次状态刷新。**探测全部在后台线程做**，UI 只负责显示缓存值 ——
    /// 原来在 UI 线程上做端口探测和 netstat（可阻塞数秒），界面就被冻住了。
    private static void Refresh_Status()
    {
        if (System.Threading.Interlocked.Exchange(ref refreshing, 1) == 1) return;
        ThreadPool.QueueUserWorkItem(delegate
        {
            try
            {
                cDsh = PortOpen(PORT_DSH);
                cGw = PortOpen(PORT_GATEWAY);
                bool api = PortOpen(PORT_NGROK_API);
                cUrl = api ? NgrokPublicUrl() : null;
                cTunnel = api;

                // 防火墙和网卡枚举很贵，10 秒才查一次
                bool needSlow = (DateTime.Now - lastSlow).TotalSeconds > 10;
                if (needSlow)
                {
                    cFw = FirewallRuleExists();
                    lastSlow = DateTime.Now;
                }

                string localText;
                if (needSlow)
                {
                    StringBuilder lb = new StringBuilder("本机地址（同一个 WiFi 时才用得上）：");
                    bool any = false;
                    foreach (string a in LocalIPv4()) { lb.Append("  http://").Append(a).Append(':').Append(PORT_GATEWAY); any = true; }
                    if (!any) lb.Append("  没检测到局域网地址");
                    cacheLocal = lb.ToString();
                }
                localText = cacheLocal;

                bool gw = cGw, fw = cFw;
                string url = cUrl;
                bool tunnel = cTunnel;
                DateTime slowMark = lastSlow;
                bool slowThis = needSlow;
                if (form != null && form.IsHandleCreated)
                    form.BeginInvoke((MethodInvoker)delegate
                    {
                        try
                        {
                            SetStatusInline(lblDsh, cDsh, "运行中", "没运行（去双击 Start-DSH.cmd）");
                            SetStatusInline(lblGw, gw, "运行中", "没运行");
                            SetStatusInline(lblTunnel, tunnel && url != null, url != null ? "已连通" : "在跑但没拿到网址", "没运行");
                            SetStatusInline(lblFw, fw, "已放行 3081", "没有放行规则");

                            if (slowThis && localText != null) lblLocal.Text = localText;

                            if (url != null)
                                lblUrl.Text = "手机要填的地址：" + url + "     （令牌用 DSH 启动时打印的那串 token）";
                            else if (gw)
                                lblUrl.Text = "手机要填的地址：还没拿到 —— 隧道没起来，或 ngrok 令牌没配";
                            else
                                lblUrl.Text = "手机要填的地址：先把网关和隧道起来";

                            btnGw.Text = gw ? "停止" : "启动";
                            btnTunnel.Text = tunnel ? "停止" : "启动";
                            btnFw.Text = fw ? "重新放行" : "放行防火墙";
                        }
                        catch { }
                    });
            }
            catch { }
            finally { System.Threading.Interlocked.Exchange(ref refreshing, 0); }
        });
    }

    private static string cacheLocal = "本机地址：—";

    /// 直接改控件（已在 UI 线程上调用，不再 BeginInvoke）。
    /// 只在文字真的变了才写，避免每秒无谓重绘。
    private static void SetStatusInline(Label l, bool on, string onText, string offText)
    {
        string t = (on ? "● " : "○ ") + (on ? onText : offText);
        if (l.Text != t)
        {
            l.Text = t;
            l.ForeColor = on ? Color.FromArgb(0, 130, 0) : Color.Gray;
        }
    }

    private static List<string> LocalIPv4()
    {
        List<string> r = new List<string>();
        try
        {
            foreach (System.Net.NetworkInformation.NetworkInterface ni in
                     System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces())
            {
                if (ni.OperationalStatus != System.Net.NetworkInformation.OperationalStatus.Up) continue;
                foreach (System.Net.NetworkInformation.UnicastIPAddressInformation u in
                         ni.GetIPProperties().UnicastAddresses)
                {
                    if (u.Address.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(u.Address))
                        r.Add(u.Address.ToString());
                }
            }
        }
        catch { }
        return r;
    }

    // ---------------------------------------------------------------- 各动作

    private static string NodeExe()
    {
        string p = ini.Get("node");
        if (!string.IsNullOrEmpty(p) && File.Exists(p)) return p;
        foreach (string c in new string[] {
            @"C:\Program Files\nodejs\node.exe",
            @"C:\Program Files (x86)\nodejs\node.exe" })
            if (File.Exists(c)) return c;
        return "node.exe";
    }

    private static string NgrokExe()
    {
        string p = ini.Get("ngrok");
        if (!string.IsNullOrEmpty(p) && File.Exists(p)) return p;
        string c = Path.Combine(baseDir, "ngrok.exe");
        if (File.Exists(c)) return c;
        return "ngrok.exe";
    }

    private static string NgrokConfig()
    {
        return Path.Combine(baseDir, "ngrok.yml");
    }

    /// 直接写出 ngrok 认的配置文件，不依赖 ngrok 自己的写入命令。
    /// 原来只把令牌存进 ini，ngrok.yml 一直不存在 -> 启动时
    /// "open ...ngrok.yml: The system cannot find the file specified" 直接退出。
    private static bool WriteNgrokConfigFile(string token)
    {
        try
        {
            Directory.CreateDirectory(baseDir);
            StringBuilder sb = new StringBuilder();
            sb.AppendLine("# 由手机网关控制台生成，勿手改（改界面上那个输入框即可）");
            sb.AppendLine("version: \"3\"");
            // ngrok v3 把 authtoken 放在 agent 下面。写在顶层会报
            // "field authtoken not found in type config.v3yamlConfig"，实测如此。
            sb.AppendLine("agent:");
            sb.AppendLine("    authtoken: " + token.Trim());
            File.WriteAllText(NgrokConfig(), sb.ToString(), new UTF8Encoding(false));
            return true;
        }
        catch (Exception e) { Log("写 ngrok 配置失败：" + e.Message); return false; }
    }

    private static string LogPath()
    {
        return Path.Combine(baseDir, "gateway-console.log");
    }

    /// 日志写两处：界面日志区（给人看）+ 文件（事后能查，也方便贴出来）。
    private static void Log(string s)
    {
        string line = DateTime.Now.ToString("HH:mm:ss ") + s;
        try { File.AppendAllText(LogPath(), line + Environment.NewLine, new UTF8Encoding(false)); }
        catch { }
        if (form == null || !form.IsHandleCreated) return;
        form.BeginInvoke((MethodInvoker)delegate
        {
            log.AppendText(line + Environment.NewLine);
            log.SelectionStart = log.TextLength;
            log.ScrollToCaret();
        });
    }

    /// 从剪贴板取文本填进令牌框。Ctrl+V 在某些环境里被拦，这个按钮绕过去。
    private static void PasteToken()
    {
        try
        {
            if (!Clipboard.ContainsText()) { Log("剪贴板里没有文字。先在 ngrok 页面点 Copy 再点这里。"); return; }
            string t = Clipboard.GetText().Trim();
            if (t.Length == 0) { Log("剪贴板里的内容是空的。"); return; }
            // 有的人会把整行粘贴进来，做个清理：去掉空白和引号
            t = t.Replace("\r", "").Replace("\n", "").Replace(" ", "").Replace("\"", "").Replace("'", "");
            txtToken.Text = t;
            txtToken.SelectionStart = txtToken.TextLength;
            Log("已从剪贴板粘贴令牌（长度 " + t.Length + "）。确认无误后点「保存令牌」。");
        }
        catch (Exception e) { Log("读取剪贴板失败：" + e.Message); }
    }

    private static void SaveToken()
    {
        string tok = txtToken.Text.Trim();
        if (tok.Length == 0) { Log("令牌是空的，没保存。"); return; }
        ini.Set("ngrok_token", tok);
        ini.Save(iniPath);
        Log("令牌已保存到 " + iniPath);

        // 直接写文件，不走 ngrok 的写入命令（那条路要求父目录已存在，且输出是 GBK 会乱码）
        if (WriteNgrokConfigFile(tok))
            Log("已写入 " + NgrokConfig() + "（现在可以点「启动」了）");
    }

    private static void StartGateway()
    {
        if (PortOpen(PORT_GATEWAY)) { Log("网关已经在跑了，跳过。"); return; }
        string js = Path.Combine(baseDir, "gateway.js");
        if (!File.Exists(js)) { Log("!! 找不到 gateway.js（应该和本程序同目录）"); return; }
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(NodeExe(), "\"" + js + "\" --port " + PORT_GATEWAY + " --no-prompt");
            psi.WorkingDirectory = baseDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
        // ngrok 与 node 的输出都是 UTF-8（实测：中文路径按 UTF-8 解码才正确）
        psi.StandardOutputEncoding = Encoding.UTF8;
        psi.StandardErrorEncoding = Encoding.UTF8;
            procGw = new Process();
            procGw.StartInfo = psi;
            procGw.OutputDataReceived += delegate (object s, DataReceivedEventArgs e) { if (e.Data != null) Log("[网关] " + e.Data); };
            procGw.ErrorDataReceived += delegate (object s, DataReceivedEventArgs e) { if (e.Data != null) Log("[网关] " + e.Data); };
            // 子进程死掉必须报出来，否则界面只显示"没运行"，用户不知道是崩了还是没点
            procGw.EnableRaisingEvents = true;
            procGw.Exited += delegate (object s, EventArgs e)
            {
                int code = -1;
                try { code = procGw.ExitCode; } catch { }
                Log("!! 网关进程已退出（exit=" + code + "）—— 上面几行是它的报错。");
                Log("   最常见原因：3081 端口被别的程序占用，或 gateway.js 不在本目录。");
                Refresh_Status();
            };
            procGw.Start();
            procGw.BeginOutputReadLine();
            procGw.BeginErrorReadLine();

            // 等端口真的绑上再报成功。原来 Process.Start 一成功就说"已启动"，
            // 而那时端口可能还没绑、进程随后就退出 —— 日志和界面会互相矛盾。
            ThreadPool.QueueUserWorkItem(delegate
            {
                for (int i = 0; i < 30; i++)
                {
                    if (procGw == null || procGw.HasExited) return;   // 已由 Exited 事件报过
                    if (PortOpen(PORT_GATEWAY))
                    {
                        Log("网关已就绪（端口 " + PORT_GATEWAY + " 已监听）");
                        Refresh_Status();
                        return;
                    }
                    System.Threading.Thread.Sleep(200);
                }
                Log("!! 网关启动了但 6 秒内没有监听 " + PORT_GATEWAY + "，可能没起来。看上面的输出。");
                Refresh_Status();
            });
        }
        catch (Exception e) { Log("!! 启动网关失败：" + e.Message); }
    }

    private static void StopGateway()
    {
        if (procGw != null && !procGw.HasExited)
        {
            try { procGw.Kill(); Log("网关已停止。"); } catch (Exception e) { Log("停止网关失败：" + e.Message); }
            return;
        }
        int pid = PidOnPort(PORT_GATEWAY);
        if (pid > 0)
        {
            try { Process.GetProcessById(pid).Kill(); Log("已停止占用 " + PORT_GATEWAY + " 的进程 pid=" + pid); }
            catch (Exception e) { Log("停止失败：" + e.Message); }
        }
        else Log("网关本来就没在跑。");
    }

    private static void StartTunnel()
    {
        if (PortOpen(PORT_NGROK_API)) { Log("隧道已经在跑了，跳过。"); return; }
        if (!File.Exists(NgrokExe()) && NgrokExe() == "ngrok.exe") { Log("!! 找不到 ngrok.exe"); return; }
        // 令牌有两处来源：界面输入框，或已有的 ngrok.yml。都没有就引导去注册。
        string tok = txtToken.Text.Trim();
        if (tok.Length == 0 && !File.Exists(NgrokConfig()))
        {
            Log("!! 还没有 ngrok 令牌。先去 dashboard.ngrok.com 注册（免费、不用信用卡），");
            Log("   把 authtoken 粘到上面的输入框，点「保存令牌」，然后再点启动。");
            OpenBrowser("https://dashboard.ngrok.com/get-started/your-authtoken");
            return;
        }
        // 配置文件必须存在：ngrok 不会自建父目录，缺了就直接退出
        if (!File.Exists(NgrokConfig()))
        {
            if (!WriteNgrokConfigFile(tok)) return;
            Log("已生成 " + NgrokConfig());
        }
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(NgrokExe(),
                "--config \"" + NgrokConfig() + "\" http " + PORT_GATEWAY + " --log stdout");
            psi.WorkingDirectory = baseDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
        // ngrok 与 node 的输出都是 UTF-8（实测：中文路径按 UTF-8 解码才正确）
        psi.StandardOutputEncoding = Encoding.UTF8;
        psi.StandardErrorEncoding = Encoding.UTF8;
            procTunnel = new Process();
            procTunnel.StartInfo = psi;
            procTunnel.OutputDataReceived += delegate (object s, DataReceivedEventArgs e)
            {
                if (e.Data == null) return;
                // 滤掉 ngrok 自己的 HTTP 访问日志：那是本程序每 2 秒问一次它
                // 本地 API 造成的刷屏（msg=start/end pg=/api/tunnels），对用户没意义
                if (e.Data.IndexOf("pg=/api/tunnels", StringComparison.Ordinal) >= 0) return;
                Log("[隧道] " + e.Data);
            };
            procTunnel.ErrorDataReceived += delegate (object s, DataReceivedEventArgs e) { if (e.Data != null) Log("[隧道] " + e.Data); };
            procTunnel.EnableRaisingEvents = true;
            procTunnel.Exited += delegate (object s, EventArgs e)
            {
                int code = -1;
                try { code = procTunnel.ExitCode; } catch { }
                Log("!! 隧道进程已退出（exit=" + code + "）—— 上面几行是 ngrok 的报错。");
                Log("   常见原因：令牌无效/未配置、或 ngrok 连不上服务器。");
                Refresh_Status();
            };
            procTunnel.Start();
            procTunnel.BeginOutputReadLine();
            procTunnel.BeginErrorReadLine();
            Log("隧道启动中…（拿到网址后上面会显示）");

            ThreadPool.QueueUserWorkItem(delegate
            {
                for (int i = 0; i < 40; i++)
                {
                    if (procTunnel == null || procTunnel.HasExited) return;
                    string u = NgrokPublicUrl();
                    if (u != null)
                    {
                        Log("隧道已连通：" + u);
                        Refresh_Status();
                        return;
                    }
                    System.Threading.Thread.Sleep(500);
                }
                Log("!! 20 秒内没拿到公网网址，隧道可能没连上。看上面的 ngrok 输出。");
            });
        }
        catch (Exception e) { Log("!! 启动隧道失败：" + e.Message); }
    }

    private static void StopTunnel()
    {
        if (procTunnel != null && !procTunnel.HasExited)
        {
            try { procTunnel.Kill(); Log("隧道已停止。"); } catch (Exception e) { Log("停止隧道失败：" + e.Message); }
            return;
        }
        foreach (Process p in Process.GetProcessesByName("ngrok"))
        {
            try { p.Kill(); Log("已停止 ngrok pid=" + p.Id); } catch { }
        }
    }

    private static void FixFirewall()
    {
        string bat = Path.Combine(baseDir, "放行防火墙.cmd");
        if (!File.Exists(bat)) { Log("!! 找不到 放行防火墙.cmd"); return; }
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(bat);
            psi.UseShellExecute = true;      // 需要 UAC 提权
            psi.Verb = "runas";
            psi.WorkingDirectory = baseDir;
            Process.Start(psi);
            Log("已请求放行防火墙（UAC 弹窗点「是」）。");
        }
        catch (Exception e) { Log("放行失败（UAC 被拒绝？）：" + e.Message); }
    }

    private static void ToggleGateway()
    {
        if (PortOpen(PORT_GATEWAY)) StopGateway(); else StartGateway();
        Refresh_Status();
    }

    private static void ToggleTunnel()
    {
        if (PortOpen(PORT_NGROK_API)) StopTunnel(); else StartTunnel();
        Refresh_Status();
    }

    private static void StartAll()
    {
        Log("---- 一键启动 ----");
        if (!PortOpen(PORT_DSH))
            Log("!! DSH 本体没在跑。请先启动 DSH（它是个命令行窗口，必须一直开着），再回来点启动。");
        if (!FirewallRuleExists()) Log("提示：防火墙还没放行，手机可能连不上。点右边「放行防火墙」。");
        StartGateway();
        ThreadPool.QueueUserWorkItem(delegate
        {
            for (int i = 0; i < 20 && !PortOpen(PORT_GATEWAY); i++) Thread.Sleep(300);
            if (PortOpen(PORT_GATEWAY)) { StartTunnel(); }
            else Log("!! 网关没起来，隧道先不开了。");
        });
    }

    private static void StopAll()
    {
        Log("---- 全部停止 ----");
        StopTunnel();
        StopGateway();
    }

    private static void CopyPhoneUrl()
    {
        string u = PortOpen(PORT_NGROK_API) ? NgrokPublicUrl() : null;
        if (u == null)
        {
            Log("还没有可复制的网址（隧道没起来）。");
            return;
        }
        try { Clipboard.SetText(u); Log("已复制：" + u + "  —— 粘到手机的「电脑地址」里"); }
        catch (Exception e) { Log("复制失败：" + e.Message); }
    }

    private static int PidOnPort(int port)
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo("netstat", "-ano");
            psi.UseShellExecute = false; psi.RedirectStandardOutput = true; psi.CreateNoWindow = true;
            using (Process p = Process.Start(psi))
            {
                string o = p.StandardOutput.ReadToEnd();
                p.WaitForExit(5000);
                foreach (string line in o.Split('\n'))
                {
                    if (line.IndexOf("LISTENING", StringComparison.OrdinalIgnoreCase) < 0) continue;
                    if (line.IndexOf(":" + port + " ", StringComparison.Ordinal) < 0) continue;
                    string[] parts = line.Trim().Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                    int pid;
                    if (parts.Length >= 5 && int.TryParse(parts[parts.Length - 1], out pid)) return pid;
                }
            }
        }
        catch { }
        return 0;
    }

    private static void OpenBrowser(string url)
    {
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
        catch (Exception e) { Log("打开浏览器失败：" + e.Message); }
    }
}

// ------------------------------------------------------------------ 迷你 INI

internal class Ini
{
    private readonly Dictionary<string, string> map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    private string path;

    public static Ini Load(string p)
    {
        Ini i = new Ini();
        i.path = p;
        try
        {
            if (File.Exists(p))
                foreach (string line in File.ReadAllLines(p, Encoding.UTF8))
                {
                    string s = line.Trim();
                    if (s.Length == 0 || s.StartsWith("#") || s.StartsWith(";")) continue;
                    int eq = s.IndexOf('=');
                    if (eq <= 0) continue;
                    i.map[s.Substring(0, eq).Trim()] = s.Substring(eq + 1).Trim();
                }
        }
        catch { }
        return i;
    }

    public string Get(string k) { string v; return map.TryGetValue(k, out v) ? v : ""; }
    public void Set(string k, string v) { map[k] = v ?? ""; }

    public void Save(string p)
    {
        try
        {
            StringBuilder sb = new StringBuilder();
            sb.AppendLine("# 手机网关控制台的设置（删掉会重新生成）");
            foreach (KeyValuePair<string, string> kv in map) sb.AppendLine(kv.Key + "=" + kv.Value);
            File.WriteAllText(p, sb.ToString(), new UTF8Encoding(false));
        }
        catch { }
    }
}
