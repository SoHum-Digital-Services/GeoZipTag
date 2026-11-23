package com.geostampcam.mobile;

import android.app.Activity;
import android.content.Context;
import android.graphics.ImageFormat;
import android.graphics.Matrix;
import android.graphics.Rect;
import android.graphics.SurfaceTexture;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CameraMetadata;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.CaptureResult;
import android.hardware.camera2.TotalCaptureResult;
import android.hardware.camera2.params.MeteringRectangle;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.Image;
import android.media.ImageReader;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.util.Range;
import android.util.Rational;
import android.util.Size;
import android.view.OrientationEventListener;
import android.view.Surface;
import android.view.TextureView;
import java.nio.ByteBuffer;
import java.util.ArrayDeque;
import java.util.Arrays;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The phone's own camera through Camera2, so photos come from the still-capture pipeline at full resolution
 * (high-quality noise reduction and sharpening) instead of a WebView video frame. The preview is a TextureView
 * behind the transparent page, placed where the page's camera area is. Mirrors ios/GeoZipTag/NativeCamera.swift.
 */
final class NativeCamera implements TextureView.SurfaceTextureListener {
    interface Listener {
        void onState(JSONObject state);        // reply to start(): {ok, ...} or {ok:false, error}
        void onPhoto(String id, byte[] jpeg);  // jpeg is null when the capture failed
    }

    private static final long MAX_PIXELS = 13_000_000L;   // about 12 MP: the page stamps it on a canvas

    final TextureView view;
    private final Activity activity;
    private final Listener listener;
    private final CameraManager manager;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final OrientationEventListener orientation;
    private HandlerThread thread;
    private Handler handler;

    // Camera state (only touched on the camera thread)
    private CameraDevice device;
    private CameraCaptureSession session;
    private ImageReader reader;
    private CaptureRequest.Builder previewRequest;
    private CameraCharacteristics characteristics;
    private String facing = "environment";
    private Size previewSize, photoSize;
    private Rect activeArray;
    private int sensorOrientation;
    private boolean zoomRatioSupported, brightened;
    private float zoom = 1f, zoomMin = 1f, zoomMax = 1f;
    private boolean torch;
    private String flash = "off";              // off | auto | on: the photo flash
    private float userExposure;                // the brightness slider, in stops
    private int exposureBoost, maxIso = 1, frames;
    private String stillAfterMetering;         // a photo waiting for the flash metering to finish
    private long meteringStarted;
    private boolean meteringSeen;
    private final ArrayDeque<String> pendingPhotos = new ArrayDeque<>();
    private volatile int deviceOrientation;

    // Wanted state, so the camera can come back after the app was in the background.
    private boolean wanted, waitingForSurface;

    NativeCamera(Activity activity, Listener listener) {
        this.activity = activity;
        this.listener = listener;
        manager = (CameraManager) activity.getSystemService(Context.CAMERA_SERVICE);
        view = new TextureView(activity);
        view.setSurfaceTextureListener(this);
        orientation = new OrientationEventListener(activity) {
            @Override public void onOrientationChanged(int degrees) {
                if (degrees != ORIENTATION_UNKNOWN) deviceOrientation = ((degrees + 45) / 90 * 90) % 360;
            }
        };
    }

    private Handler handler() {
        if (thread == null) {
            thread = new HandlerThread("geoziptag-camera");
            thread.start();
            handler = new Handler(thread.getLooper());
        }
        return handler;
    }

    // ------------------------------------------------------------------ starting and stopping

    void start(String nextFacing) {
        wanted = true;
        if (orientation.canDetectOrientation()) orientation.enable();
        handler().post(() -> open("user".equals(nextFacing) ? "user" : "environment", true));
    }

    void stop() {
        wanted = false;
        orientation.disable();
        handler().post(this::close);
        main.post(() -> view.setVisibility(android.view.View.INVISIBLE));
    }

    /** The activity went to the background: release the camera, but come back on resume. */
    void pause() {
        orientation.disable();
        if (handler != null) handler.post(this::close);
    }

    void resume() {
        if (!wanted) return;
        if (orientation.canDetectOrientation()) orientation.enable();
        handler().post(() -> open(facing, false));
    }

