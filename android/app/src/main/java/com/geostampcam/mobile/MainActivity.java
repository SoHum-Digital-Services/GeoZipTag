package com.geostampcam.mobile;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.location.Address;
import android.location.Geocoder;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.media.ExifInterface;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.window.OnBackInvokedDispatcher;
import android.widget.FrameLayout;
import android.widget.Toast;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.PublicKey;
import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONException;
import org.json.JSONObject;

public final class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String HOME = "https://" + HOST + "/index.html";
    // Signed web updates are published here by the GitHub Pages workflow (see tools/ota/README.md).
    private static final String OTA_URL = "https://sohum-digital-services.github.io/GeoZipTag/ota/";
    private static final long OTA_CHECK_INTERVAL = 30 * 60 * 1000L;
    private static final int CAMERA_ACCESS = 1, LOCATION_ACCESS = 2, PICKER_CAMERA_ACCESS = 3;
    private static final int CHOOSE_IMAGE = 4, SAVE_DOCUMENT = 5, PHONE_LOCATION_ACCESS = 6, STORAGE_ACCESS = 7,
            NATIVE_CAMERA_ACCESS = 8;
    private static final int PHONE_WITHOUT_LOCATION = 1, PHONE_WITH_LOCATION = 2;
    private static final long MAX_FIX_AGE = 60_000;
    private static final int MAX_PAYLOAD = 28 * 1024 * 1024;
    private static final String CSP = "default-src 'none'; script-src 'self'; style-src 'self'; "
            + "img-src 'self' blob: data:; media-src 'self' blob:; font-src 'self'; manifest-src 'self'; "
            + "connect-src 'self' blob: https://photon.komoot.io https://nominatim.openstreetmap.org https://*.arcgis.com; "
            + "frame-src 'none'; base-uri 'none'; form-action 'self'";
    private final ExecutorService storage = Executors.newSingleThreadExecutor();
    private final ExecutorService lookups = Executors.newSingleThreadExecutor();
    private WebView cameraView;
    private WebView reportView;
    private PermissionRequest cameraPermission;
    private GeolocationPermissions.Callback locationPermission;
    private String locationOrigin;
    private ValueCallback<Uri[]> pickerCallback;
    private Uri capturedImage;
    private File capturedFile;
    private volatile int nextPhoneMode;
    private int phoneMode;
    private LocationManager phoneLocationManager;
    private Location phoneFix;
    private boolean waitingForPhoneFix;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Runnable openAfterLocation = this::openPhoneAfterLocation;
    private final LocationListener phoneListener = new LocationListener() {
        @Override public void onLocationChanged(Location location) {
            updatePhoneFix(location);
            if (isFresh(phoneFix, System.currentTimeMillis())) openPhoneAfterLocation();
        }
        @Override public void onProviderEnabled(String provider) {}
        @Override public void onProviderDisabled(String provider) {}
        @Override public void onStatusChanged(String provider, int status, Bundle extras) {}
    };
    private byte[] pendingDocument;
    private final ArrayList<Object[]> pendingLegacySaves = new ArrayList<>();
    // Where this session's photos went in the gallery (API 29+), so the photo view can delete them again.
    private final Map<String, Uri> savedPhotos = new ConcurrentHashMap<>();
    private boolean storageRequested, savedOnce;
    private Toast saveToast;
    private AlertDialog exitDialog;
    private final ExecutorService updates = Executors.newSingleThreadExecutor();
    private OtaUpdater ota;
    private volatile File otaRoot;   // update served to the current page (null = the files bundled in the APK)
    private long lastOtaCheck;
    private String appVersionName = "";
    // The phone's own camera (preview behind the page), its last photos for the page, and volume-key capture.
    private NativeCamera nativeCamera;
    private final java.util.LinkedHashMap<String, byte[]> nativePhotos = new java.util.LinkedHashMap<>();
    private String pendingCameraFacing;
    private volatile boolean volumeShutter;
    private String bundledWebLabel = "bundled";

    @Override public void onCreate(Bundle savedState) {
        super.onCreate(savedState);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xff000000);
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                android.graphics.Insets bars = insets.getInsets(android.view.WindowInsets.Type.systemBars()
                        | android.view.WindowInsets.Type.displayCutout());
                android.graphics.Insets keyboard = insets.getInsets(android.view.WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, keyboard.bottom));
                return insets;
            });
        }
        nativeCamera = new NativeCamera(this, new NativeCamera.Listener() {
            @Override public void onState(JSONObject state) {
                callPage("window.onNativeCamera && window.onNativeCamera(" + state + ")");
            }
            @Override public void onPhoto(String id, byte[] jpeg) {
                if (jpeg != null) {
                    synchronized (nativePhotos) {
                        nativePhotos.put(id, jpeg);
                        while (nativePhotos.size() > 3) nativePhotos.remove(nativePhotos.keySet().iterator().next());
                    }
                }
                callPage("window.onNativePhoto && window.onNativePhoto(" + JSONObject.quote(id) + "," + (jpeg != null) + ")");
            }
        });
        root.addView(nativeCamera.view, new FrameLayout.LayoutParams(-1, -1));
        cameraView = new WebView(this);
        root.addView(cameraView, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
        configureCameraView();
        initOta();
        cameraView.loadUrl(HOME);
        // The first check waits until the page is up, so it compares against the files actually running.
        lastOtaCheck = System.currentTimeMillis();
        mainHandler.postDelayed(() -> {
            lastOtaCheck = 0;
            runOtaCheck(false);
        }, 3000);
        if (Build.VERSION.SDK_INT >= 33) {
            // Android 16 apps no longer receive onBackPressed(); the back gesture goes through this callback.
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        }
        storage.execute(this::removeExpiredCache);
    }

    private void configureCameraView() {
        WebSettings settings = cameraView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setGeolocationEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(false);
        cameraView.setBackgroundColor(0x00000000);   // see-through where the page shows the camera preview
        cameraView.addJavascriptInterface(new AndroidHost(), "AndroidHost");
        cameraView.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (!isLocal(url)) return null;
                return asset(url);
            }

            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (isLocal(request.getUrl())) return false;
                if (request.isForMainFrame() && request.hasGesture()
                        && "https".equals(request.getUrl().getScheme())) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl())); }
                    catch (ActivityNotFoundException ignored) { notifyUser("No browser is available."); }
                }
                return true;
            }
        });
        cameraView.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    boolean video = false;
                    for (String resource : request.getResources()) {
                        video |= PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource);
                    }
                    if (!video || !isLocal(request.getOrigin()) || cameraPermission != null) {
                        request.deny();
                    } else if (hasCameraPermission()) {
                        request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                    } else {
                        cameraPermission = request;
                        requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_ACCESS);
                    }
                });
            }

            @Override public void onPermissionRequestCanceled(PermissionRequest request) {
                if (cameraPermission == request) cameraPermission = null;
            }

            @Override public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                if (!isLocal(Uri.parse(origin)) || locationPermission != null) {
                    callback.invoke(origin, false, false);
                } else if (hasLocationPermission()) {
                    callback.invoke(origin, true, false);
                } else {
                    locationOrigin = origin;
                    locationPermission = callback;
                    requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION,
                            Manifest.permission.ACCESS_COARSE_LOCATION}, LOCATION_ACCESS);
                }
            }

            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                    FileChooserParams params) {
                if (pickerCallback != null) {
                    callback.onReceiveValue(null);
                    return true;
                }
                pickerCallback = callback;
                phoneMode = nextPhoneMode;
                nextPhoneMode = 0;
                if (params.isCaptureEnabled() || phoneMode != 0) {
                    if (hasCameraPermission()) preparePhoneLocation();
                    else requestPermissions(new String[]{Manifest.permission.CAMERA}, PICKER_CAMERA_ACCESS);
                } else {
                    openImagePicker();
                }
                return true;
            }
        });
    }

    private static boolean isLocal(Uri url) {
        return url != null && "https".equals(url.getScheme()) && HOST.equals(url.getHost())
                && (url.getPort() == -1 || url.getPort() == 443);
    }

    private WebResourceResponse asset(Uri url) {
        String path = url.getPath();
        if (path == null || path.equals("/")) path = "/index.html";
        if (path.startsWith("/native-photo/") && path.endsWith(".jpg")) {
            byte[] photo;
            synchronized (nativePhotos) { photo = nativePhotos.get(path.substring(14, path.length() - 4)); }
            if (photo != null) return new WebResourceResponse("image/jpeg", null, new ByteArrayInputStream(photo));
        }
        // Only these app files are served; anything else gets a local 404.
        if (OtaUpdater.isWebPath(path)) {
            String mime = assetType(path);
            try {
                Map<String, String> headers = new HashMap<>();
                headers.put("Content-Security-Policy", CSP);
                headers.put("X-Content-Type-Options", "nosniff");
                return new WebResourceResponse(mime, "UTF-8", 200, "OK", headers, openWebFile(path));
            } catch (IOException ignored) {
                // Return a local 404 so the WebView never loads remote app code.
            }
        }
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", null,
                new ByteArrayInputStream("Not found".getBytes(StandardCharsets.UTF_8)));
    }

    private static String assetType(String path) {
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".txt")) return "text/plain";
        if (path.endsWith(".svg")) return "image/svg+xml";
        if (path.endsWith(".woff2")) return "font/woff2";
        if (path.endsWith(".jpg")) return "image/jpeg";
        if (path.endsWith(".png")) return "image/png";
        if (path.endsWith(".webmanifest")) return "application/manifest+json";
        return "text/javascript";
    }

    private InputStream openWebFile(String path) throws IOException {
        OtaUpdater updater = ota;
        if (updater != null) {
            // A new page load picks the bundle (a staged update is promoted here); its files then stay consistent.
            if (path.equals("/index.html")) otaRoot = updater.servingRoot();
            File root = otaRoot;
            if (root != null) {
                File file = new File(root, path.substring(1));
                if (file.isFile()) return new FileInputStream(file);
            }
        }
        return getAssets().open("web" + path);
    }

    private String readAssetText(String name) throws IOException {
        return new String(OtaUpdater.readAll(getAssets().open(name), 64 * 1024), StandardCharsets.UTF_8);
    }

    private void initOta() {
        try {
            PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
            appVersionName = info.versionName == null ? "" : info.versionName;
            long code = Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
            String[] bundled = readAssetText("ota-version.txt").split("\\s+");
            long bundledVersion = Long.parseLong(bundled[0]);
            bundledWebLabel = bundled.length > 1 ? bundled[1] : "bundled";
            PublicKey key = OtaUpdater.parseKey(readAssetText("ota-public-key.b64"));
            ota = new OtaUpdater(new File(getFilesDir(), "ota"), path -> getAssets().open("web/" + path),
                    new OtaUpdater.HttpsFetcher(OTA_URL), key, code, bundledVersion, bundledWebLabel);
        } catch (Exception error) {
            ota = null;   // no updates in this build; the bundled web files keep working
        }
    }

    // Looks for a signed web update in the background; a downloaded one applies on the next page load.
    private void runOtaCheck(boolean manual) {
        OtaUpdater updater = ota;
        if (updater == null || isFinishing() || isDestroyed()) {
            if (manual) sendOtaStatus("error", "Updates are not available in this build.");
            return;
        }
        long now = System.currentTimeMillis();
        if (!manual && now - lastOtaCheck < OTA_CHECK_INTERVAL) return;
        lastOtaCheck = now;
        if (manual) sendOtaStatus("checking", "");
        updates.execute(() -> {
            OtaUpdater.Result result = updater.check();
            if (manual || "ready".equals(result.state)) sendOtaStatus(result.state, result.detail);
        });
    }

    private void sendOtaStatus(String state, String detail) {
        String script = "window.onOtaStatus && window.onOtaStatus(" + JSONObject.quote(state) + "," + JSONObject.quote(detail) + ")";
        runOnUiThread(() -> {
            if (!isFinishing() && !isDestroyed()) cameraView.evaluateJavascript(script, null);
        });
    }

    private boolean hasCameraPermission() {
        return checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasLocationPermission() {
        return checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code == CAMERA_ACCESS && cameraPermission != null) {
            PermissionRequest pending = cameraPermission;
            cameraPermission = null;
            if (hasCameraPermission()) pending.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
            else pending.deny();
        } else if (code == LOCATION_ACCESS && locationPermission != null) {
            locationPermission.invoke(locationOrigin, hasLocationPermission(), false);
            locationPermission = null;
            locationOrigin = null;
        } else if (code == PICKER_CAMERA_ACCESS && pickerCallback != null) {
            if (hasCameraPermission()) preparePhoneLocation();
            else openImagePicker();
        } else if (code == PHONE_LOCATION_ACCESS && pickerCallback != null) {
            beginPhoneLocation();
        } else if (code == NATIVE_CAMERA_ACCESS) {
            String facing = pendingCameraFacing;
            pendingCameraFacing = null;
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) nativeCamera.start(facing);
            else callPage("window.onNativeCamera && window.onNativeCamera({\"ok\":false,\"error\":\"denied\"})");
        } else if (code == STORAGE_ACCESS) {
            storageRequested = false;
            boolean granted = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
            ArrayList<Object[]> queue;
            synchronized (pendingLegacySaves) {
                queue = new ArrayList<>(pendingLegacySaves);
                pendingLegacySaves.clear();
            }
            if (granted) {
                storage.execute(() -> {
                    for (Object[] item : queue) {
                        try { saveLegacy((String) item[0], (byte[]) item[1]); }
                        catch (IOException | SecurityException error) { notifyUser("Could not save the photo."); }
                    }
                });
            } else if (!queue.isEmpty()) {
                Object[] last = queue.get(queue.size() - 1);
                notifyUser("Allow storage access to save photos automatically.");
                createPhotoDocument((String) last[0], (byte[]) last[1]);
            }
        }
    }

    private void preparePhoneLocation() {
        if (phoneMode != PHONE_WITH_LOCATION) {
            openDeviceCamera();
        } else if (!hasLocationPermission()) {
            requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION}, PHONE_LOCATION_ACCESS);
        } else {
            beginPhoneLocation();
        }
    }

    private void beginPhoneLocation() {
        if (!hasLocationPermission()) {
            openDeviceCamera();
            return;
        }
        phoneLocationManager = (LocationManager) getSystemService(LOCATION_SERVICE);
        if (phoneLocationManager == null) {
            openDeviceCamera();
            return;
        }
        boolean listening = false;
        for (String provider : new String[]{LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER}) {
            try {
                if (!phoneLocationManager.isProviderEnabled(provider)) continue;
                updatePhoneFix(phoneLocationManager.getLastKnownLocation(provider));
                phoneLocationManager.requestLocationUpdates(provider, 1000, 0, phoneListener,
                        Looper.getMainLooper());
                listening = true;
            } catch (SecurityException | IllegalArgumentException ignored) {
                // A coarse-only permission can leave GPS unavailable.
            }
        }
        if (listening && !isFresh(phoneFix, System.currentTimeMillis())) {
            waitingForPhoneFix = true;
            mainHandler.postDelayed(openAfterLocation, 2200);
        } else {
            openDeviceCamera();
        }
    }

    private void updatePhoneFix(Location candidate) {
        if (candidate == null) return;
        if (phoneFix == null || candidate.getTime() > phoneFix.getTime()
                || (candidate.getTime() == phoneFix.getTime() && candidate.getAccuracy() < phoneFix.getAccuracy())) {
            phoneFix = candidate;
        }
    }

    private static boolean isFresh(Location location, long time) {
        return location != null && Math.abs(time - location.getTime()) <= MAX_FIX_AGE;
    }

    private void openPhoneAfterLocation() {
        if (!waitingForPhoneFix) return;
        waitingForPhoneFix = false;
        mainHandler.removeCallbacks(openAfterLocation);
        if (pickerCallback != null && !isFinishing()) openDeviceCamera();
    }

    private void stopPhoneLocation() {
        waitingForPhoneFix = false;
        mainHandler.removeCallbacks(openAfterLocation);
        if (phoneLocationManager != null) {
            try { phoneLocationManager.removeUpdates(phoneListener); }
            catch (SecurityException ignored) {}
        }
        phoneLocationManager = null;
    }

    private void openDeviceCamera() {
        String filename = "capture-" + UUID.randomUUID() + ".jpg";
        File file = new File(CacheImageProvider.folder(this, "captured"), filename);
        try {
            if (!file.createNewFile()) throw new IOException("Capture already exists");
            capturedFile = file;
            capturedImage = CacheImageProvider.uriFor("captured", filename);
            Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            intent.putExtra(MediaStore.EXTRA_OUTPUT, capturedImage);
            intent.setClipData(ClipData.newRawUri("Photo", capturedImage));
            intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivityForResult(intent, CHOOSE_IMAGE);
        } catch (IOException | ActivityNotFoundException | SecurityException error) {
            capturedImage = null;
            capturedFile = null;
            file.delete();
            openImagePicker();
        }
    }

    private void openImagePicker() {
        stopPhoneLocation();
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType("image/*");
        try { startActivityForResult(intent, CHOOSE_IMAGE); }
        catch (ActivityNotFoundException error) {
            completePhonePicker(null);
            notifyUser("No image picker is available.");
        }
    }

    private void finishImagePicker(Uri image) {
        stopPhoneLocation();
        phoneMode = 0;
        phoneFix = null;
        if (pickerCallback != null) pickerCallback.onReceiveValue(image == null ? null : new Uri[]{image});
        pickerCallback = null;
        capturedImage = null;
        if (image == null && capturedFile != null) capturedFile.delete();
        capturedFile = null;
    }

    @Override protected void onActivityResult(int request, int outcome, Intent data) {
        super.onActivityResult(request, outcome, data);
        if (request == CHOOSE_IMAGE) {
            Uri selected = null;
            if (outcome == RESULT_OK) {
                if (capturedFile != null) {
                    if (capturedFile.length() == 0 && data != null && data.getExtras() != null
                            && data.getExtras().get("data") instanceof Bitmap) {
                        Bitmap thumbnail = (Bitmap) data.getExtras().get("data");
                        try (OutputStream out = new FileOutputStream(capturedFile)) {
                            thumbnail.compress(Bitmap.CompressFormat.JPEG, 95, out);
                        } catch (IOException ignored) {
                            // Fall back to the picker if the camera returned no usable image.
                        }
                    }
                    if (capturedFile.length() > 0) selected = capturedImage;
                    else {
                        capturedFile.delete();
                        capturedImage = null;
                        capturedFile = null;
                        openImagePicker();
                        return;
                    }
                } else if (data != null && "content".equals(data.getScheme())) {
                    selected = data.getData();
                }
            }
            completePhonePicker(selected);
        } else if (request == SAVE_DOCUMENT) {
            byte[] bytes = pendingDocument;
            pendingDocument = null;
            if (outcome == RESULT_OK && data != null && data.getData() != null && bytes != null) {
                Uri path = data.getData();
                storage.execute(() -> {
                    try {
                        write(path, bytes);
                        notifyUser("Photo saved.");
                    } catch (IOException | SecurityException error) { notifyUser("Could not save the photo."); }
                });
            }
        }
    }

    private void completePhonePicker(Uri selected) {
        stopPhoneLocation();
        if (phoneMode == 0) {
            finishImagePicker(selected);
            return;
        }
        if (selected == null) {
            cameraView.evaluateJavascript("window.setPhoneCameraMetadata(null)", null);
            finishImagePicker(null);
            return;
        }

        File photo = capturedFile;
        Location location = phoneMode == PHONE_WITH_LOCATION && hasLocationPermission() ? phoneFix : null;
        boolean useExifLocation = phoneMode == PHONE_WITH_LOCATION && hasLocationPermission();
        storage.execute(() -> {
            JSONObject metadata = new JSONObject();
            try {
                metadata.put("camera", photo != null);
                if (photo != null) {
                    long takenAt = photo.lastModified();
                    float[] coordinates = null;
                    try {
                        ExifInterface exif = new ExifInterface(photo.getAbsolutePath());
                        takenAt = captureTime(exif, takenAt);
                        if (useExifLocation) {
                            float[] candidate = new float[2];
                            if (exif.getLatLong(candidate)) coordinates = candidate;
                        }
                    } catch (IOException ignored) {
                        // The camera can return a JPEG without EXIF metadata.
                    }
                    metadata.put("takenAt", takenAt);
                    if (coordinates != null) {
                        metadata.put("lat", (double) coordinates[0]);
                        metadata.put("lon", (double) coordinates[1]);
                    } else if (isFresh(location, takenAt)) {
                        metadata.put("lat", location.getLatitude());
                        metadata.put("lon", location.getLongitude());
                    }
                }
            } catch (JSONException ignored) {
                // Continue with the image when optional metadata is invalid.
            }
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed() || pickerCallback == null) return;
                cameraView.evaluateJavascript("window.setPhoneCameraMetadata(" + metadata + ")",
                        ignored -> finishImagePicker(selected));
            });
        });
    }

    private static long captureTime(ExifInterface exif, long fallback) {
        String value = exif.getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL);
        if (value == null) value = exif.getAttribute(ExifInterface.TAG_DATETIME);
        if (value == null || value.length() < 19) return fallback;
        SimpleDateFormat parser = new SimpleDateFormat("yyyy:MM:dd HH:mm:ss", Locale.US);
        parser.setLenient(false);
        String offset = exif.getAttribute("OffsetTimeOriginal");
        if (offset != null && offset.matches("[+-][0-9]{2}:[0-9]{2}")) {
            parser.setTimeZone(TimeZone.getTimeZone("GMT" + offset));
        }
        try {
            Date date = parser.parse(value.substring(0, 19));
            return date == null || date.getTime() <= 0 ? fallback : date.getTime();
        } catch (ParseException ignored) {
            return fallback;
        }
    }

    public final class AndroidHost {
        @JavascriptInterface public String updateInfo() {
            OtaUpdater updater = ota;
            JSONObject json = new JSONObject();
            try {
                json.put("app", appVersionName);
                json.put("updates", updater != null);
                json.put("web", updater != null ? updater.activeLabel() : bundledWebLabel);
                String pending = updater != null ? updater.pendingLabel() : null;
                json.put("pending", pending != null);
                json.put("pendingLabel", pending == null ? "" : pending);
            } catch (JSONException ignored) {
                // Fall through with whatever was filled in.
            }
            return json.toString();
        }

        @JavascriptInterface public void checkForUpdates() {
            runOnUiThread(() -> runOtaCheck(true));
        }

        // The page loaded and started properly: an update that was being served is good.
        @JavascriptInterface public void otaConfirm() {
            OtaUpdater updater = ota;
            if (updater != null) updater.confirm();
        }

        // Loads the page again, which switches to a downloaded update.
        @JavascriptInterface public void applyUpdate() {
            runOnUiThread(() -> { if (!isFinishing() && !isDestroyed()) cameraView.loadUrl(HOME); });
        }

        // ---- The phone's own camera (same calls as the iPhone app) ----
        @JavascriptInterface public void cameraStart(String facing) {
            runOnUiThread(() -> {
                if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                    nativeCamera.start(facing);
                } else {
                    pendingCameraFacing = facing;
                    requestPermissions(new String[]{Manifest.permission.CAMERA}, NATIVE_CAMERA_ACCESS);
                }
            });
        }

        @JavascriptInterface public void cameraStop() { runOnUiThread(() -> nativeCamera.stop()); }

        @JavascriptInterface public void cameraSet(String json) {
            try {
                JSONObject settings = new JSONObject(json);
                nativeCamera.set(settings.has("zoom") ? settings.getDouble("zoom") : null,
                        settings.has("torch") ? settings.getBoolean("torch") : null,
                        settings.has("flash") ? settings.getString("flash") : null,
                        settings.has("exposure") ? settings.getDouble("exposure") : null);
            } catch (JSONException ignored) {
                // Ignore malformed settings.
            }
        }

        /** x, y: a point in the page (CSS pixels). */
        @JavascriptInterface public void cameraFocus(double x, double y) {
            runOnUiThread(() -> {
                float density = getResources().getDisplayMetrics().density;
                View preview = nativeCamera.view;
                nativeCamera.focus(cameraView.getLeft() + (float) x * density - preview.getLeft(),
                        cameraView.getTop() + (float) y * density - preview.getTop());
            });
        }

        /** The page's camera area (CSS pixels): the preview fills exactly the photo's frame. */
        @JavascriptInterface public void cameraLayout(double x, double y, double width, double height) {
            if (!(width > 0 && height > 0)) return;
            runOnUiThread(() -> {
                float density = getResources().getDisplayMetrics().density;
                FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
                        Math.round((float) width * density), Math.round((float) height * density), Gravity.TOP | Gravity.START);
                params.leftMargin = Math.round((float) x * density);
                params.topMargin = Math.round((float) y * density);
                nativeCamera.view.setLayoutParams(params);
                nativeCamera.view.post(nativeCamera::updateTransform);
            });
        }

        @JavascriptInterface public void cameraCapture(String id) {
            if (id == null || !id.matches("[A-Za-z0-9_-]{1,40}")) return;
            nativeCamera.capture(id);
        }

        @JavascriptInterface public void setVolumeShutter(boolean on) { volumeShutter = on; }

        @JavascriptInterface public boolean hasLocationAccess() {
            return hasLocationPermission();
        }

        @JavascriptInterface public void preparePhoneCamera(boolean withLocation) {
            nextPhoneMode = withLocation ? PHONE_WITH_LOCATION : PHONE_WITHOUT_LOCATION;
        }

        /** Deletes a photo (and its "-original" twin) that this app saved into Pictures/GeoZipTag. */
        @JavascriptInterface public void deletePhoto(String filename) {
            if (filename == null || !filename.matches("GeoZipTag-[A-Za-z0-9_-]{1,95}\\.jpg")) return;
            storage.execute(() -> {
                boolean ok = true;
                for (String name : new String[]{filename, filename.replace(".jpg", "-original.jpg")}) {
                    ok &= deleteSaved(name);
                }
                String script = "window.onPhotoDeleted && window.onPhotoDeleted(" + JSONObject.quote(filename) + "," + ok + ")";
                runOnUiThread(() -> {
                    if (!isFinishing() && !isDestroyed()) cameraView.evaluateJavascript(script, null);
                });
            });
        }

        @JavascriptInterface public void exportPhoto(String action, String filename, String encoded) {
            if (filename == null || !filename.matches("GeoZipTag-[A-Za-z0-9_-]{1,95}\\.jpg")
                    || encoded == null || encoded.length() > MAX_PAYLOAD) {
                notifyUser("Could not export this photo.");
                return;
            }
            if (!"save".equals(action) && !"share".equals(action)) return;
            storage.execute(() -> {
                try {
                    byte[] bytes = Base64.decode(encoded, Base64.DEFAULT);
                    if (bytes.length < 3 || bytes[0] != (byte) 0xff || bytes[1] != (byte) 0xd8) {
                        throw new IOException("Invalid JPEG");
                    }
                    if ("share".equals(action)) {
                        File file = new File(CacheImageProvider.folder(MainActivity.this, "shared"), filename);
                        try (OutputStream out = new FileOutputStream(file)) { out.write(bytes); }
                        shareFile(CacheImageProvider.uriFor("shared", filename));
                    } else if (Build.VERSION.SDK_INT >= 29) {
                        saveToGallery(filename, bytes);
                    } else {
                        saveLegacy(filename, bytes);
                    }
                } catch (IOException | IllegalArgumentException | SecurityException error) {
                    notifyUser("Could not export the photo.");
                }
            });
        }

        /**
         * Looks up the address with the phone's built-in geocoder (free, no API key) and
         * answers through window.onPhoneAddress(requestId, address-or-null).
         */
        @JavascriptInterface public void reverseGeocode(String requestId, double lat, double lon) {
            if (requestId == null || !requestId.matches("[A-Za-z0-9_-]{1,40}")
                    || Double.isNaN(lat) || Double.isNaN(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
                return;
            }
            if (!Geocoder.isPresent()) {
                deliverAddress(requestId, null);
                return;
            }
            // English names with the phone's region, so stamps don't mix scripts with the rest of the text.
            Geocoder geocoder = new Geocoder(MainActivity.this,
                    new Locale("en", Locale.getDefault().getCountry()));
            if (Build.VERSION.SDK_INT >= 33) {
                geocoder.getFromLocation(lat, lon, 1, new Geocoder.GeocodeListener() {
                    @Override public void onGeocode(List<Address> addresses) {
                        deliverAddress(requestId, addresses.isEmpty() ? null : addresses.get(0));
                    }
                    @Override public void onError(String message) {
                        deliverAddress(requestId, null);
                    }
                });
            } else {
                lookups.execute(() -> {
                    Address address = null;
                    try {
                        List<Address> results = geocoder.getFromLocation(lat, lon, 1);
                        if (results != null && !results.isEmpty()) address = results.get(0);
                    } catch (IOException | IllegalArgumentException ignored) {
                        // No network or no geocoder backend: the page falls back to Photon.
                    }
                    deliverAddress(requestId, address);
                });
            }
        }

        @JavascriptInterface public void printReport(String html) {
            if (html == null || html.length() > MAX_PAYLOAD) {
                notifyUser("This report is too large. Use smaller photos.");
                return;
            }
            runOnUiThread(() -> showPrintDialog(html));
        }
    }

    private void deliverAddress(String requestId, Address address) {
        String payload = "null";
        if (address != null) {
            JSONObject json = new JSONObject();
            try {
                json.putOpt("featureName", address.getFeatureName());
                json.putOpt("thoroughfare", address.getThoroughfare());
                json.putOpt("subThoroughfare", address.getSubThoroughfare());
                json.putOpt("subLocality", address.getSubLocality());
                json.putOpt("locality", address.getLocality());
                json.putOpt("subAdminArea", address.getSubAdminArea());
                json.putOpt("adminArea", address.getAdminArea());
                json.putOpt("postalCode", address.getPostalCode());
                json.putOpt("countryName", address.getCountryName());
                json.putOpt("countryCode", address.getCountryCode());
                if (address.getMaxAddressLineIndex() >= 0) json.putOpt("addressLine", address.getAddressLine(0));
                payload = json.toString();
            } catch (JSONException ignored) {
                // Send no phone address; the page keeps the Photon result.
            }
        }
        String script = "window.onPhoneAddress && window.onPhoneAddress(" + JSONObject.quote(requestId) + "," + payload + ")";
        runOnUiThread(() -> {
            if (!isFinishing() && !isDestroyed()) cameraView.evaluateJavascript(script, null);
        });
    }

    private void saveToGallery(String filename, byte[] bytes) throws IOException {
        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, filename);
        values.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
        values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/GeoZipTag");
        values.put(MediaStore.Images.Media.IS_PENDING, 1);
        Uri uri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
        if (uri == null) throw new IOException("Could not open gallery");
        boolean complete = false;
        try {
            write(uri, bytes);
            values.clear();
            values.put(MediaStore.Images.Media.IS_PENDING, 0);
            if (getContentResolver().update(uri, values, null, null) != 1) {
                throw new IOException("Could not finish saving");
            }
            complete = true;
            savedPhotos.put(filename, uri);
            rememberSaved(filename, uri);
            showSaved();
        } finally {
            if (!complete) getContentResolver().delete(uri, null, null);
        }
    }

    /** Remembers where a photo went in the gallery (the 60 most recent), so it can be deleted after a restart. */
    private void rememberSaved(String filename, Uri uri) {
        android.content.SharedPreferences prefs = getSharedPreferences("savedPhotos", MODE_PRIVATE);
        android.content.SharedPreferences.Editor editor = prefs.edit().putString(filename, uri.toString());
        java.util.TreeSet<String> names = new java.util.TreeSet<>(prefs.getAll().keySet());
        names.add(filename);
        while (names.size() > 60) editor.remove(names.pollFirst());   // names sort by their timestamp
        editor.apply();
    }

    // A photo that was never saved (or is already gone) counts as deleted.
    private boolean deleteSaved(String filename) {
        synchronized (pendingLegacySaves) {
            for (int i = pendingLegacySaves.size() - 1; i >= 0; i--) {
                if (filename.equals(pendingLegacySaves.get(i)[0])) pendingLegacySaves.remove(i);
            }
        }
        boolean ok = true;
        Uri uri = savedPhotos.remove(filename);
        if (uri == null) {
            // A photo from an earlier session: its gallery entry was remembered on disk.
            String stored = getSharedPreferences("savedPhotos", MODE_PRIVATE).getString(filename, null);
            if (stored != null) uri = Uri.parse(stored);
        }
        getSharedPreferences("savedPhotos", MODE_PRIVATE).edit().remove(filename).apply();
        if (uri != null) {
            try { getContentResolver().delete(uri, null, null); }
            catch (SecurityException | IllegalArgumentException error) { ok = false; }
        }
        if (Build.VERSION.SDK_INT < 29
                && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED) {
            File file = new File(new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "GeoZipTag"), filename);
            if (file.exists()) {
                if (file.delete()) MediaScannerConnection.scanFile(this, new String[]{file.getAbsolutePath()}, null, null);
                else ok = false;
            }
        }
        return ok;
    }

    // Android 8-9: write into Pictures/GeoZipTag directly once storage access is granted.
    private void saveLegacy(String filename, byte[] bytes) throws IOException {
        if (checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            synchronized (pendingLegacySaves) { pendingLegacySaves.add(new Object[]{filename, bytes}); }
            runOnUiThread(() -> {
                if (storageRequested) return;
                storageRequested = true;
                requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, STORAGE_ACCESS);
            });
            return;
        }
        File folder = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "GeoZipTag");
        if (!folder.isDirectory() && !folder.mkdirs()) throw new IOException("Could not create the photo folder");
        File file = new File(folder, filename);
        try (OutputStream out = new FileOutputStream(file)) { out.write(bytes); }
        MediaScannerConnection.scanFile(this, new String[]{file.getAbsolutePath()}, new String[]{"image/jpeg"}, null);
        showSaved();
    }

    // One short toast per photo (replacing the previous one), with the folder named the first time.
    private void showSaved() {
        String text = savedOnce ? "Saved" : "Saved to Pictures/GeoZipTag";
        savedOnce = true;
        runOnUiThread(() -> {
            if (isFinishing() || isDestroyed()) return;
            if (saveToast != null) saveToast.cancel();
            saveToast = Toast.makeText(this, text, Toast.LENGTH_SHORT);
            saveToast.show();
        });
    }

    private void write(Uri uri, byte[] bytes) throws IOException {
        try (OutputStream out = getContentResolver().openOutputStream(uri, "w")) {
            if (out == null) throw new IOException("Could not open destination");
            out.write(bytes);
        }
    }

    private void createPhotoDocument(String filename, byte[] bytes) {
        if (pendingDocument != null) return;
        pendingDocument = bytes;
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType("image/jpeg").putExtra(Intent.EXTRA_TITLE, filename);
        try { startActivityForResult(intent, SAVE_DOCUMENT); }
        catch (ActivityNotFoundException error) {
            pendingDocument = null;
            notifyUser("No photo save location is available.");
        }
    }

    private void shareFile(Uri uri) {
        runOnUiThread(() -> {
            Intent share = new Intent(Intent.ACTION_SEND).setType("image/jpeg");
            share.putExtra(Intent.EXTRA_STREAM, uri);
            share.setClipData(ClipData.newRawUri("Photo", uri));
            share.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            try { startActivity(Intent.createChooser(share, "Share photo")); }
            catch (ActivityNotFoundException error) { notifyUser("Sharing is unavailable."); }
        });
    }

    private void showPrintDialog(String html) {
        if (reportView != null) reportView.destroy();
        reportView = new WebView(this);
        reportView.getSettings().setAllowFileAccess(false);
        reportView.getSettings().setAllowContentAccess(false);
        reportView.getSettings().setBlockNetworkLoads(true);
        reportView.setWebViewClient(new WebViewClient() {
            private boolean printed;
            @Override public void onPageFinished(WebView view, String url) {
                if (printed || view != reportView || isFinishing()) return;
                printed = true;
                PrintManager manager = (PrintManager) getSystemService(PRINT_SERVICE);
                if (manager == null) { notifyUser("Printing is unavailable."); return; }
                manager.print("GeoZipTag report", view.createPrintDocumentAdapter("GeoZipTag report"),
                        new PrintAttributes.Builder().build());
            }
        });
        reportView.loadDataWithBaseURL("https://" + HOST + "/report", html, "text/html", "UTF-8", null);
    }

    private void removeExpiredCache() {
        long cutoff = System.currentTimeMillis() - 86400000L;
        for (String folder : new String[]{"captured", "shared"}) {
            File[] files = CacheImageProvider.folder(this, folder).listFiles();
            if (files == null) continue;
            for (File file : files) if (file.lastModified() < cutoff) file.delete();
        }
    }

    private void notifyUser(String message) {
        runOnUiThread(() -> {
            if (!isFinishing()) Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
        });
    }

    @Override public void onBackPressed() {
        handleBack();
    }

    // Back first closes a sheet or leaves the photo view; otherwise it asks before exiting.
    private void handleBack() {
        cameraView.evaluateJavascript("window.closeGeoStampDialog && window.closeGeoStampDialog()", value -> {
            if (!"true".equals(value)) confirmExit();
        });
    }

    private void confirmExit() {
        if (isFinishing() || isDestroyed()) return;
        if (exitDialog != null && exitDialog.isShowing()) return;
        int theme = getResources().getIdentifier("ExitDialog", "style", getPackageName());
        exitDialog = new AlertDialog.Builder(this, theme != 0 ? theme : android.R.style.Theme_Material_Dialog_Alert)
                .setTitle("Exit GeoZipTag?")
                .setMessage("Photos you took are already saved.")
                .setPositiveButton("Exit", (dialog, which) -> finish())
                .setNegativeButton("Cancel", null)
                .show();
    }

    /** Volume up/down take a photo while the camera is on screen (Settings > Volume buttons). */
    @Override public boolean dispatchKeyEvent(KeyEvent event) {
        int key = event.getKeyCode();
        if (volumeShutter && nativeCamera != null && nativeCamera.isRunning()
                && (key == KeyEvent.KEYCODE_VOLUME_UP || key == KeyEvent.KEYCODE_VOLUME_DOWN)) {
            if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) {
                callPage("window.onHardwareShutter && window.onHardwareShutter()");
            }
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    private void callPage(String script) {
        runOnUiThread(() -> {
            if (!isFinishing() && !isDestroyed()) cameraView.evaluateJavascript(script, null);
        });
    }

    @Override protected void onPause() {
        nativeCamera.pause();
        cameraView.onPause();
        super.onPause();
    }

    @Override protected void onResume() {
        super.onResume();
        cameraView.onResume();
        nativeCamera.resume();
        runOtaCheck(false);
    }

    @Override protected void onDestroy() {
        if (exitDialog != null) exitDialog.dismiss();
        finishImagePicker(null);
        storage.shutdown();
        lookups.shutdownNow();
        updates.shutdownNow();
        if (reportView != null) reportView.destroy();
        nativeCamera.release();
        cameraView.removeJavascriptInterface("AndroidHost");
        cameraView.destroy();
        super.onDestroy();
    }
}
