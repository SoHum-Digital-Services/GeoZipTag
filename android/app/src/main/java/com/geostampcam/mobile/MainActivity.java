package com.geostampcam.mobile;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentValues;
import android.content.Intent;
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
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONException;
import org.json.JSONObject;

public final class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String HOME = "https://" + HOST + "/index.html";
    private static final int CAMERA_ACCESS = 1, LOCATION_ACCESS = 2, PICKER_CAMERA_ACCESS = 3;
    private static final int CHOOSE_IMAGE = 4, SAVE_DOCUMENT = 5, PHONE_LOCATION_ACCESS = 6, STORAGE_ACCESS = 7;
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
    private boolean storageRequested, savedOnce;
    private Toast saveToast;
    private AlertDialog exitDialog;

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
        cameraView = new WebView(this);
        root.addView(cameraView, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
        configureCameraView();
        cameraView.loadUrl(HOME);
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
        cameraView.setBackgroundColor(0xff000000);
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
        // Only these app files are served; anything else gets a local 404.
        if (path.matches("/(index\\.html|style\\.css|camera\\.js|manifest\\.webmanifest"
                + "|vendor/qrcode\\.(mjs|txt)|vendor/qrcode-LICENSE\\.txt|vendor/tz-lookup\\.js|vendor/tz-lookup-LICENSE\\.txt"
                + "|assets/[a-z0-9-]{1,60}\\.(svg|woff2|jpg|png|txt))")) {
            String mime = assetType(path);
            try {
                Map<String, String> headers = new HashMap<>();
                headers.put("Content-Security-Policy", CSP);
                headers.put("X-Content-Type-Options", "nosniff");
                return new WebResourceResponse(mime, "UTF-8", 200, "OK", headers,
                        getAssets().open("web" + path));
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
        @JavascriptInterface public boolean hasLocationAccess() {
            return hasLocationPermission();
        }

        @JavascriptInterface public void preparePhoneCamera(boolean withLocation) {
            nextPhoneMode = withLocation ? PHONE_WITH_LOCATION : PHONE_WITHOUT_LOCATION;
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
            showSaved();
        } finally {
            if (!complete) getContentResolver().delete(uri, null, null);
        }
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

    @Override protected void onPause() {
        cameraView.onPause();
        super.onPause();
    }

    @Override protected void onResume() {
        super.onResume();
        cameraView.onResume();
    }

    @Override protected void onDestroy() {
        if (exitDialog != null) exitDialog.dismiss();
        finishImagePicker(null);
        storage.shutdown();
        lookups.shutdownNow();
        if (reportView != null) reportView.destroy();
        cameraView.removeJavascriptInterface("AndroidHost");
        cameraView.destroy();
        super.onDestroy();
    }
}
