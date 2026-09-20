package com.mingyue.dsh;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.content.ComponentCallbacks2;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.HttpAuthHandler;
import android.webkit.JsResult;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.PopupWindow;
import android.widget.TextView;
import android.widget.Toast;

import java.net.URISyntaxException;

/**
 * The whole app: one WebView pointed at the DSH host, plus enough native
 * plumbing (file picker, downloads, swipe-back, pull-to-refresh, an editable
 * address) that it behaves like an app instead of a browser tab.
 */
public class MainActivity extends Activity {

    private static final int REQ_FILE = 1001;

    private WebView web;
    private View emptyState;
    private View loadingFill;
    private TextView toastView;
    private TextView statusText;

    private ValueCallback<Uri[]> fileCallback;
    private String loadedUrl = "";
    private boolean lastLoadFailed = false;
    private String lastProbe = "(还没探测过)";
    private String lastLoadError = "";
    private final java.util.List<String> consoleErrors = new java.util.ArrayList<>();
    /** 鲸鱼挂件是否被隐藏（状态存在页面 localStorage 里）。 */
    private boolean whaleHidden = false;
    /**
     * 是否放行挂件每秒一次的消耗轮询。
     *
     * 默认关。原因见 Prefs.pollEnabled 的注释：那个轮询每秒发一次请求，
     * 而 ngrok 免费版一个月只有 20,000 次额度，开着撑不到 6 小时。
     */
    private boolean pollEnabled = false;
    /** 重建 WebView 期间防重入：旧实例销毁时会再触发一次生命周期回调。 */
    private boolean rebuilding = false;
    /** WebView 的父容器（FrameLayout）；渲染进程死亡后要把新实例放回来。 */
    private android.view.ViewGroup webColumn;

    /**
     * 把诊断信息追加到一个外部文件。
     *
     * 为什么需要：手机上没法开远程调试，WebView 的 onConsoleMessage 也【不会】写进
     * logcat —— 页面的 JS 报错在外面完全看不见。写文件后 adb 就能捞出来，
     * 不用再让用户截图。
     * 位置：/sdcard/Android/data/<包名>/files/dsh-diag.log
     */
    private void diag(String line) {
        try {
            java.io.File dir = getExternalFilesDir(null);
            if (dir == null) dir = getCacheDir();
            java.io.File f = new java.io.File(dir, "dsh-diag.log");
            java.io.FileWriter w = new java.io.FileWriter(f, true);
            w.write(new java.text.SimpleDateFormat("HH:mm:ss.SSS", java.util.Locale.US)
                    .format(new java.util.Date()) + "  " + line + "\n");
            w.close();
        } catch (Throwable ignored) {
        }
    }

    /**
     * 把未捕获的异常写进诊断文件。
     *
     * 为什么需要：手机上没法接调试器，界面又可能什么都来不及显示就崩了 ——
     * 没有这个就只能靠"看不到"来猜。写文件之后 adb 能把真实异常栈取出来。
     * 记录的是完整堆栈，包括是哪个类哪一行。
     */
    private void installCrashLogger() {
        final Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((t, e) -> {
            try {
                java.io.StringWriter sw = new java.io.StringWriter();
                e.printStackTrace(new java.io.PrintWriter(sw));
                diag("!!!! 未捕获异常 @线程 " + t.getName() + " !!!!\n" + sw.toString());
            } catch (Throwable ignored) {
            }
            if (prev != null) prev.uncaughtException(t, e);
        });
    }

    private void diagReset() {
        try {
            java.io.File dir = getExternalFilesDir(null);
            if (dir == null) dir = getCacheDir();
            java.io.File f = new java.io.File(dir, "dsh-diag.log");
            if (f.exists()) f.delete();
            diag("==== 启动 ==== url=" + Prefs.effectiveUrl(this));
        } catch (Throwable ignored) {
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        diagReset();
        installCrashLogger();
        diag("onCreate: 开始");
        setContentView(R.layout.activity_main);
        diag("onCreate: 布局已加载");
        probeWebViewCapability();

        // ---------------------------------------------------------------
        // 初始化顺序很重要，这里踩过坑：
        //   applyIntentOverrides() 内部会调 showToast()，而 showToast 需要
        //   toastView 已经绑定。之前把 applyIntentOverrides 放在视图绑定【之前】，
        //   于是在 toast 那一步抛 NPE，异常被 catch 吞掉，但紧随其后的
        //   Prefs.save() 被整段跳过 —— 配置根本没存下来，用户看到的就是"没反应"。
        //   所以：先把视图全绑好，再动配置。
        // ---------------------------------------------------------------
        web = find(R.id.webview);
        webColumn = find(R.id.webColumn);
        emptyState = find(R.id.emptyState);
        loadingFill = find(R.id.loadingFill);
        toastView = find(R.id.toast);
        statusText = find(R.id.statusText);
        diag("onCreate: 控件已绑定");

        configureWebView();
        wireChrome();
        diag("onCreate: WebView 已配置");

        applyIntentOverrides();
        diag("onCreate: 启动参数已处理");

        measureLater();
        bindBottomBar();

        // The chat body must never be clipped by the soft keyboard.
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);

        if (!Prefs.hasUrl(this)) {
            showEmptyState();
            openSettings();
        } else {
            loadTarget(false);
        }
    }

    /**
     * findViewById 的安全版本。
     *
     * 布局里少一个 id 时，裸的 findViewById(...).setOnClickListener(...)
     * 会直接 NPE、onCreate 中断，表现就是「打开就是一片空白」而且没有任何提示。
     * 这里改成记录到诊断日志并返回 null，让界面还能出来。
     */
    private <T extends View> T find(int id) {
        T v = findViewById(id);
        if (v == null) {
            String name;
            try {
                name = getResources().getResourceEntryName(id);
            } catch (Throwable t) {
                name = String.valueOf(id);
            }
            diag("!! 布局里找不到控件: " + name + " —— 相关功能会不可用");
        }
        return v;
    }