    void release() {
        wanted = false;
        orientation.disable();
        if (thread != null) {
            handler.post(this::close);
            thread.quitSafely();
            thread = null;
        }
    }

    boolean isRunning() { return wanted; }

    private void open(String nextFacing, boolean reply) {
        close();
        facing = nextFacing;
        if (!view.isAvailable()) {
            waitingForSurface = reply || waitingForSurface;
            main.post(() -> view.setVisibility(android.view.View.VISIBLE));   // makes the surface available
            return;
        }
        try {
            String id = chooseCamera(nextFacing);
            if (id == null) { if (reply) fail("unavailable"); return; }
            characteristics = manager.getCameraCharacteristics(id);
            StreamConfigurationMap map = characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            if (map == null) { if (reply) fail("unavailable"); return; }
            photoSize = largest43(map.getOutputSizes(ImageFormat.JPEG), MAX_PIXELS);
            previewSize = largest43(map.getOutputSizes(SurfaceTexture.class), 1920L * 1440L);
            Integer sensor = characteristics.get(CameraCharacteristics.SENSOR_ORIENTATION);
            sensorOrientation = sensor == null ? 90 : sensor;
            activeArray = characteristics.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE);
            Range<Integer> iso = characteristics.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE);
            maxIso = iso == null ? 3200 : Math.max(1, iso.getUpper());
            zoomRatioSupported = false;
            zoomMin = 1f;
            zoomMax = 1f;
            if (Build.VERSION.SDK_INT >= 30) {
                Range<Float> ratio = characteristics.get(CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE);
                if (ratio != null) {
                    zoomRatioSupported = true;
                    zoomMin = ratio.getLower();
                    zoomMax = Math.min(ratio.getUpper(), 10f);
                }
            }
            if (!zoomRatioSupported) {
                Float digital = characteristics.get(CameraCharacteristics.SCALER_AVAILABLE_MAX_DIGITAL_ZOOM);
                zoomMax = digital == null ? 1f : Math.min(digital, 10f);
            }
            zoom = Math.max(zoomMin, Math.min(1f, zoomMax));
            torch = false;
            brightened = false;
            exposureBoost = 0;
            userExposure = 0;
            Boolean hasFlash = characteristics.get(CameraCharacteristics.FLASH_INFO_AVAILABLE);
            if (hasFlash == null || !hasFlash) flash = "off";
            reader = ImageReader.newInstance(photoSize.getWidth(), photoSize.getHeight(), ImageFormat.JPEG, 2);
            reader.setOnImageAvailableListener(this::photoReady, handler);
            final boolean answer = reply || waitingForSurface;
            waitingForSurface = false;
            manager.openCamera(id, new CameraDevice.StateCallback() {
                @Override public void onOpened(CameraDevice camera) {
                    device = camera;
                    createSession(answer);
                }
                @Override public void onDisconnected(CameraDevice camera) {
                    camera.close();
                    if (device == camera) device = null;
                }
                @Override public void onError(CameraDevice camera, int error) {
                    camera.close();
                    if (device == camera) device = null;
                    if (answer) fail("unavailable");
                }
            }, handler);
        } catch (CameraAccessException | SecurityException | IllegalArgumentException error) {
            if (reply) fail(error instanceof SecurityException ? "denied" : "unavailable");
        }
    }

    private void close() {
        try { if (session != null) session.close(); } catch (IllegalStateException ignored) { }
        session = null;
        if (device != null) device.close();
        device = null;
        if (reader != null) reader.close();
        reader = null;
        previewRequest = null;
        while (!pendingPhotos.isEmpty()) listener.onPhoto(pendingPhotos.poll(), null);
    }

    private String chooseCamera(String wantedFacing) throws CameraAccessException {
        int lens = "user".equals(wantedFacing) ? CameraMetadata.LENS_FACING_FRONT : CameraMetadata.LENS_FACING_BACK;
        String best = null;
        float bestMin = Float.MAX_VALUE;
        for (String id : manager.getCameraIdList()) {
            CameraCharacteristics c = manager.getCameraCharacteristics(id);
            Integer f = c.get(CameraCharacteristics.LENS_FACING);
            if (f == null || f != lens) continue;
            // The first camera of each side is the main one; on Android 11+ a logical camera that reaches the
            // ultra-wide lens (zoom ratio below 1) is preferred, so .5/.6 switches lenses like the Camera app.
            float min = 1f;
            if (Build.VERSION.SDK_INT >= 30) {
                Range<Float> ratio = c.get(CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE);
                if (ratio != null) min = ratio.getLower();
            }
            if (best == null || min < bestMin - 0.01f) { best = id; bestMin = min; }
        }
        return best;
    }

    private static Size largest43(Size[] sizes, long maxPixels) {
        Size best = null, fallback = null;
        if (sizes == null) return new Size(1920, 1440);
        for (Size size : sizes) {
            long pixels = (long) size.getWidth() * size.getHeight();
            if (pixels > maxPixels) continue;
            if (fallback == null || pixels > (long) fallback.getWidth() * fallback.getHeight()) fallback = size;
            double ratio = (double) Math.max(size.getWidth(), size.getHeight()) / Math.min(size.getWidth(), size.getHeight());
            if (Math.abs(ratio - 4.0 / 3.0) < 0.02 && (best == null || pixels > (long) best.getWidth() * best.getHeight())) best = size;
        }
        if (best != null) return best;
        if (fallback != null) return fallback;
        return sizes.length > 0 ? sizes[0] : new Size(1920, 1440);
    }

    private void createSession(boolean reply) {
        try {
            SurfaceTexture texture = view.getSurfaceTexture();
            if (texture == null || device == null) { if (reply) fail("unavailable"); return; }
            texture.setDefaultBufferSize(previewSize.getWidth(), previewSize.getHeight());
            Surface previewSurface = new Surface(texture);
            previewRequest = device.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
            previewRequest.addTarget(previewSurface);
            device.createCaptureSession(Arrays.asList(previewSurface, reader.getSurface()), new CameraCaptureSession.StateCallback() {
                @Override public void onConfigured(CameraCaptureSession configured) {
                    session = configured;
                    applySettings(previewRequest);
                    previewRequest.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
                    repeat();
                    main.post(() -> {
                        view.setVisibility(android.view.View.VISIBLE);
                        updateTransform();
                    });
                    if (reply) listener.onState(state());
                }
                @Override public void onConfigureFailed(CameraCaptureSession failed) {
                    if (reply) fail("unavailable");
                }
            }, handler);
        } catch (CameraAccessException | IllegalStateException error) {
            if (reply) fail("unavailable");
        }
    }

    private void fail(String reason) {
        JSONObject state = new JSONObject();
        try { state.put("ok", false).put("error", reason); } catch (JSONException ignored) { }
        listener.onState(state);
    }

    private JSONObject state() {
        JSONObject state = new JSONObject();
        try {
            Boolean flash = characteristics.get(CameraCharacteristics.FLASH_INFO_AVAILABLE);
            Integer regions = characteristics.get(CameraCharacteristics.CONTROL_MAX_REGIONS_AF);
            boolean front = false, back = false;
            for (String id : manager.getCameraIdList()) {
                Integer f = manager.getCameraCharacteristics(id).get(CameraCharacteristics.LENS_FACING);
                if (f != null && f == CameraMetadata.LENS_FACING_FRONT) front = true;
                if (f != null && f == CameraMetadata.LENS_FACING_BACK) back = true;
            }
            state.put("ok", true).put("facing", facing)
                    .put("width", Math.min(photoSize.getWidth(), photoSize.getHeight()))
                    .put("height", Math.max(photoSize.getWidth(), photoSize.getHeight()))
                    .put("zoom", (double) zoom).put("zoomMin", (double) zoomMin).put("zoomMax", (double) zoomMax)
                    .put("hasTorch", flash != null && flash)
                    .put("flashModes", flash != null && flash ? new org.json.JSONArray(Arrays.asList("off", "auto", "on"))
                            : new org.json.JSONArray(Arrays.asList("off")))
                    .put("exposureMin", (double) Math.max(-2f, evStep() * aeRange().getLower()))
                    .put("exposureMax", (double) Math.min(2f, evStep() * aeRange().getUpper()))
                    .put("canFocus", regions != null && regions > 0)
                    .put("cameras", front && back ? 2 : 1);
        } catch (JSONException | CameraAccessException ignored) {
            // A partial state still lets the page use the camera.
        }
        return state;
    }

    // ------------------------------------------------------------------ settings

    private void applySettings(CaptureRequest.Builder request) {
        request.set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO);
        // The photo flash is planned by auto exposure; the torch only works with the plain mode.
        int aeMode = "auto".equals(flash) ? CaptureRequest.CONTROL_AE_MODE_ON_AUTO_FLASH
                : "on".equals(flash) ? CaptureRequest.CONTROL_AE_MODE_ON_ALWAYS_FLASH : CaptureRequest.CONTROL_AE_MODE_ON;
        request.set(CaptureRequest.CONTROL_AE_MODE, aeMode);
        request.set(CaptureRequest.FLASH_MODE, torch && "off".equals(flash) ? CaptureRequest.FLASH_MODE_TORCH : CaptureRequest.FLASH_MODE_OFF);
        // Low light: allow the slowest frame rate the camera offers (longer exposures), like the Camera app.
        Range<Integer>[] ranges = characteristics.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES);
        if (ranges != null) {
            Range<Integer> best = null;
            for (Range<Integer> range : ranges) {
                if (range.getUpper() > 30) continue;
                if (best == null || range.getUpper() > best.getUpper()
                        || (range.getUpper().equals(best.getUpper()) && range.getLower() < best.getLower())) best = range;
            }
            if (best != null) request.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, best);
        }
        request.set(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION, compensation());
        if (zoomRatioSupported && Build.VERSION.SDK_INT >= 30) {
            request.set(CaptureRequest.CONTROL_ZOOM_RATIO, zoom);
        } else if (activeArray != null) {
            int w = Math.round(activeArray.width() / zoom), h = Math.round(activeArray.height() / zoom);
            int left = activeArray.left + (activeArray.width() - w) / 2, top = activeArray.top + (activeArray.height() - h) / 2;
            request.set(CaptureRequest.SCALER_CROP_REGION, new Rect(left, top, left + w, top + h));
        }
    }

    private void repeat() {
        if (session == null || previewRequest == null) return;
        try {
            session.setRepeatingRequest(previewRequest.build(), new CameraCaptureSession.CaptureCallback() {
                @Override public void onCaptureCompleted(CameraCaptureSession s, CaptureRequest r, TotalCaptureResult result) {
                    if (++frames % 15 == 0) adjustForLight(result);
                    if (stillAfterMetering != null) checkMetering(result);
                }
            }, handler);
        } catch (CameraAccessException | IllegalStateException ignored) {
            // The session closed meanwhile.
        }
    }

    /** At a high ISO (a dark scene) expose one stop brighter; back to normal in good light. */
    private void adjustForLight(CaptureResult result) {
        Integer iso = result.get(CaptureResult.SENSOR_SENSITIVITY);
        if (iso == null || previewRequest == null) return;
        boolean dark = brightened ? iso > maxIso * 0.2 : iso > maxIso * 0.45;
        if (dark == brightened) return;
        brightened = dark;
        exposureBoost = dark ? 1 : 0;
        previewRequest.set(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION, compensation());
        repeat();
    }

    private float evStep() {
        Rational step = characteristics == null ? null : characteristics.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_STEP);
        return step == null || step.floatValue() <= 0 ? 0f : step.floatValue();
    }

    private Range<Integer> aeRange() {
        Range<Integer> range = characteristics == null ? null : characteristics.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_RANGE);
        return range == null ? new Range<>(0, 0) : range;
    }

    /** The low-light boost plus the brightness slider, in the camera's compensation steps. */
    private int compensation() {
        float step = evStep();
        if (step <= 0) return 0;
        Range<Integer> range = aeRange();
        int steps = Math.round((exposureBoost + userExposure) / step);
        return Math.max(range.getLower(), Math.min(range.getUpper(), steps));
    }

    /** zoom: 1 = the main lens, below 1 = ultra wide. torch: null leaves it as it is. */
    void set(Double nextZoom, Boolean nextTorch, String nextFlash, Double nextExposure) {
        handler().post(() -> {
            if (nextZoom != null) zoom = (float) Math.max(zoomMin, Math.min(zoomMax, nextZoom));
            if (nextTorch != null) torch = nextTorch;
            if (nextFlash != null && characteristics != null) {
                Boolean hasFlash = characteristics.get(CameraCharacteristics.FLASH_INFO_AVAILABLE);
                flash = hasFlash != null && hasFlash && ("auto".equals(nextFlash) || "on".equals(nextFlash)) ? nextFlash : "off";
            }
            if (nextExposure != null) userExposure = (float) Math.max(-2, Math.min(2, nextExposure));
            if (previewRequest == null) return;
            applySettings(previewRequest);
            repeat();
        });
    }

    /** Focuses and meters at a point given in pixels of the preview view. */
    void focus(float x, float y) {
        final float[] content = contentPoint(x, y);
        handler().post(() -> {
            if (previewRequest == null || session == null || activeArray == null || content == null) return;
            float u = content[0], v = content[1];
            boolean front = "user".equals(facing);
            if (front) u = 1 - u;   // the front preview is shown mirrored
            float sx, sy;           // the point on the sensor, which is mounted rotated
            switch (sensorOrientation) {
                case 90: sx = v; sy = 1 - u; break;
                case 180: sx = 1 - u; sy = 1 - v; break;
                case 270: sx = 1 - v; sy = u; break;
                default: sx = u; sy = v;
            }
            int half = Math.max(activeArray.width(), activeArray.height()) / 20;
            int cx = activeArray.left + Math.round(sx * activeArray.width());
            int cy = activeArray.top + Math.round(sy * activeArray.height());
            Rect area = new Rect(Math.max(activeArray.left, cx - half), Math.max(activeArray.top, cy - half),
                    Math.min(activeArray.right, cx + half), Math.min(activeArray.bottom, cy + half));
            MeteringRectangle[] region = { new MeteringRectangle(area, MeteringRectangle.METERING_WEIGHT_MAX - 1) };
            try {
                previewRequest.set(CaptureRequest.CONTROL_AF_REGIONS, region);
                previewRequest.set(CaptureRequest.CONTROL_AE_REGIONS, region);
                previewRequest.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_AUTO);
                previewRequest.set(CaptureRequest.CONTROL_AF_TRIGGER, CaptureRequest.CONTROL_AF_TRIGGER_START);
                session.capture(previewRequest.build(), null, handler);
                previewRequest.set(CaptureRequest.CONTROL_AF_TRIGGER, CaptureRequest.CONTROL_AF_TRIGGER_IDLE);
                repeat();
            } catch (CameraAccessException | IllegalStateException ignored) {
                // The camera was closed meanwhile.
            }
        });
    }

    // ------------------------------------------------------------------ taking a photo

    void capture(String id) {
        handler().post(() -> {
            if (device == null || session == null || reader == null) { listener.onPhoto(id, null); return; }
            if ("off".equals(flash) || previewRequest == null) { takeStill(id); return; }
            // With the flash, auto exposure first meters with a pre-flash; the photo follows once it is done.
            try {
                previewRequest.set(CaptureRequest.CONTROL_AE_PRECAPTURE_TRIGGER, CaptureRequest.CONTROL_AE_PRECAPTURE_TRIGGER_START);
                session.capture(previewRequest.build(), null, handler);
                previewRequest.set(CaptureRequest.CONTROL_AE_PRECAPTURE_TRIGGER, CaptureRequest.CONTROL_AE_PRECAPTURE_TRIGGER_IDLE);
                stillAfterMetering = id;
                meteringStarted = System.currentTimeMillis();
                meteringSeen = false;
                handler.postDelayed(() -> { if (id.equals(stillAfterMetering)) { stillAfterMetering = null; takeStill(id); } }, 1500);
            } catch (CameraAccessException | IllegalStateException error) {
                takeStill(id);
            }
        });
    }

    private void checkMetering(CaptureResult result) {
        Integer ae = result.get(CaptureResult.CONTROL_AE_STATE);
        if (ae != null && ae == CaptureResult.CONTROL_AE_STATE_PRECAPTURE) { meteringSeen = true; return; }
        if (meteringSeen || System.currentTimeMillis() - meteringStarted > 400) {
            String id = stillAfterMetering;
            stillAfterMetering = null;
            if (id != null) takeStill(id);
        }
    }

    private void takeStill(String id) {
        {
            if (device == null || session == null || reader == null) { listener.onPhoto(id, null); return; }
            try {
                CaptureRequest.Builder still = device.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE);
                still.addTarget(reader.getSurface());
                applySettings(still);
                still.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
                still.set(CaptureRequest.NOISE_REDUCTION_MODE, CaptureRequest.NOISE_REDUCTION_MODE_HIGH_QUALITY);
                still.set(CaptureRequest.EDGE_MODE, CaptureRequest.EDGE_MODE_HIGH_QUALITY);
                still.set(CaptureRequest.JPEG_QUALITY, (byte) 95);
                // Upright for the way the phone is held (the app itself stays in portrait).
                int held = "user".equals(facing) ? -deviceOrientation : deviceOrientation;
                still.set(CaptureRequest.JPEG_ORIENTATION, (sensorOrientation + held + 360) % 360);
                pendingPhotos.add(id);
                session.capture(still.build(), null, handler);
            } catch (CameraAccessException | IllegalStateException error) {
                pendingPhotos.remove(id);
                listener.onPhoto(id, null);
            }
        }
    }

    private void photoReady(ImageReader source) {
        Image image = null;
        byte[] bytes = null;
        try {
            image = source.acquireNextImage();
            if (image != null) {
                ByteBuffer buffer = image.getPlanes()[0].getBuffer();
                bytes = new byte[buffer.remaining()];
                buffer.get(bytes);
            }
        } catch (IllegalStateException ignored) {
            // No image after all.
        } finally {
            if (image != null) image.close();
        }
        String id = pendingPhotos.poll();
        if (id != null) listener.onPhoto(id, bytes);
    }

    // ------------------------------------------------------------------ preview layout

    /** Scales the preview to fill the view (cropping the centre), the same cut the page makes for the photo. */
    void updateTransform() {
        Size size = previewSize;
        int vw = view.getWidth(), vh = view.getHeight();
        if (size == null || vw == 0 || vh == 0) return;
        // The app is portrait-only, so the camera image arrives turned upright: its width is the short side.
        float contentW = Math.min(size.getWidth(), size.getHeight()), contentH = Math.max(size.getWidth(), size.getHeight());
        float scale = Math.max(vw / contentW, vh / contentH);
        Matrix matrix = new Matrix();
        matrix.setScale(contentW * scale / vw, contentH * scale / vh, vw / 2f, vh / 2f);
        view.setTransform(matrix);
    }

    /** A point on the view as a fraction of the (cropped) camera image, or null outside it. */
    private float[] contentPoint(float x, float y) {
        Size size = previewSize;
        int vw = view.getWidth(), vh = view.getHeight();
        if (size == null || vw == 0 || vh == 0) return null;
        float contentW = Math.min(size.getWidth(), size.getHeight()), contentH = Math.max(size.getWidth(), size.getHeight());
        float scale = Math.max(vw / contentW, vh / contentH);
        float shownW = contentW * scale, shownH = contentH * scale;
        float u = (x + (shownW - vw) / 2f) / shownW, v = (y + (shownH - vh) / 2f) / shownH;
        if (u < 0 || u > 1 || v < 0 || v > 1) return null;
        return new float[]{u, v};
    }

    // ------------------------------------------------------------------ TextureView

    @Override public void onSurfaceTextureAvailable(SurfaceTexture surface, int width, int height) {
        if (wanted) handler().post(() -> open(facing, waitingForSurface));
    }

    @Override public void onSurfaceTextureSizeChanged(SurfaceTexture surface, int width, int height) {
        updateTransform();
    }

    @Override public boolean onSurfaceTextureDestroyed(SurfaceTexture surface) {
        if (handler != null) handler.post(this::close);
        return true;
    }

    @Override public void onSurfaceTextureUpdated(SurfaceTexture surface) { }
}
