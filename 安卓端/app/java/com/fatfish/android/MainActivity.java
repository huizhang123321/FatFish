package com.fatfish.android;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Log;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
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
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * The Android client shell.
 *
 * FatFish keeps every byte of its data on the machine running the Flask
 * server, so the phone is a first-class *client*, not a second data store. The
 * shell's job is therefore narrow and security-sensitive: pick a server, keep
 * the WebView on that origin, and give the web application the native pieces a
 * browser cannot (file chooser, microphone permission, downloads, back).
 */
public class MainActivity extends Activity {
    private static final String TAG = "FatFish";
    private static final int REQ_SETUP = 1001;
    private static final int REQ_FILE = 1002;
    private static final int REQ_MEDIA_PERMISSION = 1003;
    private static final int REQ_DOWNLOAD_PERMISSION = 1004;

    private WebView webView;
    private ProgressBar progress;
    private View offlineView;
    private TextView offlineTitle;
    private TextView offlineDetail;
    private String baseUrl = "";

    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest pendingPermission;
    private DownloadSpec pendingDownload;
    private long lastBackAt = 0;
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    private static final String BRIDGE_JS =
            "(function(){" +
            "if(window.fatfishAndroid){return;}" +
            "window.fatfishAndroid={" +
            "isAndroid:true," +
            "version:'" + AppInfo.VERSION + "'," +
            "getServerUrl:function(){return FatFishNative.serverUrl();}," +
            "switchServer:function(){FatFishNative.switchServer();}," +
            "setSystemTheme:function(t){FatFishNative.setSystemTheme(t);}," +
            "openExternal:function(u){FatFishNative.openExternal(u);}" +
            "};" +
            "})();";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        webView = findViewById(R.id.webview);
        progress = findViewById(R.id.page_progress);
        offlineView = findViewById(R.id.offline_view);
        offlineTitle = findViewById(R.id.offline_title);
        offlineDetail = findViewById(R.id.offline_detail);

        if (savedInstanceState != null) {
            String saved = savedInstanceState.getString("base_url");
            if (saved != null && !saved.isEmpty()) baseUrl = saved;
        }

        configureWebView();
        findViewById(R.id.retry_button).setOnClickListener(v -> onRetry());
        findViewById(R.id.switch_button).setOnClickListener(v -> openSetup());

