package com.fileshare.floating;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.IBinder;
import android.provider.Settings;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

public class FloatingWindowService extends Service {
    public static final String ACTION_SHOW = "com.fileshare.floating.SHOW";
    public static final String ACTION_CLOSE = "com.fileshare.floating.CLOSE";
    public static final String EXTRA_URL = "url";
    private static final String CHANNEL_ID = "fileshare_floating";
    private static final int NOTIFICATION_ID = 2041;

    private WindowManager windowManager;
    private LinearLayout panel;
    private WebView webView;
    private WindowManager.LayoutParams windowParams;
    private int screenWidth;
    private int screenHeight;
    private int initialWidth;
    private int initialHeight;
    private boolean expanded;
    private boolean viewAdded;

    @Override
    public void onCreate() {
        super.onCreate();
        windowManager = (WindowManager) getSystemService(WINDOW_SERVICE);
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_CLOSE.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }

        String url = intent == null ? null : intent.getStringExtra(EXTRA_URL);
        if (url == null || !WebViewSupport.isAllowedServerUrl(url)) {
            url = "https://file-share-app-sable.vercel.app";
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(this)) {
            stopSelf();
            return START_NOT_STICKY;
        }

        startAsForegroundService();
        if (panel == null) {
            createFloatingWindow(url);
        } else if (webView != null) {
            webView.loadUrl(url);
        }
        return START_NOT_STICKY;
    }

    private void startAsForegroundService() {
        Intent closeIntent = new Intent(this, FloatingWindowService.class);
        closeIntent.setAction(ACTION_CLOSE);
        int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent closeAction = PendingIntent.getService(this, 2042, closeIntent, pendingFlags);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        Notification notification = builder
                .setSmallIcon(android.R.drawable.ic_menu_view)
                .setContentTitle("FileShare flutuante")
                .setContentText("Toque em Fechar para encerrar a janela.")
                .setOngoing(true)
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Fechar", closeAction)
                .build();

        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, notification, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "FileShare flutuante", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Mantém a janela do FileShare ativa sobre outros aplicativos.");
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    private void createFloatingWindow(String url) {
        readScreenSize();
        float widthRatio = screenWidth > screenHeight ? 0.74f : 0.84f;
        float heightRatio = screenWidth > screenHeight ? 0.82f : 0.62f;
        initialWidth = Math.min((int) (screenWidth * widthRatio), dp(520));
        initialHeight = Math.min((int) (screenHeight * heightRatio), dp(780));
        initialWidth = Math.max(dp(280), Math.min(initialWidth, screenWidth - dp(12)));
        initialHeight = Math.max(dp(300), Math.min(initialHeight, screenHeight - dp(80)));

        panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setBackground(rounded(Color.rgb(26, 17, 45), Color.rgb(155, 73, 221), 16));
        panel.setClipToOutline(true);
        panel.setElevation(dp(14));

        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(dp(12), 0, dp(6), 0);
        header.setBackgroundColor(Color.rgb(47, 27, 74));

        TextView title = new TextView(this);
        title.setText("FileShare  •  Flutuante");
        title.setTextColor(Color.rgb(246, 239, 255));
        title.setTextSize(14);
        title.setTypeface(null, Typeface.BOLD);
        title.setSingleLine(true);
        title.setContentDescription("Arraste para mover a janela");
        header.addView(title, new LinearLayout.LayoutParams(0, dp(48), 1f));

        Button resizeButton = controlButton("⤢", "Expandir ou restaurar");
        header.addView(resizeButton, new LinearLayout.LayoutParams(dp(44), dp(42)));
        Button closeButton = controlButton("×", "Fechar janela");
        header.addView(closeButton, new LinearLayout.LayoutParams(dp(42), dp(42)));
        panel.addView(header, new LinearLayout.LayoutParams(-1, dp(48)));

        webView = new WebView(this);
        WebViewSupport.configure(webView, this);
        webView.setBackgroundColor(Color.rgb(16, 11, 31));
        webView.setFocusable(true);
        webView.setFocusableInTouchMode(true);
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<android.net.Uri[]> callback, FileChooserParams params) {
                FilePickerActivity.open(FloatingWindowService.this, callback, true);
                return true;
            }
        });
        panel.addView(webView, new LinearLayout.LayoutParams(-1, 0, 1f));

        windowParams = new WindowManager.LayoutParams(
                initialWidth,
                initialHeight,
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                        ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                        : WindowManager.LayoutParams.TYPE_PHONE,
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT);
        windowParams.gravity = Gravity.TOP | Gravity.START;
        windowParams.x = Math.max(dp(6), (screenWidth - initialWidth) / 2);
        windowParams.y = dp(80);
        windowParams.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE;

        resizeButton.setOnClickListener(v -> toggleSize());
        closeButton.setOnClickListener(v -> stopSelf());
        title.setOnTouchListener(new View.OnTouchListener() {
            private float downX;
            private float downY;
            private int startX;
            private int startY;

            @Override
            public boolean onTouch(View view, MotionEvent event) {
                if (event.getAction() == MotionEvent.ACTION_DOWN) {
                    downX = event.getRawX();
                    downY = event.getRawY();
                    startX = windowParams.x;
                    startY = windowParams.y;
                    return true;
                }
                if (event.getAction() == MotionEvent.ACTION_MOVE) {
                    windowParams.x = Math.max(0, Math.min(screenWidth - windowParams.width,
                            startX + (int) (event.getRawX() - downX)));
                    windowParams.y = Math.max(0, Math.min(screenHeight - dp(48),
                            startY + (int) (event.getRawY() - downY)));
                    try {
                        windowManager.updateViewLayout(panel, windowParams);
                    } catch (Exception ignored) {}
                    return true;
                }
                return event.getAction() == MotionEvent.ACTION_UP || event.getAction() == MotionEvent.ACTION_CANCEL;
            }
        });

        try {
            windowManager.addView(panel, windowParams);
            viewAdded = true;
            webView.loadUrl(url);
        } catch (Exception error) {
            Toast.makeText(this, "O Android não conseguiu abrir a janela flutuante.", Toast.LENGTH_LONG).show();
            stopSelf();
        }
    }

    private Button controlButton(String symbol, String description) {
        Button button = new Button(this);
        button.setText(symbol);
        button.setContentDescription(description);
        button.setTextColor(Color.rgb(246, 239, 255));
        button.setTextSize(22);
        button.setAllCaps(false);
        button.setPadding(0, 0, 0, dp(2));
        button.setBackground(rounded(Color.rgb(65, 39, 94), Color.rgb(117, 62, 161), 10));
        return button;
    }

    private void toggleSize() {
        if (panel == null || windowParams == null) return;
        expanded = !expanded;
        if (expanded) {
            windowParams.width = Math.max(dp(260), screenWidth - dp(12));
            windowParams.height = Math.max(dp(300), screenHeight - dp(80));
            windowParams.x = dp(6);
            windowParams.y = dp(30);
        } else {
            windowParams.width = initialWidth;
            windowParams.height = initialHeight;
            windowParams.x = Math.max(dp(6), (screenWidth - initialWidth) / 2);
            windowParams.y = dp(80);
        }
        try {
            windowManager.updateViewLayout(panel, windowParams);
        } catch (Exception ignored) {}
    }

    private void readScreenSize() {
        DisplayMetrics metrics = new DisplayMetrics();
        windowManager.getDefaultDisplay().getRealMetrics(metrics);
        screenWidth = metrics.widthPixels;
        screenHeight = metrics.heightPixels;
    }

    private GradientDrawable rounded(int color, int strokeColor, int radiusDp) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(dp(radiusDp));
        drawable.setStroke(dp(1), strokeColor);
        return drawable;
    }

    private int dp(float value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        if (!viewAdded || panel == null || windowParams == null) return;
        readScreenSize();
        if (expanded) {
            windowParams.width = Math.max(dp(260), screenWidth - dp(12));
            windowParams.height = Math.max(dp(300), screenHeight - dp(80));
            windowParams.x = dp(6);
            windowParams.y = dp(30);
        } else {
            float widthRatio = screenWidth > screenHeight ? 0.74f : 0.84f;
            float heightRatio = screenWidth > screenHeight ? 0.82f : 0.62f;
            initialWidth = Math.min((int) (screenWidth * widthRatio), dp(520));
            initialHeight = Math.min((int) (screenHeight * heightRatio), dp(780));
            windowParams.width = initialWidth = Math.max(dp(280), Math.min(initialWidth, screenWidth - dp(12)));
            windowParams.height = initialHeight = Math.max(dp(300), Math.min(initialHeight, screenHeight - dp(80)));
            windowParams.x = Math.max(dp(6), (screenWidth - initialWidth) / 2);
            windowParams.y = dp(80);
        }
        try {
            windowManager.updateViewLayout(panel, windowParams);
        } catch (Exception ignored) {}
    }

    @Override
    public void onDestroy() {
        if (viewAdded && panel != null) {
            try {
                windowManager.removeView(panel);
            } catch (Exception ignored) {}
        }
        viewAdded = false;
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        panel = null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
