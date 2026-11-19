package com.fatfish.android;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.URL;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.List;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLException;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * Probes a user-entered address and turns it into a canonical server origin.
 *
 * The check is deliberately more forgiving than the WebView: when a valid
 * certificate cannot be verified it retries with a permissive trust manager so
 * that the setup screen can tell the user "this server is reachable but its
 * certificate is self-signed". The user has to accept that warning before the
 * host is remembered, and only then does the WebView proceed.
 */
public final class HttpProbe {
    private HttpProbe() {}

    public static final class Result {
        public final boolean ok;
        public final String baseUrl;
        public final String version;
        public final boolean selfSigned;
        public final boolean cleartext;
        public final String error;

        private Result(boolean ok, String baseUrl, String version, boolean selfSigned, boolean cleartext, String error) {
            this.ok = ok;
            this.baseUrl = baseUrl;
            this.version = version;
            this.selfSigned = selfSigned;
            this.cleartext = cleartext;
            this.error = error;
        }

        static Result success(String baseUrl, String version, boolean selfSigned, boolean cleartext) {
            return new Result(true, baseUrl, version, selfSigned, cleartext, "");
        }

        static Result failure(String error) {
            return new Result(false, "", "", false, false, error);
        }
    }

    private static final class Attempt {
        final Result result;
        final boolean certificateError;

        Attempt(Result result, boolean certificateError) {
            this.result = result;
            this.certificateError = certificateError;
        }
    }

    public static Result probe(String raw) {
        String input = raw == null ? "" : raw.trim();
        if (input.isEmpty()) return Result.failure("请填写服务器地址。");

        List<String> candidates = new ArrayList<>();
        if (input.matches("^[a-zA-Z][a-zA-Z0-9+.-]*://.*")) {
            candidates.add(input);
        } else {
            // HTTPS is what a shared FatFish server normally serves; plain HTTP is
            // the desktop launcher's loopback mode. Try the encrypted one first.
            candidates.add("https://" + input);
            candidates.add("http://" + input);
        }

        String lastError = "无法连接服务器。";
        for (String candidate : candidates) {
            String base;
            try {
                base = canonicalBase(candidate);
            } catch (Exception ignored) {
                lastError = "地址格式不正确，例如 192.168.1.20:5000。";
                continue;
            }

            Attempt attempt = attempt(base, false);
            if (!attempt.result.ok && attempt.certificateError) {
                attempt = attempt(base, true);
                if (attempt.result.ok) {
                    return Result.success(attempt.result.baseUrl, attempt.result.version, true,
                            attempt.result.baseUrl.startsWith("http://"));
                }
            }
            if (attempt.result.ok) return attempt.result;
            lastError = attempt.result.error;
        }

        return Result.failure(lastError);
    }

    /** Normalise to scheme://host[:port]; a path in the input is ignored. */
    static String canonicalBase(String raw) throws Exception {
        URI uri = new URI(raw.trim());
        String scheme = uri.getScheme();
        String host = uri.getHost();
        if (scheme == null || host == null) throw new IllegalArgumentException("no host");
        scheme = scheme.toLowerCase();
        if (!"http".equals(scheme) && !"https".equals(scheme)) {
            throw new IllegalArgumentException("unsupported scheme");
        }
        int port = uri.getPort();
        String portPart = port > 0 ? ":" + port : "";
        return scheme + "://" + host + portPart;
    }

    private static Attempt attempt(String base, boolean permissiveTls) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(base + "/app/health");
            connection = (HttpURLConnection) url.openConnection();
            if (connection instanceof HttpsURLConnection && permissiveTls) {
                HttpsURLConnection https = (HttpsURLConnection) connection;
                https.setSSLSocketFactory(permissiveSocketFactory());
                https.setHostnameVerifier(permissiveHostnameVerifier());
            }
            connection.setConnectTimeout(4500);
            connection.setReadTimeout(5000);
            connection.setRequestMethod("GET");
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("User-Agent", "FatFish-Android/" + AppInfo.VERSION);
            connection.setInstanceFollowRedirects(false);

            int code = connection.getResponseCode();
            if (code != 200) {
                return new Attempt(Result.failure("服务器返回 HTTP " + code + "，请确认地址和端口。"), false);
            }

            String body = readLimited(connection.getInputStream(), 64 * 1024);
            JSONObject json = new JSONObject(body);
            String status = json.optString("status", "");
            if (!"ok".equals(status)) {
                return new Attempt(Result.failure("这不是 FatFish 服务端（health 状态异常）。"), false);
            }
            if (!json.optBoolean("ui_bundled", false)) {
                return new Attempt(Result.failure("服务端已启动，但没有构建网页界面。请在服务端执行桌面端构建后再试。"), false);
            }
            String version = json.optString("version", "unknown");
            return new Attempt(Result.success(base, version, false, base.startsWith("http://")), false);
        } catch (Exception error) {
            String message = friendlyMessage(error);
            return new Attempt(Result.failure(message), looksLikeCertificateError(error));
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static String readLimited(java.io.InputStream input, int limit) throws IOException {
        BufferedInputStream stream = new BufferedInputStream(input);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int total = 0;
        int read;
        while ((read = stream.read(buffer)) != -1) {
            total += read;
            if (total > limit) throw new IOException("服务器响应过大");
            out.write(buffer, 0, read);
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    private static boolean looksLikeCertificateError(Throwable error) {
        Throwable cursor = error;
        while (cursor != null) {
            if (cursor instanceof SSLException) return true;
            String name = cursor.getClass().getName();
            if (name.contains("CertPath") || name.contains("Certificate")) return true;
            cursor = cursor.getCause();
        }
        return false;
    }

    private static String friendlyMessage(Throwable error) {
        Throwable cursor = error;
        while (cursor != null) {
            if (cursor instanceof UnknownHostException) {
                return "找不到这台主机。请检查 IP 地址，确认手机和电脑在同一个局域网。";
            }
            if (cursor instanceof ConnectException) {
                return "连接被拒绝。服务端可能没有启动，或者防火墙没有放行这个端口。";
            }
            if (cursor instanceof SocketTimeoutException) {
                return "连接超时。请确认服务端正在运行、手机和电脑在同一网络。";
            }
            if (cursor instanceof SSLException) {
                return "HTTPS 证书校验失败，而且自签名连接也没有成功。";
            }
            cursor = cursor.getCause();
        }
        String message = error.getMessage();
        return message == null || message.isEmpty() ? "无法连接服务器。" : message;
    }

    private static SSLSocketFactory permissiveSocketFactory() throws Exception {
        TrustManager[] managers = new TrustManager[]{
                new X509TrustManager() {
                    @Override
                    public void checkClientTrusted(X509Certificate[] chain, String authType) {}

                    @Override
                    public void checkServerTrusted(X509Certificate[] chain, String authType) {}

                    @Override
                    public X509Certificate[] getAcceptedIssuers() {
                        return new X509Certificate[0];
                    }
                }
        };
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, managers, new SecureRandom());
        return context.getSocketFactory();
    }

    private static HostnameVerifier permissiveHostnameVerifier() {
        return (hostname, session) -> true;
    }
}
