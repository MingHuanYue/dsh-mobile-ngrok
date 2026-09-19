package com.mingyue.dsh;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Single source of truth for how this app reaches the DSH host.
 * Nothing here is hard-coded to one machine: the address is user-editable and
 * stored on the phone, so the APK works against loopback, LAN, or a tunnel.
 */
public final class Prefs {

    private static final String FILE = "dsh_prefs";
    private static final String KEY_URL = "url";
    private static final String KEY_TOKEN = "token";
    private static final String KEY_RELAXED = "relaxed_tls";
    private static final String KEY_UA = "user_agent";
    private static final String KEY_WHALE_HIDDEN = "whale_hidden";

    /**
     * 附加在浏览器标识尾部的自有标记。
     *
     * 为什么不整个替换成 "MingyueDSH"：那样会丢掉 "Mobile" 字样，
     * 服务端（包括 DSH 前端自己）可能因此判定为桌面浏览器、给出桌面版布局，
     * 在手机宽度下就会挤成一团。保留系统 UA 再挂个尾巴，两头都照顾到。
     */
    public static final String UA_TAG = "MingyueDSH";

    /** 用户没填过 UA 时用的兜底值（真正的默认值在运行时拼，见 withUaTag）。 */
    public static final String DEFAULT_UA = UA_TAG;

    private Prefs() {}

    /**
     * 把标记挂到系统 UA 后面。
     *
     * @param systemUa WebView 自己的 User-Agent（含 Mobile / Chrome 版本等信息）
     */
    public static String withUaTag(String systemUa) {
        String base = systemUa == null ? "" : systemUa.trim();
        if (base.isEmpty()) return UA_TAG;
        if (base.contains(UA_TAG)) return base;
        return base + " " + UA_TAG;
    }

    private static SharedPreferences sp(Context c) {
        return c.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    public static String url(Context c) {
        return sp(c).getString(KEY_URL, "");
    }

    public static String token(Context c) {
        return sp(c).getString(KEY_TOKEN, "");
    }

    public static boolean relaxedTls(Context c) {
        return sp(c).getBoolean(KEY_RELAXED, true);
    }

    /**
     * 鲸鱼挂件是否被用户关掉了。
     *
     * 为什么存在 App 这边：挂件自己只持久化 dshw-pos / dshw-role / dshw-last-seq，
     * 【不支持】"被隐藏"这个状态。用户明确要一个关闭入口，所以由 App 记，
     * 每次页面加载完再应用一次。
     */
    public static boolean whaleHidden(Context c) {
        return sp(c).getBoolean(KEY_WHALE_HIDDEN, false);
    }

    public static void setWhaleHidden(Context c, boolean hidden) {
        sp(c).edit().putBoolean(KEY_WHALE_HIDDEN, hidden).apply();
    }

    public static String userAgent(Context c) {
        String ua = sp(c).getString(KEY_UA, DEFAULT_UA);
        return ua == null ? "" : ua.trim();
    }

    public static void save(Context c, String url, String token, boolean relaxed, String userAgent) {
        sp(c).edit()
                .putString(KEY_URL, url == null ? "" : url.trim())
                .putString(KEY_TOKEN, token == null ? "" : token.trim())
                .putBoolean(KEY_RELAXED, relaxed)
                .putString(KEY_UA, userAgent == null ? "" : userAgent.trim())
                .apply();
    }

    public static boolean hasUrl(Context c) {
        return !url(c).isEmpty();
    }

    /**
     * Accepts what a human actually types: "192.168.1.7", "192.168.1.7:3080",
     * "http://box:3080/", and normalises it into a loadable URL.
     */
    public static String normalize(String raw) {
        if (raw == null) return "";
        String s = raw.trim();
        if (s.isEmpty()) return "";
        if (!s.matches("(?i)^[a-z][a-z0-9+.\\-]*://.*")) {
            s = "http://" + s;
        }
        return s;
    }

    /** URL with the optional token applied as a query parameter. */
    public static String effectiveUrl(Context c) {
        String base = normalize(url(c));
        if (base.isEmpty()) return "";
        String token = token(c);
        if (token.isEmpty()) return base;
        if (base.contains("token=")) return base;
        return base + (base.contains("?") ? "&" : "?") + "token=" + token;
    }
}