    /** 量一次真实尺寸写进诊断日志，便于一眼看出布局是否塌陷。 */
    private void measureLater() {
        if (web == null) return;
        web.post(() -> {
            try {
                android.util.DisplayMetrics dm = getResources().getDisplayMetrics();
                View root = findViewById(android.R.id.content);
                int[] loc = new int[2];
                web.getLocationOnScreen(loc);
                diag(String.format(
                        "sizes: screen=%dx%d density=%.4f dpW=%d | root=%dx%d | webColumn=%dx%d | web=%dx%d @(%d,%d)",
                        dm.widthPixels, dm.heightPixels, dm.density,
                        Math.round(dm.widthPixels / dm.density),
                        root == null ? -1 : root.getWidth(), root == null ? -1 : root.getHeight(),
                        webColumn == null ? -1 : webColumn.getWidth(),
                        webColumn == null ? -1 : webColumn.getHeight(),
                        web.getWidth(), web.getHeight(), loc[0], loc[1]));
            } catch (Throwable t) {
                diag("size probe failed: " + t);
            }
        });
    }


    /**
     * 显示/关闭鲸鱼挂件。
     *
     * 状态存在 App 偏好里（挂件自己不支持"隐藏"这个状态），
     * 并立刻更新页面里的常驻守卫，所以按钮效果是即时的。
     *
     * 为什么要有这个按钮：用户在手机上实测"鲸鱼缩小一点就不太卡了"，
     * 说明这个挂件（内嵌 2.6MB GIF + 多个 1 秒定时器）确实吃资源。
     * 给它一个随时关掉的入口，比让用户忍着卡要好。
     */
    private void toggleWhale() {
        whaleHidden = !whaleHidden;
        Prefs.setWhaleHidden(this, whaleHidden);
        // 先改状态，再让守卫按新状态应用一次。
        // 守卫内部是【运行时读取】__dshwWantHidden 的，所以这里改完就生效 ——
        // 不再依赖"把状态烘进闭包"那种写法（那是上一版关不掉的原因）。
        String js = "(function(){"
                + "window.__dshwWantHidden = " + (whaleHidden ? "true" : "false") + ";"
                + "var n = window.__dshwApply ? window.__dshwApply() : -1;"
                // 守卫没装上（比如页面刚加载）时兜一手，直接操作 DOM
                + "if(n < 0){"
                + "  var rs=document.querySelectorAll('.dshwv-root');"
                + "  for(var i=0;i<rs.length;i++){"
                + "    rs[i].style.setProperty('display',"
                + "        window.__dshwWantHidden ? 'none' : '', 'important');"
                + "  }"
                + "  n = rs.length;"
                + "}"
                + "return n;"
                + "})()";
        try {
            web.evaluateJavascript(js, (v) -> diag("toggleWhale -> hidden=" + whaleHidden
                    + " nodes=" + unquote(v)));
        } catch (Throwable t) {
            diag("toggleWhale failed: " + t);
        }
        showToast(whaleHidden ? "已关闭挂件（菜单里可再放出）" : "已放出挂件");
    }

    /**
     * 读一次挂件状态并应用。
     *
     * 挂件自己只持久化 dshw-pos / dshw-role / dshw-last-seq 三个键，
     * 【不支持】"被隐藏"这个状态 —— 所以隐藏标记存在 App 自己的偏好里。
     *
     * ⚠️ 这里踩过一个坑：原来只在 onPageFinished 时判断一次、藏一次。
     * 但挂件是【页面加载完之后才动态创建自己节点】的，那一次藏的时候
     * 节点还不存在，于是重启应用后鲸鱼照样冒出来 —— 用户看到的就是
     * "明明关了挂件，重启又自动打开了"。
     *
     * 所以改成【持续守卫】：装一个 MutationObserver 盯着 DOM，
     * 鲸鱼节点一出现就立刻按当前状态处理。这样无论它什么时候创建都能生效。
     */
    private void refreshWhaleState() {
        whaleHidden = Prefs.whaleHidden(this);
        pollEnabled = Prefs.pollEnabled(this);
        installWhaleGuard();
        installFetchGuard();
    }

    /**
     * 在页面里装一个 fetch 拦截器，用来开关挂件的消耗轮询。
     *
     * 背景（真机实测的数据）：
     *   挂件的 whale-widget.js 里有 setInterval(pollLastTurn, 1000)，
     *   每秒请求一次 /dsh-whale/last-turn.json，而且带 cache:'no-store'。
     *   实测挂件开着时每分钟 63 个请求，关掉后仍有 16 个。
     *   ngrok 免费版每月 20,000 次请求 —— 按这个频率撑不到 6 小时。
     *
     * 那个请求的作用只是「这轮对话花了多少钱」的提示泡泡。所以默认拦掉，
     * 用户想要提示时在菜单里打开开关。
     *
     * 为什么用拦截 fetch 而不是改挂件代码：挂件是第三方包，改它会被更新覆盖；
     * 而 App 本来就有「给页面注入常驻 JS」的机制（挂件守卫用的就是这套）。
     */
    private void installFetchGuard() {
        String js = "(function(){"
                + "var allow = " + (pollEnabled ? "true" : "false") + ";"
                + "window.__dshwPollAllowed = allow;"
                + "if(window.__dshwFetchPatched) return allow ? 1 : 0;"
                + "var orig = window.fetch;"
                + "if(typeof orig !== 'function') return -1;"
                + "window.fetch = function(input, init){"
                + "  try{"
                + "    var u = typeof input === 'string' ? input : (input && input.url) || '';"
                // 只拦这一个轮询端点，别的一概放行
                + "    if(!window.__dshwPollAllowed && u.indexOf('/dsh-whale/last-turn.json') >= 0){"
                // 返回一个"没有新数据"的假响应，让挂件的 pollLastTurn 安静退出
                + "      return Promise.resolve(new Response('{\"ok\":false}',"
                + "        {status: 200, headers: {'Content-Type': 'application/json'}}));"
                + "    }"
                + "  }catch(e){}"
                + "  return orig.apply(this, arguments);"
                + "};"
                + "window.__dshwFetchPatched = true;"
                + "return allow ? 1 : 0;"
                + "})()";
        try {
            web.evaluateJavascript(js, (v) -> diag("fetch 守卫: pollEnabled=" + pollEnabled
                    + " 返回=" + unquote(v)));
        } catch (Throwable t) {
            diag("installFetchGuard failed: " + t);
        }
    }

