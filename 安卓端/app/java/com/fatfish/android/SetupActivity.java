package com.fatfish.android;

import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.text.InputType;
import android.view.View;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * First-run / switch-server screen.
 *
 * It deliberately does not trust a URL because it looks plausible: the address
 * is probed through /app/health before it is saved, and a self-signed HTTPS
 * certificate is surfaced to the user as a decision, not silently accepted.
 */
public class SetupActivity extends android.app.Activity {
    public static final String EXTRA_CURRENT = "current_server";

    private EditText serverInput;
    private Button connectButton;
    private ProgressBar progress;
    private TextView statusText;
    private TextView lastServerText;
    private ExecutorService executor;
    private boolean probing;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_setup);
        getWindow().setStatusBarColor(getColor(R.color.bg_root));
        getWindow().setNavigationBarColor(getColor(R.color.bg_root));
        getWindow().getDecorView().setSystemUiVisibility(0);

        executor = Executors.newSingleThreadExecutor();
        serverInput = findViewById(R.id.server_input);
        connectButton = findViewById(R.id.connect_button);
        progress = findViewById(R.id.setup_progress);
        statusText = findViewById(R.id.status_text);
        lastServerText = findViewById(R.id.last_server);

        String current = getIntent().getStringExtra(EXTRA_CURRENT);
        if (current == null) current = ServerConfig.getServer(this);
        if (current != null && !current.isEmpty()) {
            serverInput.setText(current);
            serverInput.setSelection(serverInput.length());
        }

        String stored = ServerConfig.getServer(this);
        if (!stored.isEmpty()) {
            lastServerText.setVisibility(View.VISIBLE);
            lastServerText.setText("上次连接：" + stored + "（点此填入）");
            lastServerText.setOnClickListener(v -> {
                serverInput.setText(stored);
                serverInput.setSelection(serverInput.length());
            });
        }

        connectButton.setOnClickListener(v -> startProbe());
        findViewById(R.id.help_button).setOnClickListener(v -> showHelp());
        serverInput.setOnEditorActionListener((v, actionId, event) -> {
            startProbe();
            return true;
        });
        serverInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        serverInput.setSingleLine(true);
    }

    private void showHelp() {
        new AlertDialog.Builder(this)
                .setTitle("怎么连接")
                .setMessage("1. 在电脑上启动 FatFish，并选择「服务端模式」，让它监听局域网。\n\n"
                        + "2. 记下电脑的局域网 IP（例如 192.168.1.20）和端口（默认 5000）。\n\n"
                        + "3. 手机和电脑连同一个 Wi-Fi，在这里填 192.168.1.20:5000。\n\n"
                        + "4. 如果电脑的防火墙拦截了连接，请放行 FatFish 使用的端口。\n\n"
                        + "如果电脑已开启 FatFish 1.4.1 的「远程访问（Tailscale）」，手机需要先安装并登录"
                        + "官方 Tailscale App，然后在这里填电脑的 tailnet 地址（例如 fatfish:80 或 "
                        + "http://100.x.x.x:80）。FatFish 安卓端本身不内置 Tailscale。\n\n"
                        + "手机只是客户端；账号、聊天记录和文件仍然保存在电脑上。")
                .setPositiveButton("知道了", null)
                .show();
    }

    private void startProbe() {
        if (probing) return;
        String input = serverInput.getText().toString().trim();
        if (input.isEmpty()) {
            setStatus("请先填写服务器地址。", true);
            serverInput.requestFocus();
            return;
        }

        hideKeyboard();
        probing = true;
        connectButton.setEnabled(false);
        connectButton.setText("连接中…");
        progress.setVisibility(View.VISIBLE);
        setStatus("正在检查服务器…", false);

        executor.execute(() -> {
            HttpProbe.Result result = HttpProbe.probe(input);
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                probing = false;
                connectButton.setEnabled(true);
                connectButton.setText("连接");
                progress.setVisibility(View.GONE);
                handleResult(result);
            });
        });
    }

    private void handleResult(HttpProbe.Result result) {
        if (!result.ok) {
            setStatus(result.error, true);
            return;
        }

        String host = ServerConfig.hostOf(result.baseUrl);
        if (result.selfSigned && !ServerConfig.isTrusted(this, host)) {
            new AlertDialog.Builder(this)
                    .setTitle("服务器证书不受信任")
                    .setMessage("这台服务器使用的是自签名 HTTPS 证书，系统无法自动验证它。\n\n"
                            + "仅当你确认 " + host + " 就是自己局域网里的 FatFish 服务器时，才继续。"
                            + "继续后，这个地址会被记住。")
                    .setPositiveButton("我信任，继续", (dialog, which) -> {
                        ServerConfig.trustHost(this, host);
                        commit(result);
                    })
                    .setNegativeButton("取消", (dialog, which) -> setStatus("已取消连接。", true))
                    .setOnCancelListener(dialog -> setStatus("已取消连接。", true))
                    .show();
            return;
        }

        commit(result);
    }

    private void commit(HttpProbe.Result result) {
        ServerConfig.setServer(this, result.baseUrl);
        if (result.selfSigned) ServerConfig.trustHost(this, ServerConfig.hostOf(result.baseUrl));
        String note = result.cleartext ? "（HTTP 明文，仅建议在可信局域网使用）" : "";
        Toast.makeText(this, "已连接 FatFish " + result.version + note, Toast.LENGTH_LONG).show();
        setStatus("已连接 FatFish " + result.version + "，正在进入…", false);
        Intent data = new Intent();
        data.putExtra("server_url", result.baseUrl);
        setResult(RESULT_OK, data);
        finish();
    }

    private void setStatus(String text, boolean error) {
        statusText.setVisibility(View.VISIBLE);
        statusText.setText(text);
        statusText.setTextColor(error ? getColor(R.color.danger) : getColor(R.color.accent));
    }

    private void hideKeyboard() {
        View focused = getCurrentFocus();
        if (focused == null) return;
        InputMethodManager manager = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (manager != null) manager.hideSoftInputFromWindow(focused.getWindowToken(), 0);
        focused.clearFocus();
    }

    @Override
    protected void onDestroy() {
        if (executor != null) executor.shutdownNow();
        super.onDestroy();
    }
}
