package com.castv.receiver;

import android.app.Activity;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;

import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Enumeration;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    private static final int DISCOVERY_PORT = 43118;
    private static final int DEFAULT_HTTP_PORT = 43117;

    private final ExecutorService discoveryExecutor = Executors.newSingleThreadExecutor();
    private volatile boolean discoveryRunning;
    private WebView receiverWebView;
    private TextView statusText;
    private EditText manualHost;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setStatusBarColor(Color.rgb(8, 25, 35));
        getWindow().setNavigationBarColor(Color.rgb(8, 25, 35));
        setContentView(R.layout.activity_main);

        receiverWebView = findViewById(R.id.receiverWebView);
        statusText = findViewById(R.id.statusText);
        manualHost = findViewById(R.id.manualHost);
        Button searchButton = findViewById(R.id.searchButton);
        Button manualConnectButton = findViewById(R.id.manualConnectButton);

        configureWebView();
        searchButton.setOnClickListener(view -> discoverSender());
        manualConnectButton.setOnClickListener(view -> connectManual());

        discoverSender();
    }

    private void configureWebView() {
        WebSettings settings = receiverWebView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        receiverWebView.setBackgroundColor(Color.BLACK);
        receiverWebView.setWebChromeClient(new WebChromeClient());
        receiverWebView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                runOnUiThread(() -> statusText.setText("Receiver siap · menunggu sender"));
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request != null && request.isForMainFrame()) {
                    runOnUiThread(() -> statusText.setText("Gagal membuka receiver. Coba manual IP."));
                }
            }
        });
    }

    private void discoverSender() {
        if (discoveryRunning) return;
        discoveryRunning = true;
        runOnUiThread(() -> statusText.setText("Mencari CastV di Wi-Fi…"));

        discoveryExecutor.execute(() -> {
            try (DatagramSocket socket = new DatagramSocket()) {
                socket.setBroadcast(true);
                socket.setSoTimeout(3500);
                byte[] request = "CASTV_DISCOVER".getBytes(StandardCharsets.UTF_8);

                sendDiscovery(socket, request, InetAddress.getByName("255.255.255.255"));
                String subnetBroadcast = getSubnetBroadcast();
                if (subnetBroadcast != null) {
                    sendDiscovery(socket, request, InetAddress.getByName(subnetBroadcast));
                }

                long deadline = System.currentTimeMillis() + 3500;
                byte[] buffer = new byte[2048];
                while (System.currentTimeMillis() < deadline) {
                    DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
                    socket.receive(packet);
                    JSONObject response = new JSONObject(new String(packet.getData(), packet.getOffset(), packet.getLength(), StandardCharsets.UTF_8));
                    if (!"castv-server".equals(response.optString("type"))) continue;
                    String host = response.optString("host", packet.getAddress().getHostAddress());
                    int port = response.optInt("httpPort", DEFAULT_HTTP_PORT);
                    runOnUiThread(() -> loadReceiver(host, port, true));
                    return;
                }
            } catch (Exception ignored) {
                // Manual IP remains available when broadcast is blocked by the Wi-Fi network.
            } finally {
                discoveryRunning = false;
                runOnUiThread(() -> {
                    if (receiverWebView.getUrl() == null) {
                        statusText.setText("Belum ditemukan. Gunakan PC IP untuk hubungkan manual.");
                    }
                });
            }
        });
    }

    private void sendDiscovery(DatagramSocket socket, byte[] request, InetAddress address) {
        try {
            socket.send(new DatagramPacket(request, request.length, address, DISCOVERY_PORT));
        } catch (Exception ignored) {
            // A directed broadcast may be unavailable on some routers.
        }
    }

    private String getSubnetBroadcast() {
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            while (interfaces != null && interfaces.hasMoreElements()) {
                NetworkInterface networkInterface = interfaces.nextElement();
                Enumeration<InetAddress> addresses = networkInterface.getInetAddresses();
                while (addresses.hasMoreElements()) {
                    InetAddress address = addresses.nextElement();
                    if (!(address instanceof Inet4Address) || address.isLoopbackAddress()) continue;
                    String ip = address.getHostAddress();
                    int lastDot = ip.lastIndexOf('.');
                    if (lastDot > 0) return ip.substring(0, lastDot + 1) + "255";
                }
            }
        } catch (Exception ignored) {
            // The global broadcast below is still attempted.
        }
        return null;
    }

    private void connectManual() {
        String value = manualHost.getText().toString().trim();
        if (value.isEmpty()) {
            statusText.setText("Masukkan IP PC sender terlebih dahulu.");
            return;
        }
        try {
            String normalized = value.startsWith("http") ? value : "http://" + value;
            URI uri = URI.create(normalized);
            int port = uri.getPort() > 0 ? uri.getPort() : DEFAULT_HTTP_PORT;
            loadReceiver(uri.getHost(), port, false);
        } catch (Exception error) {
            statusText.setText("Format IP tidak valid.");
        }
    }

    private void loadReceiver(String host, int port, boolean discovered) {
        String deviceName = (Build.MANUFACTURER + " " + Build.MODEL).trim() + " · Android TV";
        try {
            String encodedName = URLEncoder.encode(deviceName, StandardCharsets.UTF_8.name());
            String url = "http://" + host + ":" + port + "/receiver.html?native=1&name=" + encodedName;
            statusText.setText(discovered ? "CastV ditemukan · membuka receiver" : "Membuka receiver manual…");
            receiverWebView.loadUrl(url);
        } catch (Exception error) {
            statusText.setText("Tidak bisa membuat URL receiver.");
        }
    }

    @Override
    public void onBackPressed() {
        if (receiverWebView != null && receiverWebView.canGoBack()) receiverWebView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        discoveryExecutor.shutdownNow();
        if (receiverWebView != null) {
            receiverWebView.stopLoading();
            receiverWebView.destroy();
        }
        super.onDestroy();
    }
}
