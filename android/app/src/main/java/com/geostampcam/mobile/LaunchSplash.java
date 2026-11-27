package com.geostampcam.mobile;

import android.content.Context;
import android.content.res.AssetFileDescriptor;
import android.graphics.Color;
import android.graphics.SurfaceTexture;
import android.media.MediaPlayer;
import android.os.SystemClock;
import android.provider.Settings;
import android.view.Gravity;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.ImageView;

/**
 * The launch video (Android). It sits on top of the page from the app's first screen and loops until the page
 * reports that startup is complete. It only plays; WHEN it goes away is decided by the page's readiness gate
 * (camera, fresh location, address, map, resources, stamping pipeline), never here and never by the video ending.
 * Its first frame is the same picture as the window background poster (launch_background), so nothing jumps.
 * It stays at least 3 s, pauses while the app is in the background, and shows only the poster when the phone's
 * animations are turned off. The pin in the video is decoration, never the user's location.
 */
final class LaunchSplash extends FrameLayout {
    static final long MINIMUM_MS = 3000;
    private static final int NAVY = Color.rgb(2, 23, 57);

    private final long shownAt = SystemClock.elapsedRealtime();
    private final ImageView poster;
    private final TextureView texture;
    private MediaPlayer player;
    private boolean surfaceReady, prepared, paused, dismissing;

    LaunchSplash(Context context) {
        super(context);
        setBackgroundColor(NAVY);
        setClickable(true);   // swallow taps so nothing underneath reacts while loading
        setContentDescription("GeoZiptag");

        poster = new ImageView(context);
        poster.setImageResource(R.drawable.launch_poster);
        poster.setScaleType(ImageView.ScaleType.FIT_CENTER);
        addView(poster, new LayoutParams(-1, -1));

        boolean animationsOff = Settings.Global.getFloat(context.getContentResolver(),
                Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f;
        if (animationsOff) {
            texture = null;
            return;
        }
        texture = new TextureView(context);
        texture.setAlpha(0f);   // the poster shows until the first video frame is drawn
        addView(texture, new LayoutParams(-1, -1, Gravity.CENTER));
        texture.setSurfaceTextureListener(new TextureView.SurfaceTextureListener() {
            @Override public void onSurfaceTextureAvailable(SurfaceTexture st, int w, int h) {
                surfaceReady = true;
                start(new Surface(st));
            }
            @Override public void onSurfaceTextureSizeChanged(SurfaceTexture st, int w, int h) { }
            @Override public boolean onSurfaceTextureDestroyed(SurfaceTexture st) {
                surfaceReady = false;
                release();
                return true;
            }
            @Override public void onSurfaceTextureUpdated(SurfaceTexture st) {
                if (texture.getAlpha() == 0f && prepared) texture.setAlpha(1f);
            }
        });
    }

    @Override protected void onLayout(boolean changed, int l, int t, int r, int b) {
        // Aspect-fit the 1080x1800 clip inside the screen, like the poster.
        if (texture != null) {
            int w = r - l, h = b - t;
            float scale = Math.min(w / 1080f, h / 1800f);
            LayoutParams lp = (LayoutParams) texture.getLayoutParams();
            int fw = Math.round(1080 * scale), fh = Math.round(1800 * scale);
            if (lp.width != fw || lp.height != fh) {
                lp.width = fw;
                lp.height = fh;
                texture.setLayoutParams(lp);
            }
        }
        super.onLayout(changed, l, t, r, b);
    }

    private void start(Surface surface) {
        try {
            MediaPlayer mp = new MediaPlayer();
            AssetFileDescriptor fd = getResources().openRawResourceFd(R.raw.geoziptag_splash);
            mp.setDataSource(fd.getFileDescriptor(), fd.getStartOffset(), fd.getLength());
            fd.close();
            mp.setSurface(surface);
            mp.setVolume(0f, 0f);
            mp.setLooping(true);
            mp.setOnPreparedListener(p -> {
                prepared = true;
                if (!paused) p.start();
            });
            mp.setOnErrorListener((p, what, extra) -> {
                release();   // leave the poster showing; the page still decides when to remove it
                return true;
            });
            mp.prepareAsync();
            player = mp;
        } catch (Exception | Error e) {
            player = null;   // poster only
        }
    }

    private void release() {
        prepared = false;
        if (player != null) {
            try { player.release(); } catch (RuntimeException ignored) { }
            player = null;
        }
    }

    void pause() {
        paused = true;
        if (player != null && prepared) {
            try { player.pause(); } catch (RuntimeException ignored) { }
        }
    }

    void resume() {
        paused = false;
        if (player != null && prepared) {
            try { player.start(); } catch (RuntimeException ignored) { }
        }
    }

    /** Fades out and removes the splash after the 3 s minimum, unless `immediately` (a recovery panel must be seen). */
    void dismiss(boolean immediately) {
        if (dismissing) return;
        dismissing = true;
        long wait = immediately ? 0 : Math.max(0, MINIMUM_MS - (SystemClock.elapsedRealtime() - shownAt));
        animate().alpha(0f).setStartDelay(wait).setDuration(300).withEndAction(() -> {
            release();
            if (getParent() instanceof FrameLayout) ((FrameLayout) getParent()).removeView(this);
        }).start();
    }
}