    /** 开关挂件的消耗轮询。 */
    private void togglePoll() {
        pollEnabled = !pollEnabled;
        Prefs.setPollEnabled(this, pollEnabled);
        installFetchGuard();
        showToast(pollEnabled
                ? "已开启消耗提示（会持续发请求，注意流量额度）"
                : "已关闭消耗轮询（不再发请求）");
    }

    /**
     * 在页面里装一个常驻守卫：鲸鱼节点一出现就按 whaleHidden 处理。
     *
     * 为什么用 MutationObserver 而不是定时器：
     *   定时器要一直跑（浪费电），而且总有延迟；观察 DOM 变化是事件驱动，
     *   既即时又不占资源。节点已经存在的话立刻处理一次。
     */
    private void installWhaleGuard() {
        // 关键：apply 里【每次运行时】都读 window.__dshwWantHidden，
        // 绝不把状态烘死进闭包。
        //
        // 这里踩过一个坑：原来写成 `var want = <安装时的值>`，
        // 于是 guard 一装好，want 就固定了 —— 之后用户点「关闭挂件」
        // 虽然改了 __dshwWantHidden，但 guard 内部的 want 还是旧的，
        // 观察者反而把鲸鱼又放回来，表现就是「怎么点都关不掉」。
        String js = "(function(){"
                + "function apply(){"
                + "  var want = !!window.__dshwWantHidden;"
                + "  var rs=document.querySelectorAll('.dshwv-root');"
                + "  for(var i=0;i<rs.length;i++){"
                + "    rs[i].style.setProperty('display', want ? 'none' : '', 'important');"
                + "  }"
                + "  return rs.length;"
                + "}"
                + "window.__dshwApply = apply;"
                // 先把当前状态写进去，再应用；observer 只负责"新节点出现时再应用一次"
                + "window.__dshwWantHidden = " + (whaleHidden ? "true" : "false") + ";"
                + "if(!window.__dshwObserver && window.MutationObserver){"
                + "  window.__dshwObserver = new MutationObserver(function(){ apply(); });"
                + "  window.__dshwObserver.observe(document.documentElement,"
                + "      { childList: true, subtree: true });"
                + "}"
                + "return apply();"
                + "})()";
        try {
            web.evaluateJavascript(js, (v) -> diag("whale guard installed, hidden="
                    + whaleHidden + " nodes=" + unquote(v)));
        } catch (Throwable t) {
            diag("installWhaleGuard failed: " + t);
        }
    }

    /** 底栏三个按钮；任一缺失都不该让整个界面起不来。 */
    private void bindBottomBar() {
        View b;
        b = find(R.id.emptyBtn);
        if (b != null) b.setOnClickListener(v -> openSettings());
        b = find(R.id.btnBack);
        if (b != null) b.setOnClickListener(v -> goBackOrHint());
        b = find(R.id.btnMenu);
        if (b != null) b.setOnClickListener(this::showMenu);
    }

