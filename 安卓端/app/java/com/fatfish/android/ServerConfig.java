package com.fatfish.android;

import android.content.Context;
import android.content.SharedPreferences;

import java.net.URI;
import java.util.HashSet;
import java.util.Set;

/** Persistent server address and explicitly trusted self-signed hosts. */
public final class ServerConfig {
    private static final String PREFS = "fatfish";
    private static final String KEY_SERVER = "server_url";
    private static final String KEY_TRUSTED = "trusted_hosts";

    private ServerConfig() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static String getServer(Context context) {
        return prefs(context).getString(KEY_SERVER, "");
    }

    public static void setServer(Context context, String url) {
        prefs(context).edit().putString(KEY_SERVER, url).apply();
    }

    public static Set<String> getTrustedHosts(Context context) {
        return new HashSet<>(prefs(context).getStringSet(KEY_TRUSTED, new HashSet<String>()));
    }

    public static boolean isTrusted(Context context, String host) {
        return host != null && getTrustedHosts(context).contains(host);
    }

    public static void trustHost(Context context, String host) {
        if (host == null || host.isEmpty()) return;
        Set<String> hosts = getTrustedHosts(context);
        hosts.add(host);
        prefs(context).edit().putStringSet(KEY_TRUSTED, hosts).apply();
    }

    /** Host part of a canonical base URL, or "" when it cannot be parsed. */
    public static String hostOf(String baseUrl) {
        try {
            return new URI(baseUrl).getHost();
        } catch (Exception ignored) {
            return "";
        }
    }

    /** True when two URLs have the same scheme, host and port. */
    public static boolean sameOrigin(String a, String b) {
        try {
            URI left = new URI(a);
            URI right = new URI(b);
            int leftPort = left.getPort() >= 0 ? left.getPort() : (("https".equals(left.getScheme())) ? 443 : 80);
            int rightPort = right.getPort() >= 0 ? right.getPort() : (("https".equals(right.getScheme())) ? 443 : 80);
            return equalsNullable(left.getScheme(), right.getScheme())
                    && equalsNullable(left.getHost(), right.getHost())
                    && leftPort == rightPort;
        } catch (Exception ignored) {
            return false;
        }
    }

    private static boolean equalsNullable(String a, String b) {
        return a == null ? b == null : a.equals(b);
    }
}
