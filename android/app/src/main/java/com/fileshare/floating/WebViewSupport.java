package com.fileshare.floating;

import android.app.DownloadManager;
import android.content.Context;
import android.net.Uri;
import android.os.Environment;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.SslErrorHandler;
import android.webkit.URLUtil;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.widget.Toast;
import android.content.Intent;
import android.net.http.SslError;

final class WebViewSupport {
    private WebViewSupport() {}

    static void configure(WebView webView, Context context) {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleNavigation(context, request.getUrl().toString(), request.isForMainFrame());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleNavigation(context, url, true);
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
            }
        });

        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) ->
                download(context, url, contentDisposition, mimeType));
    }

    static boolean isAllowedServerUrl(String raw) {
        try {
            Uri uri = Uri.parse(raw.trim());
            String scheme = uri.getScheme();
            String host = uri.getHost();
            if (host == null || uri.getUserInfo() != null) return false;
            if ("https".equalsIgnoreCase(scheme)) return true;
            if (!"http".equalsIgnoreCase(scheme)) return false;

            String normalizedHost = host.toLowerCase();
            if ("localhost".equals(normalizedHost) || normalizedHost.endsWith(".local")) return true;
            return isPrivateIpv4(normalizedHost);
        } catch (Exception ignored) {
            return false;
        }
    }

    private static boolean isPrivateIpv4(String host) {
        String[] parts = host.split("[.]");
        if (parts.length != 4) return false;
        int[] octets = new int[4];
        try {
            for (int i = 0; i < 4; i++) {
                if (parts[i].isEmpty() || parts[i].length() > 3) return false;
                octets[i] = Integer.parseInt(parts[i]);
                if (octets[i] < 0 || octets[i] > 255) return false;
            }
        } catch (NumberFormatException ignored) {
            return false;
        }
        return octets[0] == 10
                || (octets[0] == 192 && octets[1] == 168)
                || (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31)
                || octets[0] == 127
                || (octets[0] == 169 && octets[1] == 254);
    }

    private static boolean handleNavigation(Context context, String raw, boolean mainFrame) {
        Uri uri = Uri.parse(raw);
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
        if ("https".equals(scheme) || "http".equals(scheme)) {
            return mainFrame && !isAllowedServerUrl(raw);
        }
        if ("blob".equals(scheme) || "data".equals(scheme) || "about".equals(scheme) || scheme.isEmpty()) {
            return false;
        }
        if (mainFrame && ("mailto".equals(scheme) || "tel".equals(scheme))) {
            try {
                context.startActivity(new Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (Exception ignored) {
                Toast.makeText(context, "Não há um aplicativo para abrir este link.", Toast.LENGTH_SHORT).show();
            }
            return true;
        }
        return mainFrame;
    }

    private static void download(Context context, String url, String disposition, String mimeType) {
        if (!isAllowedServerUrl(url)) {
            Toast.makeText(context, "Este endereço de download não é permitido.", Toast.LENGTH_SHORT).show();
            return;
        }
        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            String fileName = URLUtil.guessFileName(url, disposition, mimeType);
            request.setTitle(fileName);
            request.setDescription("Baixando pelo FileShare");
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
            if (mimeType != null) request.setMimeType(mimeType);
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null && !cookie.isEmpty()) request.addRequestHeader("Cookie", cookie);
            request.addRequestHeader("User-Agent", System.getProperty("http.agent", "FileShare Android"));
            DownloadManager manager = (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
            if (manager != null) {
                manager.enqueue(request);
                Toast.makeText(context, "Download iniciado. Confira a pasta Downloads.", Toast.LENGTH_SHORT).show();
            }
        } catch (Exception error) {
            Toast.makeText(context, "Não foi possível iniciar o download.", Toast.LENGTH_LONG).show();
        }
    }
}
