package com.fileshare.floating;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.inputmethod.EditorInfo;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

public class MainActivity extends Activity {
    private static final String PREFS = "fileshare_app";
    private static final String URL_KEY = "server_url";
    private static final String DEFAULT_URL = "https://file-share-app-sable.vercel.app";

    private EditText addressField;
    private WebView webView;
    private boolean waitingForOverlayPermission;
    private String pendingOverlayUrl;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.rgb(16, 11, 31));
        getWindow().setNavigationBarColor(Color.rgb(16, 11, 31));
        buildScreen();

        String savedUrl = getPreferencesStore().getString(URL_KEY, DEFAULT_URL);
        addressField.setText(savedUrl);
        loadUrl(savedUrl);
    }

    private android.content.SharedPreferences getPreferencesStore() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    private void buildScreen() {
        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setBackgroundColor(Color.rgb(16, 11, 31));
        page.setPadding(dp(16), dp(10), dp(16), dp(10));

        TextView title = new TextView(this);
        title.setText("FileShare");
        title.setTextColor(Color.rgb(241, 232, 255));
        title.setTextSize(23);
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        page.addView(title, new LinearLayout.LayoutParams(-1, -2));

        TextView subtitle = new TextView(this);
        subtitle.setText("Compartilhe arquivos e mantenha a sala à mão.");
        subtitle.setTextColor(Color.rgb(174, 158, 199));
        subtitle.setTextSize(13);
        LinearLayout.LayoutParams subtitleParams = new LinearLayout.LayoutParams(-1, -2);
        subtitleParams.bottomMargin = dp(10);
        page.addView(subtitle, subtitleParams);

        LinearLayout addressRow = new LinearLayout(this);
        addressRow.setOrientation(LinearLayout.HORIZONTAL);
        addressRow.setGravity(Gravity.CENTER_VERTICAL);

        addressField = new EditText(this);
        addressField.setSingleLine(true);
        addressField.setTextSize(14);
        addressField.setTextColor(Color.rgb(241, 232, 255));
        addressField.setHintTextColor(Color.rgb(149, 130, 179));
        addressField.setHint("Endereço do site ou servidor local");
        addressField.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        addressField.setImeOptions(EditorInfo.IME_ACTION_GO);
        addressField.setPadding(dp(12), 0, dp(8), 0);
        addressField.setBackground(roundRect(Color.rgb(27, 19, 46), Color.rgb(102, 53, 153), 12));
        addressRow.addView(addressField, new LinearLayout.LayoutParams(0, dp(48), 1f));

        Button openButton = button("Abrir", Color.rgb(89, 43, 143));
        LinearLayout.LayoutParams openParams = new LinearLayout.LayoutParams(dp(82), dp(48));
        openParams.leftMargin = dp(8);
        addressRow.addView(openButton, openParams);
        page.addView(addressRow);

        LinearLayout actionRow = new LinearLayout(this);
        actionRow.setOrientation(LinearLayout.HORIZONTAL);
        actionRow.setGravity(Gravity.CENTER_VERTICAL);
        Button floatButton = button("Flutuar", Color.rgb(151, 67, 224));
        LinearLayout.LayoutParams floatParams = new LinearLayout.LayoutParams(0, dp(46), 1f);
        floatParams.topMargin = dp(8);
        floatParams.bottomMargin = dp(10);
        actionRow.addView(floatButton, floatParams);
        page.addView(actionRow);

        webView = new WebView(this);
        WebViewSupport.configure(webView, this);
        webView.setBackgroundColor(Color.rgb(16, 11, 31));
        webView.setFocusable(true);
        webView.setFocusableInTouchMode(true);
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                FilePickerActivity.open(MainActivity.this, callback, false);
                return true;
            }
        });
        page.addView(webView, new LinearLayout.LayoutParams(-1, 0, 1f));
        setContentView(page);

        openButton.setOnClickListener(v -> openCurrentAddress());
        floatButton.setOnClickListener(v -> requestFloatingWindow());
        addressField.setOnEditorActionListener((view, actionId, event) -> {
            boolean go = actionId == EditorInfo.IME_ACTION_GO
                    || (event != null && event.getKeyCode() == KeyEvent.KEYCODE_ENTER);
            if (go) {
                openCurrentAddress();
                return true;
            }
            return false;
        });
    }

    private Button button(String label, int color) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextColor(Color.WHITE);
        button.setTextSize(14);
        button.setAllCaps(false);
        button.setTypeface(null, android.graphics.Typeface.BOLD);
        button.setPadding(dp(8), 0, dp(8), 0);
        button.setBackground(roundRect(color, color, 12));
        return button;
    }

    private GradientDrawable roundRect(int color, int strokeColor, int radiusDp) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(dp(radiusDp));
        drawable.setStroke(dp(1), strokeColor);
        return drawable;
    }

    private int dp(float value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private String normalizedAddress() {
        String url = addressField.getText().toString().trim();
        if (url.isEmpty()) return "";
        if (!url.contains("://")) url = "http://" + url;
        return url;
    }

    private void openCurrentAddress() {
        String url = normalizedAddress();
        if (!WebViewSupport.isAllowedServerUrl(url)) {
            Toast.makeText(this, "Use um endereço HTTPS ou o IP local do servidor.", Toast.LENGTH_LONG).show();
            return;
        }
        addressField.setText(url);
        getPreferencesStore().edit().putString(URL_KEY, url).apply();
        loadUrl(url);
    }

    private void loadUrl(String url) {
        if (WebViewSupport.isAllowedServerUrl(url)) {
            webView.loadUrl(url);
        } else {
            webView.loadUrl(DEFAULT_URL);
        }
    }

    private void requestFloatingWindow() {
        String url = normalizedAddress();
        if (!WebViewSupport.isAllowedServerUrl(url)) {
            Toast.makeText(this, "Informe o site ou o IP local do servidor primeiro.", Toast.LENGTH_LONG).show();
            return;
        }
        addressField.setText(url);
        getPreferencesStore().edit().putString(URL_KEY, url).apply();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(this)) {
            pendingOverlayUrl = url;
            new AlertDialog.Builder(this)
                    .setTitle("Permitir janela flutuante")
                    .setMessage("O Android precisa permitir que o FileShare apareça sobre outros aplicativos. Na próxima tela, ative “Permitir sobreposição a outros apps” e volte para cá.")
                    .setNegativeButton("Agora não", (dialog, which) -> pendingOverlayUrl = null)
                    .setPositiveButton("Continuar", (dialog, which) -> {
                        waitingForOverlayPermission = true;
                        try {
                            Intent settings = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                                    Uri.parse("package:" + getPackageName()));
                            startActivity(settings);
                        } catch (Exception error) {
                            waitingForOverlayPermission = false;
                            pendingOverlayUrl = null;
                            Toast.makeText(this, "Não foi possível abrir a permissão do Android.", Toast.LENGTH_LONG).show();
                        }
                    })
                    .show();
            return;
        }
        startFloating(url);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (!waitingForOverlayPermission) return;
        waitingForOverlayPermission = false;
        String url = pendingOverlayUrl;
        pendingOverlayUrl = null;
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(this)) {
            if (url != null) startFloating(url);
        } else {
            Toast.makeText(this, "Sem essa permissão, o Android não deixa exibir o FileShare por cima de outros apps.", Toast.LENGTH_LONG).show();
        }
    }

    private void startFloating(String url) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(this)) {
            Toast.makeText(this, "Ative a permissão de sobreposição nas configurações do Android.", Toast.LENGTH_LONG).show();
            return;
        }
        android.webkit.CookieManager.getInstance().flush();
        Intent service = new Intent(this, FloatingWindowService.class);
        service.setAction(FloatingWindowService.ACTION_SHOW);
        service.putExtra(FloatingWindowService.EXTRA_URL, url);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(service);
        else startService(service);
        moveTaskToBack(true);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