    /**
     * 从启动 Intent 里读 url / token 直接写进配置。
     *
     * 为什么需要：这台手机/模拟器的输入法不认 Ctrl+V，而 adb 的 input text 又不支持
     * `:` `/` 这类字符 —— 自动化和排查时没法把地址填进去。有了这个，
     * `adb shell am start -e url "..." -e token "..."` 就能一步配好。
     * 只对 adb 之类的调试入口开放（正式用户在桌面点图标不会带这些 extra）。
     */
    private void applyIntentOverrides() {
        try {
            android.content.Intent it = getIntent();
            if (it == null) return;
            String url = it.getStringExtra("url");
            String token = it.getStringExtra("token");
            String ua = it.getStringExtra("ua");
            if ((url == null || url.isEmpty()) && (token == null || token.isEmpty())
                    && (ua == null || ua.isEmpty())) {
                return;
            }
            String curUrl = Prefs.url(this);
            String curTok = Prefs.token(this);
            String newUrl = (url == null || url.isEmpty()) ? curUrl : Prefs.normalize(url);
            String newTok = (token == null || token.isEmpty()) ? curTok : token;
            String newUa = (ua == null || ua.isEmpty()) ? Prefs.userAgent(this) : ua;
            Prefs.save(this, newUrl, newTok, Prefs.relaxedTls(this), newUa);
            diag("intent override: url=" + newUrl + " tokenLen=" + newTok.length()
                    + " ua=" + newUa);
            showToast("已从启动参数写入配置");
        } catch (Throwable t) {
            diag("intent override failed: " + t);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        // 回到前台时把页面的可见性状态拉回来。
        //
        // 这是真机实测（chrome://inspect）找到的根因：息屏或切后台久了之后，
        // 页面内的 document.visibilityState 会停在 "hidden" 不再变回来。
        // 浏览器在 hidden 状态下会【暂停 requestAnimationFrame 和渲染】——
        // 于是页面活着（JS 能执行、evaluate 4ms 就回话）、没有报错，
        // 但一帧都不画、也不响应触摸，看起来就是"卡死"，只能删后台重来。
        //
        // 下面这串只做一件事：唤醒时如果发现还是 hidden，就主动把事件补发出去，
        // 让页面重新认为自己可见。
        if (web != null) {
            web.onResume();
            // 连续补几次：可见性的恢复有时滞后于 onResume，
            // 一次不够（真机上见过第一次报 visible、随后又变回 hidden）。
            web.postDelayed(this::nudgeVisibility, 200);
            web.postDelayed(this::nudgeVisibility, 800);
            web.postDelayed(this::nudgeVisibility, 2000);
        }
        if (!Prefs.hasUrl(this)) {
            showEmptyState();
            return;
        }
        String target = Prefs.effectiveUrl(this);
        if (!target.equals(loadedUrl)) {
            loadTarget(false);
        } else {
            emptyState.setVisibility(View.GONE);
        }
    }

    /**
     * 重新获得焦点时也补一次可见性。
     *
     * onResume 之后系统的窗口可见性事件有时还没送达，此时 WebView 内部
     * 仍认为是 hidden。焦点变化是"窗口确实回到前台"的可靠信号，
     * 在这里再补一次，覆盖 onResume 那次没生效的情况。
     */
    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && web != null) {
            web.postDelayed(this::nudgeVisibility, 300);
        }
    }

    // ---------------------------------------------------------------- webview

    /**
     * 唤醒时检查页面可见性，必要时把它"推"回可见状态。
     *
     * 背景（真机 chrome://inspect 实测）：
     *   卡死时页面里读到 document.visibilityState === "hidden"，
     *   而主线程完全正常（evaluate 4ms 回话、无报错）。
     *   hidden 状态下浏览器会暂停 rAF 与渲染 —— 页面活着但一帧都不画，
     *   表现就是"卡死、必须删后台"。
     *
     * 这里做三件事：
     *   1. 把 WebView 重新设为 VISIBLE（有时宿主把它设成了 INVISIBLE/GONE）
     *   2. 重新请求焦点，促使系统重发可见性变化
     *   3. 读一次页面状态写进诊断日志，方便下次判断有没有复发
     */
    private void nudgeVisibility() {
        if (web == null) return;
        try {
            // 关键：光把 View 设成 VISIBLE 不够 —— 真机实测发现
            // document.visibilityState 仍然是 "hidden"，浏览器照样停 rendering。
            // 必须把 WebView 的【整条生命周期】都补回来：
            //   onWindowVisibilityChanged → 让 WebView 知道窗口又可见了
            //   onResume + resumeTimers  → 恢复 JS 定时器与渲染
            // 这三步缺一不可，之前只做 setVisibility 所以没用。
            if (web.getVisibility() != View.VISIBLE) {
                web.setVisibility(View.VISIBLE);
                diag("nudge: WebView 设为 VISIBLE");
            }
            View parent = (View) web.getParent();
            if (parent != null && parent.getVisibility() != View.VISIBLE) {
                parent.setVisibility(View.VISIBLE);
                diag("nudge: 父容器设为 VISIBLE");
            }
            // 注意：不要直接调 web.onWindowVisibilityChanged(...) ——
            // 那是 View 的 protected 方法，外部调不到（编译期就报错）。
            // 改 View 的可见性时，框架自己会走到它。
            web.onResume();
            web.resumeTimers();
            web.requestFocus();
            web.invalidate();
        } catch (Throwable t) {
            diag("nudge failed: " + t);
        }
        String js = "(function(){return JSON.stringify({"
                + "vis: document.visibilityState,"
                + "hidden: document.hidden"
                + "});})()";
        try {
            web.evaluateJavascript(js, (v) -> diag("nudge 后可见性: " + unquote(v)));
        } catch (Throwable ignored) {
        }
    }

    @SuppressWarnings("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        // 持久化存储：DSH 前端把「已读声明 / 已选工作区 / Session」放在
        // localStorage 里，这两个开关不打开就会每次重启都从零开始。
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        // ---------------------------------------------------------------
        // 这两个必须【开着】。
        //
        // 我一度把它们当成 bug 关掉，理由是「DSH 自带 width=device-width，
        // 这两个会无视它、按桌面宽度渲染」。逻辑没错，但结论反了 ——
        // 实测：关掉之后页面按手机原生宽度（375px）渲染，DSH 的桌面版布局
        // 在这么窄的宽度下撑不开，设置对话框文字被挤成竖排、控件溢出屏幕。
        //
        // 开着的话：WebView 按约 980px 的桌面宽度布局，再整页缩放进手机屏幕，
        // 页面比例完整，对话框大小刚好（用户反馈"有个版本对话框比较小、适配了设置"，
        // 就是这一版）。代价是字偏小，但可用。
        // ---------------------------------------------------------------
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setSupportZoom(false);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setTextZoom(100);

        // 手机自带的 ngrok 免费隧道会先给"浏览器型 UA"弹一个警告页，
        // 所以默认用一个自有标识来避开它（设置页里可以改成别的）。
        //
        // 试过用「系统 UA + 标记」（想同时保留 Mobile 字样），但实测会立刻
        // 被 ngrok 拦到警告页 —— 只要 UA 里有 Mozilla/Chrome 就算浏览器。
        // 所以这里维持自造标识，别改。
        String ua = Prefs.userAgent(this);
        if (!ua.isEmpty()) s.setUserAgentString(ua);

        web.setBackgroundColor(Color.parseColor("#FF0A1220"));
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        // Long-press menus break the chat surface; the sheet is opened from the bar.
        web.setLongClickable(false);
        web.setHapticFeedbackEnabled(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            web.setNestedScrollingEnabled(true);
        }

        CookieManager.getInstance().setAcceptCookie(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        }

        // ---------------------------------------------------------------
        // 让登录状态与界面选择【跨重启保留】。
        //
        // 之前每次重开 App 都要重新点「内测声明」、重选工作区，像从零开始 ——
        // 用户会以为"界面又不显示了"。原因是 WebView 的本地存储没有被持久化：
        // DSH 前端把"已读声明/已选工作区/Session"这类状态放在 localStorage 里，
        // 存储没落盘就每次都是新的。
        //
        // 这里的三个开关缺一不可：
        //   setDomStorageEnabled      —— localStorage / sessionStorage
        //   setDatabaseEnabled        —— WebSQL/IndexedDB 那一路的底层
        //   setJavaScriptCanOpenWindows —— DSH 用弹窗做 OAuth 之类的跳转
        // 另外把存储路径显式指到应用私有目录，避免走系统默认值在个别 ROM 上失效。
        // ---------------------------------------------------------------
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.KITKAT) {
            s.setDatabasePath(getDir("webview", MODE_PRIVATE).getAbsolutePath());
        }
        // 缓存策略：页面自己带 max-age 的用缓存，其余按需请求。
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
    }

    // ------------------------------------------------------------- basic auth

    /** True once the app has what the gateway asks for. */
    private boolean hasToken() {
        String token = Prefs.token(this);
        return token != null && !token.isEmpty();
    }

    // ------------------------------------------------- 渲染进程死亡后的自救

    /**
     * 造一个新的 WebView 并接好全部回调。
     *
     * 存在这个方法是为了能在渲染进程被杀之后**换一个新的**——
     * 死掉的 WebView 无法复活，只能整个替换。
     */
    private WebView createWebView() {
        WebView v = new WebView(this);
        // 父容器 webColumn 是 FrameLayout，所以必须用 FrameLayout.LayoutParams。
        //
        // 参数类型和父容器不匹配是这片代码的经典事故源：给 LinearLayout 的参数
        // （带 weight）传进 FrameLayout，weight 会被忽略、尺寸算成 0；
        // 反过来也会因为权重与 match_parent 互抢而塌成 0。
        // 表现都是「页面看着在，但点不动」，诊断日志里是 web 高度为 0。
        v.setLayoutParams(new android.widget.FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        v.setBackgroundColor(Color.parseColor("#FF0A1220"));
        web = v;                 // configureWebView / wireChrome 都作用于 this.web
        configureWebView();
        wireChrome();
        return v;
    }

    /**
     * 把死掉的 WebView 换掉。
     *
     * 死掉的 WebView 无法复活，只能整个替换；保留当前地址，重建后重新加载，
     * 用户看到的只是「闪一下又回来了」，而不是必须删后台重开。
     */
    private void rebuildWebView(String why) {
        if (rebuilding) return;          // 防重入：重建过程中又收到一次回调
        rebuilding = true;
        try {
            final WebView old = web;
            String keepUrl = null;
            try {
                keepUrl = old != null ? old.getUrl() : null;
            } catch (Throwable ignored) {
            }

            // 顺序很重要：先把旧的摘下来，再把新的放进去。
            // （给 webColumn 传 index 是为了让 emptyState 等兄弟视图的相对顺序不变。）
            if (old != null && webColumn != null) {
                webColumn.removeView(old);
            }
            WebView fresh = createWebView();
            if (webColumn != null) {
                webColumn.addView(fresh, 0);
            }
            if (old != null) {
                try {
                    old.loadUrl("about:blank");
                    old.destroy();
                } catch (Throwable ignored) {
                }
            }

            String target = Prefs.effectiveUrl(MainActivity.this);
            String url = (keepUrl != null && !keepUrl.isEmpty() && !"about:blank".equals(keepUrl))
                    ? keepUrl : target;
            diag("rebuild webview: " + why + " -> " + url);
            showToast(why + "，已自动恢复");
            if (url != null && !url.isEmpty()) {
                fresh.loadUrl(url);
            } else {
                showEmptyState();
            }
        } catch (Throwable t) {
            diag("rebuild failed: " + t);
        } finally {
            rebuilding = false;
        }
    }

    /**
     * 系统在回收内存。这里如实转告 WebView，让它自己释放能被释放的部分。
     *
     * 主动释放能显著降低"渲染进程被杀"的概率 —— 那正是卡死的源头。
     * 注意只在真的紧张时才释放（RUNNING_CRITICAL 及以上），
     * 否则频繁释放会让页面反复重建、更卡。
     */
    @Override
    public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        if (web == null) return;
        try {
            if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL) {
                diag("trim memory level=" + level + " -> freeMemory");
                web.clearCache(false);
                web.freeMemory();
            } else if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) {
                web.freeMemory();
            }
        } catch (Throwable ignored) {
        }
    }

    @Override
    public void onLowMemory() {
        super.onLowMemory();
        if (web != null) {
            try {
                web.freeMemory();
            } catch (Throwable ignored) {
            }
        }
    }

    private void wireChrome() {
        web.setWebViewClient(new WebViewClient() {
            /**
             * 渲染进程被系统回收时的自救。
             *
             * 这是「放一会就卡死、必须删后台重来」的根因：Android 内存紧张时会杀掉
             * WebView 的渲染进程。Activity 本身还活着，但那个 WebView 已经死了 ——
             * 界面还在（是最后画的一帧），点哪都没反应，而且【不可能】再恢复。
             *
             * 不实现这个方法的话系统会直接把 App 一起崩掉或留个死界面；
             * 实现了就能当场重建 WebView，用户几乎无感。
             *
             * 注意：返回 true 表示"我自己处理了"。旧 WebView 必须 remove + destroy，
             * 否则会泄漏，而且往死 WebView 上发指令会 crash。
             */
            @Override
            public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail detail) {
                boolean crashed = Build.VERSION.SDK_INT < Build.VERSION_CODES.O
                        || detail == null || detail.didCrash();
                diag("render process gone: crashed=" + crashed
                        + " priority=" + (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && detail != null
                        ? detail.rendererPriorityAtExit() : -1));
                rebuildWebView(crashed
                        ? "页面渲染进程崩了"
                        : "系统回收了页面内存");
                return true;
            }

            @Override
            public void onReceivedHttpAuthRequest(WebView v, HttpAuthHandler handler,
                                                  String host, String realm) {
                // The gateway challenges with Basic until it has the launch
                // token. Answer it from settings instead of making the user
                // retype the token into a system dialog.
                String token = Prefs.token(MainActivity.this);
                if (token == null || token.isEmpty()) {
                    handler.cancel();
                    showToast("网关要令牌：底栏 ⋮ → 设置，把 dsh web 打印的那串 token 填进去");
                    return;
                }
                handler.proceed("phone", token);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                return handleUrl(req.getUrl().toString());
            }

            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView v, String url) {
                return handleUrl(url);
            }

            @Override
            public void onPageStarted(WebView v, String url, android.graphics.Bitmap fav) {
                lastLoadFailed = false;
                statusText.setText(hostOf(url));
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                loadedUrl = Prefs.effectiveUrl(MainActivity.this);
                hideProgress();
                if (lastLoadFailed) return;
                emptyState.setVisibility(View.GONE);
                injectSelectGuard();
                refreshWhaleState();
                probePageHealth();
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
                if (req != null && req.isForMainFrame()) {
                    lastLoadFailed = true;
                    hideProgress();
                    showLoadFailure(err == null ? "" : String.valueOf(err.getDescription()));
                }
            }

            @Override
            @SuppressWarnings("deprecation")
            public void onReceivedError(WebView v, int code, String desc, String failingUrl) {
                if (failingUrl != null && failingUrl.equals(loadedUrl)) {
                    lastLoadFailed = true;
                    hideProgress();
                    showLoadFailure(desc);
                }
            }

            @Override
            public void onReceivedSslError(WebView v, SslErrorHandler handler,
                                           android.net.http.SslError error) {
                if (Prefs.relaxedTls(MainActivity.this)) {
                    // Only reachable because the user opted in: self-signed hosts
                    // (tunnels, private CAs) are a normal way to reach a home box.
                    handler.proceed();
                } else {
                    handler.cancel();
                    showToast("证书不受信任，已在设置里关闭「允许自签名证书」");
                }
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView v, int p) {
                if (p >= 100) {
                    hideProgress();
                } else {
                    loadingFill.setVisibility(View.VISIBLE);
                    View parent = (View) loadingFill.getParent();
                    int w = parent.getWidth();
                    ViewGroup.LayoutParams lp = loadingFill.getLayoutParams();
                    lp.width = Math.max(2, (int) (w * (p / 100f)));
                    loadingFill.setLayoutParams(lp);
                }
            }

            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb,
                                             FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                try {
                    Intent pick = params.createIntent();
                    pick.addCategory(Intent.CATEGORY_OPENABLE);
                    startActivityForResult(Intent.createChooser(pick, "选择文件"), REQ_FILE);
                    return true;
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    showToast("这台手机没有可用的文件选择器");
                    return false;
                }
            }

            @Override
            public boolean onJsAlert(WebView v, String url, String msg, JsResult res) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(msg)
                        .setPositiveButton("知道了", (d, w) -> res.confirm())
                        .setOnCancelListener(d -> res.cancel())
                        .show();
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView v, String url, String msg, JsResult res) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(msg)
                        .setPositiveButton("确定", (d, w) -> res.confirm())
                        .setNegativeButton("取消", (d, w) -> res.cancel())
                        .setOnCancelListener(d -> res.cancel())
                        .show();
                return true;
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                // 页面的 JS 报错是"白屏"最常见的根因。WebView 不会把它写进 logcat，
                // 所以自己落盘，方便 adb 取出来。
                if (m != null) {
                    String line = "[" + m.messageLevel() + "] " + m.message()
                            + "  @" + m.sourceId() + ":" + m.lineNumber();
                    diag("console " + line);
                    if (m.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                        if (consoleErrors.size() >= 8) consoleErrors.remove(0);
                        consoleErrors.add(line);
                    }
                }
                return false;   // 不消费，交回 WebView 自己的日志
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                // Mic/camera prompts from the page: grant only what the page asked for.
                request.grant(request.getResources());
            }
        });

        web.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String ua, String disposition,
                                        String mime, long len) {
                if (!url.startsWith("http://") && !url.startsWith("https://")) return;
                try {
                    String name = URLUtil.guessFileName(url, disposition, mime);
                    DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                    req.setMimeType(mime);
                    req.addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url));
                    req.addRequestHeader("User-Agent", ua);
                    req.setNotificationVisibility(
                            DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                    req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
                    DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                    if (dm != null) {
                        dm.enqueue(req);
                        showToast("已交给系统下载：" + name);
                    }
                } catch (Exception e) {
                    openExternally(url);
                }
            }
        });

        web.setOnTouchListener(new GestureDeck());
    }

    /** Keeps page-initiated navigations inside the app, punts the rest to the browser. */
    private boolean handleUrl(String url) {
        if (url == null) return false;
        if (url.startsWith("http://") || url.startsWith("https://")) return false;
        if (url.startsWith("about:") || url.startsWith("blob:") || url.startsWith("data:")) return false;
        if (url.startsWith("intent:")) {
            try {
                Intent intent = Intent.parseUri(url, Intent.URI_INTENT_SCHEME);
                startActivity(intent);
            } catch (URISyntaxException | ActivityNotFoundException e) {
                showToast("没有能打开这个链接的应用");
            }
            return true;
        }
        if (url.startsWith("mailto:") || url.startsWith("tel:") || url.startsWith("sms:")) {
            openExternally(url);
            return true;
        }
        return false;
    }

    private void openExternally(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (ActivityNotFoundException e) {
            showToast("没有能打开这个链接的应用");
        }
    }

    // ------------------------------------------------------------- navigation

    private void loadTarget(boolean force) {
        String target = Prefs.effectiveUrl(this);
        if (target.isEmpty()) {
            showEmptyState();
            return;
        }
        emptyState.setVisibility(View.GONE);
        if (force || !target.equals(loadedUrl)) {
            web.loadUrl(target);
        }
    }

    private void goBackOrHint() {
        if (web.canGoBack()) {
            web.goBack();
        } else {
            showToast("已经是最前了");
        }
    }

    private void showLoadFailure(String reason) {
        lastLoadError = reason == null ? "" : reason;
        emptyState.setVisibility(View.VISIBLE);
        TextView title = findViewById(R.id.emptyTitle);
        TextView body = findViewById(R.id.emptyBody);
        Button btn = findViewById(R.id.emptyBtn);
        title.setText("连不上");
        body.setText("地址：" + Prefs.effectiveUrl(this)
                + "\n\n原因：" + reason
                + "\n\n" + getString(R.string.fail_hint));
        btn.setText("改地址");
        btn.setOnClickListener(v -> openSettings());
    }

    private void showEmptyState() {
        emptyState.setVisibility(View.VISIBLE);
        TextView title = findViewById(R.id.emptyTitle);
        TextView body = findViewById(R.id.emptyBody);
        Button btn = findViewById(R.id.emptyBtn);
        title.setText(R.string.empty_title);
        body.setText(R.string.empty_body);
        btn.setText(R.string.empty_btn);
        btn.setOnClickListener(v -> openSettings());
    }

    private void openSettings() {
        startActivity(new Intent(this, SettingsActivity.class));
    }

    /**
     * 把页面的真实状况摆出来：分辨率、viewport、root 有没有内容、JS 报错。
     * 手机连不上远程调试，这是唯一能看清"为什么白屏"的办法。
     */
    private void showProbe() {
        probeWebViewCapability();          // 顺手测一遍浏览器能力
        probePageHealth();                 // 刷新一次页面状态

        StringBuilder errs = new StringBuilder();
        if (consoleErrors.isEmpty()) errs.append("(没有抓到 JS 报错)");
        else for (String e : consoleErrors) errs.append("· ").append(e).append("\n");

        String report = "地址：" + (loadedUrl.isEmpty() ? "(未加载)" : loadedUrl)
                + "\n\n页面状态：\n" + lastProbe
                + "\n\nJS 报错（最近 " + consoleErrors.size() + " 条）：\n" + errs
                + "\n加载错误：" + (lastLoadError.isEmpty() ? "无" : lastLoadError)
                + "\n屏幕：" + getResources().getDisplayMetrics().widthPixels + "x"
                + getResources().getDisplayMetrics().heightPixels
                + "  density=" + getResources().getDisplayMetrics().density
                + "\n\n内核能力（上一次探测）：\n" + lastCapability;
        new AlertDialog.Builder(this)
                .setTitle("页面诊断")
                .setMessage(report)
                .setPositiveButton("知道了", null)
                .setNeutralButton("重新加载", (d, w) -> {
                    consoleErrors.clear();
                    lastProbe = "(重新探测中)";
                    web.reload();
                })
                .show();
    }

    private void showMenu(View anchor) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setBackgroundResource(R.drawable.bg_card);
        int pad = dp(6);
        box.setPadding(pad, pad, pad, pad);

        PopupWindow pop = new PopupWindow(box,
                dp(190), ViewGroup.LayoutParams.WRAP_CONTENT, true);
        pop.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
        pop.setOutsideTouchable(true);
        pop.setElevation(dp(8));

        addMenuItem(box, "刷新页面", () -> {
            pop.dismiss();
            web.reload();
        });
        addMenuItem(box, whaleHidden ? "显示挂件" : "关闭挂件", () -> {
            pop.dismiss();
            toggleWhale();
        });
        addMenuItem(box, pollEnabled ? "关闭消耗提示" : "开启消耗提示", () -> {
            pop.dismiss();
            togglePoll();
        });
        addMenuItem(box, "查看页面诊断", () -> {
            pop.dismiss();
            showProbe();
        });
        addMenuItem(box, "设置", () -> {
            pop.dismiss();
            openSettings();
        });
        addMenuItem(box, "回到首页", () -> {
            pop.dismiss();
            loadTarget(true);
        });
        addMenuItem(box, "用系统浏览器打开", () -> {
            pop.dismiss();
            openExternally(Prefs.effectiveUrl(this));
        });

        pop.showAtLocation(anchor, Gravity.BOTTOM | Gravity.RIGHT, dp(10), dp(54));
    }

    private void addMenuItem(LinearLayout box, String label, Runnable action) {
        TextView tv = new TextView(this);
        tv.setText(label);
        tv.setTextColor(Color.parseColor("#FFE8F1F8"));
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        tv.setPadding(dp(14), dp(12), dp(14), dp(12));
        tv.setOnClickListener(v -> action.run());
        box.addView(tv);
    }

    // ------------------------------------------------------------------ toast

    private void showToast(String msg) {
        toastView.setText(msg);
        toastView.setVisibility(View.VISIBLE);
        toastView.animate().cancel();
        toastView.setAlpha(1f);
        toastView.postDelayed(() -> toastView.animate()
                .alpha(0f)
                .setDuration(400)
                .withEndAction(() -> toastView.setVisibility(View.GONE))
                .start(), 2600);
    }

    private void hideProgress() {
        loadingFill.setVisibility(View.GONE);
    }

    // -------------------------------------------------------------- gestures

    /**
     * Two gestures the WebView cannot express on its own:
     * edge-swipe to go back, and pull-down at the top of the page to reload.
     */
    private final class GestureDeck implements View.OnTouchListener {
        private float downX, downY;
        private boolean edgeSwipe, pullCandidate, fired;
        /** 手势过程中是否【离开过】顶部。一旦离开就不再算下拉刷新。 */
        private boolean leftTop;

        @Override
        public boolean onTouch(View v, MotionEvent e) {
            switch (e.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    downX = e.getX();
                    downY = e.getY();
                    fired = false;
                    leftTop = false;
                    edgeSwipe = downX < dp(24) && web.canGoBack();
                    pullCandidate = !web.canScrollVertically(-1);
                    return false;

                case MotionEvent.ACTION_MOVE:
                    if (fired) return false;
                    float dx = e.getX() - downX;
                    float dy = e.getY() - downY;

                    // 记录「滑动途中离开过顶部」。
                    // 这是上拉看历史被误判成刷新刷新的根因：手指往上滑时页面先滚到顶，
                    // 之后只要手指稍微回带，dy 就变正数，于是撞上下拉刷新的阈值。
                    if (pullCandidate && web.canScrollVertically(-1)) {
                        leftTop = true;
                    }

                    if (edgeSwipe && dx > dp(70) && Math.abs(dy) < dp(60)) {
                        fired = true;
                        web.goBack();
                    }
                    // 下拉刷新的判定移到 ACTION_UP —— 只有松手时仍在顶部、
                    // 且滑动足够明确，才认为是「故意下拉」。
                    // 阈值也从 110dp 提到 180dp：滑动中误触的概率大幅下降。
                    return false;

                case MotionEvent.ACTION_UP:
                    if (fired) return false;
                    float udy = e.getY() - downY;
                    float udx = e.getX() - downX;
                    if (pullCandidate && !leftTop
                            && !web.canScrollVertically(-1)
                            && udy > dp(180) && Math.abs(udx) < dp(50)) {
                        fired = true;
                        web.reload();
                        showToast("刷新中…");
                    }
                    return false;

                default:
                    return false;
            }
        }
    }

    /** Marks whether the page currently owns a text selection, so swipes wait their turn. */
    private void injectSelectGuard() {
        String js = "(function(){"
                + "if(window.__dshGuard)return;window.__dshGuard=1;"
                + "document.addEventListener('selectionchange',function(){"
                + "var s=String(document.getSelection?document.getSelection():'');"
                + "window.__dshSel=s.length>0;},true);"
                + "})();";
        web.evaluateJavascript(js, null);
    }

    // ------------------------------------------------------------- 页面诊断

    /**
     * 页面加载完后问它一句"你到底渲染出东西没有"。
     *
     * 为什么要这个：手机上没法开远程调试，而"白屏"可能是 viewport 缩得看不见、
     * JS 报错没挂载、或者根本没拿到内容 —— 从外面完全分不出来。
     * 让页面自己报告，就不用猜。顺便把 JS 报错也抓出来。
     */
    private void probePageHealth() {
        String js = "(function(){"
                + "try{"
                + "var r=document.getElementById('root');"
                + "var kids=r?r.children.length:-1;"
                + "var body=document.body?document.body.innerText:'';"
                + "body=body.replace(/\\s+/g,' ').trim();"
                + "var vp=document.querySelector('meta[name=viewport]');"
                + "var it=(typeof Iterator==='undefined')?'缺失':"
                + "((Iterator.prototype&&typeof Iterator.prototype.map==='function')?'有迭代器助手':'只有基础 Iterator');"
                + "var res=performance.getEntriesByType?performance.getEntriesByType('resource'):[];"
                + "var failed=[];"
                + "for(var i=0;i<res.length;i++){var e=res[i];"
                + "if(e.responseStatus&&e.responseStatus>=400)failed.push(e.name.slice(-60)+' -> '+e.responseStatus);}"
                + "return JSON.stringify({"
                + "title:document.title,"
                + "rootKids:kids,"
                + "bodyLen:body.length,"
                + "bodyAll:body.slice(0,600),"
                + "viewport:vp?vp.getAttribute('content'):'(无)',"
                + "innerW:window.innerWidth,"
                + "dpr:window.devicePixelRatio,"
                + "iterator:it,"
                + "ua:navigator.userAgent,"
                + "failedRes:failed.slice(0,5)"
                + "});"
                + "}catch(e){return 'probe failed: '+e.message;}"
                + "})();";
        web.evaluateJavascript(js, value -> {
            if (value == null) return;
            String txt = unquote(value);
            lastProbe = txt;
            diag("probe " + txt);
            if (txt.contains("\"rootKids\":0")) {
                showToast("页面是空的（前端没挂载上）—— 底栏 ⋮ → 查看页面诊断");
            }
        });
    }

    /**
     * 打开一个只有本 App 能访问的 data: 页面，跑一段脚本。
     *
     * 为什么不直接在 DSH 页面上跑：手机上没法开远程调试，而"页面能不能用"取决于
     * 浏览器内核支持哪些 JS 能力。在这里能干净地测出来，还能拿到 WebView 自己的版本。
     * 测完把结果贴回主 WebView 的诊断报告里。
     */
    private void probeWebViewCapability() {
        String js = "(function(){"
                + "var r={};"
                + "r.hasIterator=(typeof Iterator!=='undefined');"
                + "r.hasIteratorHelpers=(typeof Iterator!=='undefined'&&Iterator.prototype"
                + "&&typeof Iterator.prototype.map==='function');"
                + "r.hasValuesMap=(function(){try{return typeof [1].values().map==='function';}catch(e){return 'ERR '+e.message;}})();"
                + "r.hasReplaceAll=(typeof String.prototype.replaceAll==='function');"
                + "r.hasAt=(typeof Array.prototype.at==='function');"
                + "r.hasStructuredClone=(typeof structuredClone==='function');"
                + "r.ua=navigator.userAgent;"
                + "r.selfImport=(function(){try{return 'yes';}catch(e){return 'no';}})();"
                + "try{ document.title='CAP:'+JSON.stringify(r); }catch(e){}"
                + "return JSON.stringify(r);"
                + "})();";
        WebView probe = new WebView(this);
        probe.getSettings().setJavaScriptEnabled(true);
        probe.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage cm) {
                if (cm != null && consoleErrors.size() < 8) consoleErrors.add("[能力探测] " + cm.message());
                return false;
            }
        });
        probe.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView v, String url) {
                v.evaluateJavascript(js, value -> {
                    lastCapability = unquote(value);
                    diag("capability " + lastCapability);
                    v.destroy();
                });
            }
        });
        probe.loadDataWithBaseURL("https://localhost/", "<html><body>probe</body></html>",
                "text/html", "utf-8", null);
    }

    private String lastCapability = "(还没探测)";

    /** evaluateJavascript 回传的是 JSON 字符串字面量，去掉外层引号并还原转义。 */
    private static String unquote(String v) {
        if (v == null) return "";
        String t = v;
        if (t.length() >= 2 && t.startsWith("\"") && t.endsWith("\"")) {
            t = t.substring(1, t.length() - 1);
        }
        return t.replace("\\\"", "\"").replace("\\\\", "\\").replace("\\n", "\n").replace("\\r", "");
    }

    // ------------------------------------------------------------- lifecycle

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            if (fileCallback != null) {
                Uri[] result = null;
                if (resultCode == RESULT_OK && data != null) {
                    if (data.getClipData() != null) {
                        int n = data.getClipData().getItemCount();
                        result = new Uri[n];
                        for (int i = 0; i < n; i++) {
                            result[i] = data.getClipData().getItemAt(i).getUri();
                        }
                    } else if (data.getData() != null) {
                        result = new Uri[]{data.getData()};
                    }
                }
                fileCallback.onReceiveValue(result);
                fileCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        web.onPause();
        CookieManager.getInstance().flush();
    }

    // ------------------------------------------------------------------
    // 这里曾经有一段「加载看门狗 + 息屏心跳自检」的代码，已按用户反馈移除。
    //
    // 移除原因：加入它们之后，手机上变成白屏打不开；而移除前的版本
    // （14:31 那版）能正常启动使用。已知它们都会【主动把页面干掉】：
    //   · 看门狗：30 秒没加载完就调 web.reload()
    //   · 心跳自检：回前台发现心跳停了就 rebuildWebView()
    // 两者都依赖判断条件，一旦误判就会白屏 —— 与用户的症状吻合。
    // 在拿到确凿证据（比如日志里真的出现了「看门狗触发」）之前不再加回。
    // ------------------------------------------------------------------

    // （息屏心跳自检 / checkPageAlive / installHeartbeat 同样已移除，原因见上。）

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.loadUrl("about:blank");
            web.destroy();
        }
        super.onDestroy();
    }

    // ------------------------------------------------------------------ utils

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }

    private static String hostOf(String url) {
        try {
            Uri u = Uri.parse(url);
            String h = u.getHost();
            if (h == null) return url;
            return u.getPort() > 0 ? h + ":" + u.getPort() : h;
        } catch (Exception e) {
            return url;
        }
    }
}