        if (baseUrl.isEmpty()) baseUrl = ServerConfig.getServer(this);
        if (baseUrl.isEmpty()) openSetup(); else loadApp();
    }

    private void onRetry() {
        loadApp();
    }

    private void configureWebView() {
        WebView.setWebContentsDebuggingEnabled(false);
        webView.setBackgroundColor(Color.BLACK);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setUserAgentString(settings.getUserAgentString() + AppInfo.USER_AGENT_SUFFIX);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, false);

        webView.addJavascriptInterface(new NativeBridge(), "FatFishNative");
        webView.setWebViewClient(new ShellClient());
        webView.setWebChromeClient(new ShellChromeClient());
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            if (url == null || url.isEmpty()) return;
            if (!ServerConfig.sameOrigin(url, baseUrl)) {
                openExternal(url);
                return;
            }
            String name = URLUtil.guessFileName(url, contentDisposition, mimeType);
            String cookie = CookieManager.getInstance().getCookie(url);
            requestDownload(new DownloadSpec(url, name, mimeType, cookie));
        });
    }

    private void loadApp() {
        if (baseUrl.isEmpty()) {
            openSetup();
            return;
        }
        offlineView.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
        progress.setVisibility(View.VISIBLE);
        injectBridge();
        webView.loadUrl(baseUrl + "/app/");
    }

    private void openSetup() {
        Intent intent = new Intent(this, SetupActivity.class);
        intent.putExtra(SetupActivity.EXTRA_CURRENT, ServerConfig.getServer(this));
        startActivityForResult(intent, REQ_SETUP);
    }

    private void injectBridge() {
        webView.evaluateJavascript(BRIDGE_JS, null);
    }

    private void showOffline(String detail) {
        progress.setVisibility(View.GONE);
        offlineView.setVisibility(View.VISIBLE);
        webView.setVisibility(View.GONE);
        offlineTitle.setText(R.string.offline_title);
        offlineDetail.setText(detail == null || detail.isEmpty()
                ? "请确认电脑上的 FatFish 服务端已经启动，手机和电脑在同一个局域网。" : detail);
        Button retry = findViewById(R.id.retry_button);
        retry.setText(R.string.retry);
        Button switchButton = findViewById(R.id.switch_button);
        switchButton.setText(R.string.switch_server);
    }

    private void applyTheme(String theme) {
        boolean light = "light".equals(theme);
        int background = getColor(light ? R.color.bg_light : R.color.bg_root);
        getWindow().setStatusBarColor(background);
        getWindow().setNavigationBarColor(background);
        View decor = getWindow().getDecorView();
        int flags = decor.getSystemUiVisibility();
        if (light) {
            flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (Build.VERSION.SDK_INT >= 26) flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        } else {
            flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        }
        decor.setSystemUiVisibility(flags);
    }

    private boolean handleUrl(String url) {
        if (url == null) return true;
        if (url.startsWith("http://") || url.startsWith("https://")) {
            if (ServerConfig.sameOrigin(url, baseUrl)) return false;
            openExternal(url);
            return true;
        }
        if (url.startsWith("mailto:") || url.startsWith("tel:")) {
            openExternal(url);
            return true;
        }
        if (url.startsWith("intent:")) {
            try {
                Intent intent = Intent.parseUri(url, Intent.URI_INTENT_SCHEME);
                startActivity(intent);
            } catch (Exception ignored) {
                Toast.makeText(this, "无法打开这个链接", Toast.LENGTH_SHORT).show();
            }
            return true;
        }
        return true;
    }

    private void openExternal(String url) {
        if (url == null) return;
        try {
            Intent intent;
            if (url.startsWith("mailto:") || url.startsWith("tel:")) {
                intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            } else if (url.startsWith("http://") || url.startsWith("https://")) {
                intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            } else {
                return;
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (Exception ignored) {
            Toast.makeText(this, "没有可以打开这个链接的应用", Toast.LENGTH_SHORT).show();
        }
    }

    private final class ShellClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return handleUrl(request.getUrl().toString());
        }

        @Override
        @SuppressWarnings("deprecation")
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return handleUrl(url);
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            super.onPageStarted(view, url, favicon);
            progress.setVisibility(View.VISIBLE);
            injectBridge();
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            progress.setVisibility(View.GONE);
            offlineView.setVisibility(View.GONE);
            webView.setVisibility(View.VISIBLE);
            injectBridge();
            CookieManager.getInstance().flush();
            view.evaluateJavascript(
                    "(function(){try{return document.documentElement.getAttribute('data-theme')||'dark';}catch(e){return 'dark';}})()",
                    value -> {
                        String theme = value == null ? "dark" : value.replace("\"", "");
                        applyTheme(theme);
                    });
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            super.onReceivedError(view, request, error);
            if (request.isForMainFrame()) {
                showOffline("连接中断：" + (error.getDescription() == null ? "网络错误" : error.getDescription()));
            }
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, android.net.http.SslError error) {
            String host = error.getUrl() == null ? ServerConfig.hostOf(baseUrl) : Uri.parse(error.getUrl()).getHost();
            if (ServerConfig.isTrusted(MainActivity.this, host)) {
                handler.proceed();
                return;
            }
            new AlertDialog.Builder(MainActivity.this)
                    .setTitle("HTTPS 证书不受信任")
                    .setMessage("服务器 " + host + " 使用自签名证书。仅当你信任这台局域网服务器时才继续。")
                    .setPositiveButton("继续", (dialog, which) -> {
                        ServerConfig.trustHost(MainActivity.this, host);
                        handler.proceed();
                    })
                    .setNegativeButton("取消", (dialog, which) -> {
                        handler.cancel();
                        showOffline("HTTPS 证书未获信任，已停止连接。你可以切换到其他服务器，或确认证书后重试。");
                    })
                    .setOnCancelListener(dialog -> {
                        handler.cancel();
                        showOffline("HTTPS 证书未获信任，已停止连接。");
                    })
                    .show();
        }
    }

    private final class ShellChromeClient extends WebChromeClient {
        @Override
        public void onProgressChanged(WebView view, int newProgress) {
            progress.setProgress(newProgress);
            progress.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                         FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            try {
                Intent intent = params.createIntent();
                if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                }
                startActivityForResult(Intent.createChooser(intent, "选择文件"), REQ_FILE);
                return true;
            } catch (Exception error) {
                fileCallback = null;
                callback.onReceiveValue(null);
                Toast.makeText(MainActivity.this, "没有可用的文件选择器", Toast.LENGTH_SHORT).show();
                return false;
            }
        }

        @Override
        public void onPermissionRequest(final PermissionRequest request) {
            runOnUiThread(() -> grantMediaPermission(request));
        }
    }

    private void grantMediaPermission(PermissionRequest request) {
        if (request == null) return;
        List<String> missing = new ArrayList<>();
        for (String resource : request.getResources()) {
            String permission = permissionFor(resource);
            if (permission != null && checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) {
                if (!missing.contains(permission)) missing.add(permission);
            }
        }
        if (missing.isEmpty()) {
            request.grant(request.getResources());
            return;
        }
        if (pendingPermission != null) {
            pendingPermission.deny();
        }
        pendingPermission = request;
        requestPermissions(missing.toArray(new String[0]), REQ_MEDIA_PERMISSION);
    }

    private String permissionFor(String resource) {
        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) return android.Manifest.permission.RECORD_AUDIO;
        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) return android.Manifest.permission.CAMERA;
        return null;
    }

    private boolean pendingPermissionSatisfied() {
        if (pendingPermission == null) return false;
        for (String resource : pendingPermission.getResources()) {
            String permission = permissionFor(resource);
            if (permission != null && checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) {
                return false;
            }
        }
        return true;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_MEDIA_PERMISSION) {
            if (pendingPermission != null) {
                if (pendingPermissionSatisfied()) pendingPermission.grant(pendingPermission.getResources());
                else {
                    pendingPermission.deny();
                    Toast.makeText(this, "需要麦克风或相机权限才能发送语音/拍照", Toast.LENGTH_LONG).show();
                }
                pendingPermission = null;
            }
        } else if (requestCode == REQ_DOWNLOAD_PERMISSION) {
            DownloadSpec spec = pendingDownload;
            pendingDownload = null;
            if (spec != null) {
                boolean granted = grantResults.length > 0
                        && grantResults[0] == PackageManager.PERMISSION_GRANTED;
                if (!granted) {
                    Toast.makeText(this, "未授予存储权限，文件将保存到应用专用目录", Toast.LENGTH_LONG).show();
                }
                download(spec, granted);
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_SETUP) {
            if (resultCode == RESULT_OK) {
                String next = ServerConfig.getServer(this);
                if (!next.isEmpty() && !next.equals(baseUrl)) {
                    baseUrl = next;
                    webView.clearHistory();
                    webView.clearCache(false);
                }
                if (baseUrl.isEmpty()) openSetup(); else loadApp();
            } else if (baseUrl.isEmpty()) {
                finish();
            }
        } else if (requestCode == REQ_FILE) {
            Uri[] result = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
            if (fileCallback != null) fileCallback.onReceiveValue(result);
            fileCallback = null;
        }
    }

    @Override
    public void onBackPressed() {
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        webView.evaluateJavascript(
                "(function(){try{return !!(window.fatfishAndroidBack&&window.fatfishAndroidBack());}catch(e){return false;}})()",
                value -> {
                    if ("true".equals(value)) return;
                    // The web app handles its own screens first; only after that
                    // does WebView history (an opened image, for example) matter.
                    if (webView.canGoBack()) {
                        webView.goBack();
                        return;
                    }
                    long now = System.currentTimeMillis();
                    if (now - lastBackAt < 2000) {
                        moveTaskToBack(true);
                    } else {
                        lastBackAt = now;
                        Toast.makeText(MainActivity.this, "再按一次返回键退出 FatFish", Toast.LENGTH_SHORT).show();
                    }
                });
    }

    private void requestDownload(DownloadSpec spec) {
        if (Build.VERSION.SDK_INT < 29
                && checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED) {
            pendingDownload = spec;
            requestPermissions(new String[]{android.Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_DOWNLOAD_PERMISSION);
            return;
        }
        download(spec, true);
    }

    private void download(DownloadSpec spec, boolean publicDownload) {
        Toast.makeText(this, "开始下载 " + spec.name, Toast.LENGTH_SHORT).show();
        io.execute(() -> {
            HttpURLConnection connection = null;
            try {
                URL url = new URL(spec.url);
                connection = (HttpURLConnection) url.openConnection();
                if (connection instanceof HttpsURLConnection
                        && ServerConfig.isTrusted(this, url.getHost())) {
                    HttpsURLConnection https = (HttpsURLConnection) connection;
                    https.setSSLSocketFactory(trustAllContext().getSocketFactory());
                    https.setHostnameVerifier(trustAllHosts());
                }
                connection.setConnectTimeout(8000);
                connection.setReadTimeout(20000);
                connection.setRequestProperty("User-Agent", "FatFish-Android/" + AppInfo.VERSION);
                if (spec.cookie != null && !spec.cookie.isEmpty()) {
                    connection.setRequestProperty("Cookie", spec.cookie);
                }
                int code = connection.getResponseCode();
                if (code != 200) throw new IOException("HTTP " + code);
                String finalName = safeFileName(spec.name);
                String saved = publicDownload
                        ? savePublic(connection.getInputStream(), finalName, spec.mime)
                        : saveAppPrivate(connection.getInputStream(), finalName);
                runOnUiThread(() -> Toast.makeText(this, "已保存：" + saved, Toast.LENGTH_LONG).show());
            } catch (Exception error) {
                Log.w(TAG, "download failed", error);
                runOnUiThread(() -> Toast.makeText(this, "下载失败：" + error.getMessage(), Toast.LENGTH_LONG).show());
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    private String savePublic(InputStream input, String name, String mime) throws IOException {
        if (Build.VERSION.SDK_INT >= 29) {
            ContentResolver resolver = getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            values.put(MediaStore.MediaColumns.MIME_TYPE, mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/FatFish");
            values.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new IOException("无法创建下载文件");
            try (OutputStream out = resolver.openOutputStream(uri)) {
                if (out == null) throw new IOException("无法写入下载目录");
                copy(input, out);
            } catch (IOException error) {
                resolver.delete(uri, null, null);
                throw error;
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.MediaColumns.IS_PENDING, 0);
            resolver.update(uri, done, null, null);
            return "下载/FatFish/" + name;
        }

        File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "FatFish");
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("无法创建下载目录");
        File target = uniqueFile(dir, name);
        try (OutputStream out = new FileOutputStream(target)) {
            copy(input, out);
        }
        MediaScannerConnectionCompat.scan(this, target);
        return target.getAbsolutePath();
    }

    private String saveAppPrivate(InputStream input, String name) throws IOException {
        File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (dir == null) dir = getFilesDir();
        File target = uniqueFile(dir, name);
        try (OutputStream out = new FileOutputStream(target)) {
            copy(input, out);
        }
        return target.getAbsolutePath();
    }

    private static void copy(InputStream input, OutputStream output) throws IOException {
        BufferedInputStream buffered = new BufferedInputStream(input);
        byte[] buffer = new byte[64 * 1024];
        int read;
        while ((read = buffered.read(buffer)) != -1) output.write(buffer, 0, read);
        output.flush();
    }

    private static File uniqueFile(File dir, String name) {
        File candidate = new File(dir, name);
        if (!candidate.exists()) return candidate;
        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name;
        String suffix = dot > 0 ? name.substring(dot) : "";
        for (int i = 1; i < 1000; i++) {
            candidate = new File(dir, stem + " (" + i + ")" + suffix);
            if (!candidate.exists()) return candidate;
        }
        return new File(dir, System.currentTimeMillis() + "-" + name);
    }

    private static String safeFileName(String name) {
        if (name == null || name.isEmpty()) return "fatfish-download";
        return name.replaceAll("[\\\\/:*?\"<>|]", "_");
    }

    private static SSLContext trustAllContext() throws Exception {
        TrustManager[] managers = new TrustManager[]{
                new X509TrustManager() {
                    @Override
                    public void checkClientTrusted(X509Certificate[] chain, String authType) {}
                    @Override
                    public void checkServerTrusted(X509Certificate[] chain, String authType) {}
                    @Override
                    public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
                }
        };
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, managers, new SecureRandom());
        return context;
    }

    private static HostnameVerifier trustAllHosts() {
        return (hostname, session) -> true;
    }

    /** Small MediaScanner wrapper so the old-API path stays readable. */
    private static final class MediaScannerConnectionCompat {
        static void scan(MainActivity activity, File file) {
            try {
                android.media.MediaScannerConnection.scanFile(
                        activity, new String[]{file.getAbsolutePath()}, null, null);
            } catch (Exception ignored) {}
        }
    }

    private static final class DownloadSpec {
        final String url;
        final String name;
        final String mime;
        final String cookie;

        DownloadSpec(String url, String name, String mime, String cookie) {
            this.url = url;
            this.name = name;
            this.mime = mime;
            this.cookie = cookie;
        }
    }

    private final class NativeBridge {
        @JavascriptInterface
        public String version() {
            return AppInfo.VERSION;
        }

        @JavascriptInterface
        public String serverUrl() {
            return baseUrl;
        }

        @JavascriptInterface
        public void switchServer() {
            runOnUiThread(MainActivity.this::openSetup);
        }

        @JavascriptInterface
        public void setSystemTheme(String theme) {
            runOnUiThread(() -> applyTheme(theme));
        }

        @JavascriptInterface
        public void openExternal(String url) {
            runOnUiThread(() -> MainActivity.this.openExternal(url));
        }

        @JavascriptInterface
        public void toast(String message) {
            runOnUiThread(() -> Toast.makeText(MainActivity.this, message, Toast.LENGTH_SHORT).show());
        }
    }

    @Override
    protected void onPause() {
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        outState.putString("base_url", baseUrl);
        super.onSaveInstanceState(outState);
    }

    @Override
    protected void onDestroy() {
        io.shutdownNow();
        if (webView != null) {
            webView.loadUrl("about:blank");
            webView.removeAllViews();
            webView.destroy();
        }
        super.onDestroy();
    }
}
