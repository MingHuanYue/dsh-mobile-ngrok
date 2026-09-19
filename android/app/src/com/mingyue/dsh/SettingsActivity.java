package com.mingyue.dsh;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Bundle;
import android.text.TextUtils;
import android.util.Base64;
import android.view.View;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Where the phone learns how to reach the host. Everything is editable and
 * nothing is assumed about the machine on the other end, so the same APK works
 * on loopback, on a LAN, or through a tunnel.
 */
public class SettingsActivity extends Activity {

    private EditText inputUrl;
    private EditText inputToken;
    private EditText inputUa;
    private CheckBox checkRelaxed;
    private TextView testResult;
    private TextView helpText;
    private TextView aboutText;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_settings);

        inputUrl = findViewById(R.id.inputUrl);
        inputToken = findViewById(R.id.inputToken);
        inputUa = findViewById(R.id.inputUa);
        checkRelaxed = findViewById(R.id.checkRelaxed);
        testResult = findViewById(R.id.testResult);
        helpText = findViewById(R.id.helpText);
        aboutText = findViewById(R.id.aboutText);

        inputUrl.setText(Prefs.url(this));
        inputToken.setText(Prefs.token(this));
        inputUa.setText(Prefs.userAgent(this));
        checkRelaxed.setChecked(Prefs.relaxedTls(this));

        findViewById(R.id.btnSave).setOnClickListener(v -> save(true));
        findViewById(R.id.btnTest).setOnClickListener(v -> test());
        findViewById(R.id.btnClose).setOnClickListener(v -> finish());
        findViewById(R.id.btnCopyHint).setOnClickListener(v -> copyHint());
        findViewById(R.id.btnPasteToken).setOnClickListener(v -> pasteToken());

        helpText.setText(hostSideHelp());
        aboutText.setText(about());
    }

    private void save(boolean closeAfter) {
        String raw = inputUrl.getText().toString();
        String normalized = Prefs.normalize(raw);
        inputUrl.setText(normalized);
        String ua = inputUa.getText().toString().trim();
        if (ua.isEmpty()) ua = Prefs.DEFAULT_UA;
        inputUa.setText(ua);
        Prefs.save(this, normalized, inputToken.getText().toString(),
                checkRelaxed.isChecked(), ua);
        toast("已保存");
        if (closeAfter) finish();
    }

    private void test() {
        save(false);
        String target = Prefs.effectiveUrl(this);
        if (target.isEmpty()) {
            toast("先把地址填上");
            return;
        }
        testResult.setVisibility(View.VISIBLE);
        testResult.setText("正在探测 " + target + " …");

        new Thread(() -> {
            final String report = probe(target);
            runOnUiThread(() -> {
                testResult.setText(report);
                testResult.setTextColor(report.startsWith("通了")
                        ? 0xFF7FE8A8 : 0xFFE8A87F);
            });
        }).start();
    }

    /** Plain HTTP GET so the answer is about reachability, not about TLS quirks. */
    private String probe(String target) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(target);
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(6000);
            conn.setReadTimeout(6000);
            conn.setInstanceFollowRedirects(false);
            conn.setRequestProperty("User-Agent", Prefs.userAgent(this));
            // The gateway takes the token as Basic; present it up front so the
            // probe tests the same path the WebView will use.
            String token = Prefs.token(this);
            if (!token.isEmpty()) {
                String raw = "phone:" + token;
                conn.setRequestProperty("Authorization", "Basic "
                        + Base64.encodeToString(raw.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP));
            }
            int code = conn.getResponseCode();
            if (code == 200 || code == 304) {
                return "通了（HTTP " + code + "）。回主界面就能看到会话。";
            }
            if (code == 303 || code == 302) {
                return "通了，网关在做跳转（HTTP " + code + "）。回主界面看看。";
            }
            if (code == 401) {
                return token.isEmpty()
                        ? "网关在，但它要令牌。把 dsh web 打印的 token 填到上面的令牌框里再测。"
                        : "网关在，令牌被拒了。确认电脑上的 DSH 没重启过——重启会换新令牌，"
                          + "要去控制台重新复制一次。";
            }
            if (code == 403) {
                return "网关放行了，但 DSH 自己拒绝了（HTTP 403）。"
                        + "多半是网关版本对不上，把电脑上的 手机网关.cmd 用同目录这份重跑一次。";
            }
            if (code == 502) {
                return "网关活着，但 DSH 没应答（HTTP 502）。电脑上的 Start-DSH.cmd 还开着吗？";
            }
            return "服务器回应了 HTTP " + code + "，地址大概率是对的。";
        } catch (javax.net.ssl.SSLHandshakeException e) {
            return "TLS 握手失败：" + e.getMessage()
                    + "\n如果是自签名证书，勾上下面那个『允许自签名证书』再试。";
        } catch (java.net.SocketTimeoutException e) {
            return "超时。电脑没回应——确认两个 cmd 都在跑，防火墙放行了网关端口。";
        } catch (java.net.ConnectException e) {
            return "连不上这个地址端口。确认电脑和你同网段，且 启动网关.cmd 正在运行。";
        } catch (Exception e) {
            return "探测失败：" + e.getClass().getSimpleName() + " " + e.getMessage();
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private String hostSideHelp() {
        String ip = localIpv4();
        StringBuilder sb = new StringBuilder();
        sb.append("电脑上要跑的东西，按需要选一种：\n\n");

        sb.append("【情况一】手机和电脑在同一个网络（都连同一个 WiFi）\n");
        sb.append("  1. Start-DSH.cmd —— DSH 本体，只听 127.0.0.1");
        sb.append("（它故意不开放到网络，因为那等于把整台电脑交出去）；\n");
        sb.append("  2. 启动网关.cmd —— 面向局域网的唯一入口。\n");
        sb.append("  地址填电脑的局域网 IP，例如 ").append(sameSubnetHint(ip)).append(":3081。\n\n");

        sb.append("【情况二】手机走流量、电脑走校园网/公司网（两台设备根本不在同一个网络）\n");
        sb.append("  这种情况局域网地址永远连不通，必须用隧道：\n");
        sb.append("  1. Start-DSH.cmd\n");
        sb.append("  2. 启动网关.cmd\n");
        sb.append("  3. 启动隧道.cmd —— 它会把网关变成一 https://xxx.ngrok-free.app 网址，\n");
        sb.append("     把这个网址整个填进「电脑地址」（要带 https://）。\n");
        sb.append("  隧道走公网，手机用流量反而更顺。\n\n");

        sb.append("启动 DSH 时控制台会打印一行带 token= 的地址，把那一串 token 粘到上面");
        sb.append("（点「从剪贴板粘贴令牌」按钮最省事）。\n\n");

        sb.append("端口说明：网关是 3081，DSH 自己是 3080 —— 填 3080 是最常见的错误。");
        return sb.toString();
    }

    private String about() {
        StringBuilder sb = new StringBuilder();
        sb.append("溟月 · DSH 手机端  v").append(BuildConfig.VERSION_NAME).append("\n");
        sb.append("build ").append(BuildConfig.BUILD_STAMP).append("\n\n");
        sb.append("它本身不包含任何智能——只是一个忠实的窗口，把电脑上那个 DSH 搬到手机上。\n");
        sb.append("所以电脑上的会话、文件、工具、记忆，手机上看到的是同一份。\n\n");
        sb.append("手势：\n· 左边缘右滑返回\n· 页面顶部下拉刷新\n· 底栏 ⋮ 打开菜单\n· 长按 WebView 无用（故意关掉，免得打断输入）\n\n");
        sb.append("手机：").append(Build.MANUFACTURER).append(" ").append(Build.MODEL)
          .append(" / Android ").append(Build.VERSION.RELEASE)
          .append(" (API ").append(Build.VERSION.SDK_INT).append(")");
        return sb.toString();
    }

    private void copyHint() {
        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm == null) return;
        cm.setPrimaryClip(ClipData.newPlainText("dsh", "启动网关.cmd"));
        toast("已复制");
    }

    /**
     * Pull the token out of the clipboard. Copying the whole startup line (or
     * the whole URL) is what people actually do, so accept that too instead of
     * demanding a bare token.
     */
    private void pasteToken() {
        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm == null || !cm.hasPrimaryClip()) {
            toast("剪贴板是空的——先在电脑上选中 token 再复制");
            return;
        }
        ClipData clip = cm.getPrimaryClip();
        if (clip == null || clip.getItemCount() == 0) {
            toast("剪贴板里没有文字");
            return;
        }
        CharSequence text;
        try {
            text = clip.getItemAt(0).coerceToText(this);
        } catch (Exception e) {
            toast("读剪贴板失败：" + e.getClass().getSimpleName());
            return;
        }
        if (text == null) {
            toast("剪贴板里没有文字");
            return;
        }

        String raw = text.toString().trim();
        if (raw.isEmpty()) {
            toast("剪贴板是空的");
            return;
        }

        // Unwrap a full URL or a "dsh web: http://...?token=..." line if that
        // is what got copied; otherwise take the text as the token itself.
        String token = raw;
        Matcher m = Pattern.compile("[?&]token=([^&\\s]+)").matcher(raw);
        if (m.find()) {
            token = m.group(1);
        } else {
            int at = raw.indexOf("token=");
            if (at >= 0) token = raw.substring(at + 6).trim();
        }
        token = token.replaceAll("[\\s\"'<>]", "");

        inputToken.setText(token);
        inputToken.setSelection(token.length());
        toast("已粘贴令牌（" + token.length() + " 位）");
    }

    private String localIpv4() {
        // Prefer the WiFi link address, fall back to any non-loopback IPv4.
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                for (Network n : cm.getAllNetworks()) {
                    LinkProperties lp = cm.getLinkProperties(n);
                    if (lp == null) continue;
                    for (android.net.LinkAddress la : lp.getLinkAddresses()) {
                        InetAddress a = la.getAddress();
                        if (a instanceof Inet4Address && !a.isLoopbackAddress()) {
                            return a.getHostAddress();
                        }
                    }
                }
            }
        } catch (Exception ignored) {
        }
        try {
            List<NetworkInterface> ifaces = Collections.list(NetworkInterface.getNetworkInterfaces());
            for (NetworkInterface ni : ifaces) {
                if (ni.isLoopback() || !ni.isUp()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (a instanceof Inet4Address && !a.isLoopbackAddress()) {
                        return a.getHostAddress();
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return "未知";
    }

    /** Turn "192.168.1.77" into "192.168.1.x" so the placeholder is obviously a placeholder. */
    private String sameSubnetHint(String ip) {
        if (ip == null || TextUtils.isEmpty(ip) || "未知".equals(ip)) return "192.168.1.100";
        int dot = ip.lastIndexOf('.');
        if (dot < 0) return ip;
        return ip.substring(0, dot + 1) + "100";
    }

    private void toast(String s) {
        Toast.makeText(this, s, Toast.LENGTH_SHORT).show();
    }
}
