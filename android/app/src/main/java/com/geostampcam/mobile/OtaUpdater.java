package com.geostampcam.mobile;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Over-the-air updates for the web part of the app (the files under assets/web).
 *
 * The app only ever runs files that are either bundled in the APK or were downloaded by this class
 * and verified: a manifest signed with the project's ECDSA P-256 key (public key bundled in the APK)
 * lists every file with its SHA-256, and each downloaded file must match. Updates are staged and take
 * effect on the next page load, a version that never reports a successful start is rolled back, and
 * older versions are never accepted. Native changes (Java, manifest, permissions) still need an APK.
 *
 * This class uses only java.* APIs so it can be tested on a plain JVM.
 */
final class OtaUpdater {
    /** The bundled web files inside the APK. */
    interface Assets { InputStream open(String path) throws IOException; }

    /** Fetches a path below the update base URL and returns at most maxBytes of body. */
    interface Http { byte[] get(String relativePath, long maxBytes) throws IOException; }

    static final class Result {
        final String state;   // ready, current, needs-apk or error
        final String detail;  // label of the update, or a short message
        Result(String state, String detail) { this.state = state; this.detail = detail; }
    }

    // The only files the app serves to its web view (also the only files an update may contain).
    private static final Pattern WEB_PATH = Pattern.compile(
            "/(index\\.html|style\\.css|camera\\.js|manifest\\.webmanifest"
            + "|vendor/qrcode\\.(mjs|txt)|vendor/qrcode-LICENSE\\.txt|vendor/tz-lookup\\.js|vendor/tz-lookup-LICENSE\\.txt"
            + "|assets/[a-z0-9-]{1,60}\\.(svg|woff2|jpg|png|txt))");
    private static final Pattern LABEL = Pattern.compile("[0-9A-Za-z._-]{1,32}");
    private static final Pattern HEX64 = Pattern.compile("[0-9a-f]{64}");
    private static final int MAX_FILES = 100;
    private static final long MAX_FILE = 8L * 1024 * 1024, MAX_TOTAL = 24L * 1024 * 1024;
    private static final int ATTEMPTS_BEFORE_ROLLBACK = 2;

    static boolean isWebPath(String path) { return path != null && WEB_PATH.matcher(path).matches(); }

    private static final class Entry {
        final String hash, path;
        final long size;
        Entry(String hash, long size, String path) { this.hash = hash; this.size = size; this.path = path; }
    }

    private static final class Manifest {
        long version, minApk;
        String label;
        final Map<String, Entry> files = new LinkedHashMap<>();
    }

    private final File root;
    private final Assets assets;
    private final Http http;
    private final PublicKey key;
    private final long apkVersion, bundledVersion;
    private final String bundledLabel;
    private final Object lock = new Object();
    private File servingRoot;      // bundle served to the current page (null = the bundled files)
    private String servingLabel;

    OtaUpdater(File root, Assets assets, Http http, PublicKey key, long apkVersion,
            long bundledVersion, String bundledLabel) {
        this.root = root;
        this.assets = assets;
        this.http = http;
        this.key = key;
        this.apkVersion = apkVersion;
        this.bundledVersion = bundledVersion;
        this.bundledLabel = bundledLabel;
        this.servingLabel = bundledLabel;
    }

    static PublicKey parseKey(String base64) throws GeneralSecurityException {
        byte[] der = Base64.getMimeDecoder().decode(base64.trim());
        return KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(der));
    }

    // ------------------------------------------------------------------ serving

    /**
     * Called when a page starts loading: promotes a staged update, rolls back a version that keeps
     * failing, and returns the folder to serve the web files from (null = the files bundled in the APK).
     */
    File servingRoot() {
        synchronized (lock) {
            try {
                File pending = new File(root, "pending");
                if (pending.isDirectory()) {
                    Properties meta = readProps(new File(pending, "meta.properties"));
                    long version = longOf(meta, "version");
                    if (version > bundledVersion && !badVersions().contains(version) && longOf(meta, "minApk") <= apkVersion) {
                        File current = new File(root, "current");
                        deleteTree(current);
                        Files.move(pending.toPath(), current.toPath(), StandardCopyOption.ATOMIC_MOVE);
                        writeState(false, 0, badVersions());
                    } else {
                        deleteTree(pending);
                    }
                }
                File current = new File(root, "current");
                Properties meta = readProps(new File(current, "meta.properties"));
                long version = longOf(meta, "version");
                if (!current.isDirectory() || version <= bundledVersion || longOf(meta, "minApk") > apkVersion) {
                    // No update, or the APK now carries newer web files than the downloaded ones.
                    if (current.isDirectory()) deleteTree(current);
                    return use(null, bundledLabel);
                }
                Properties state = readProps(new File(root, "state.properties"));
                boolean confirmed = "1".equals(state.getProperty("confirmed", "0"));
                int attempts = (int) longOf(state, "attempts");
                if (!confirmed) {
                    if (attempts >= ATTEMPTS_BEFORE_ROLLBACK) {
                        // It never reported a successful start: back to the bundled files for good.
                        Set<Long> bad = badVersions();
                        bad.add(version);
                        deleteTree(current);
                        writeState(true, 0, bad);
                        return use(null, bundledLabel);
                    }
                    writeState(false, attempts + 1, badVersions());
                }
                return use(current, meta.getProperty("label", String.valueOf(version)));
            } catch (IOException | RuntimeException error) {
                return use(null, bundledLabel);
            }
        }
    }

    private File use(File folder, String label) {
        servingRoot = folder;
        servingLabel = label;
        return folder;
    }

    /** The page started successfully: the update being served is good. */
    void confirm() {
        synchronized (lock) {
            try {
                Properties state = readProps(new File(root, "state.properties"));
                if (!"1".equals(state.getProperty("confirmed", "0"))) writeState(true, 0, badVersions());
            } catch (IOException | RuntimeException ignored) {
                // The next launch simply counts another attempt.
            }
        }
    }

    String activeLabel() { synchronized (lock) { return servingLabel; } }

    /** Label of a downloaded update waiting for the next page load, or null. */
    String pendingLabel() {
        synchronized (lock) {
            File pending = new File(root, "pending");
            if (!pending.isDirectory()) return null;
            try { return readProps(new File(pending, "meta.properties")).getProperty("label"); }
            catch (IOException error) { return null; }
        }
    }

    // ------------------------------------------------------------------ checking

    /** Looks for an update and, if there is a newer valid one, downloads and stages it. */
    Result check() {
        try {
            byte[] manifestBytes = http.get("manifest.txt?t=" + System.currentTimeMillis() / 60000, 64 * 1024);
            byte[] signature = http.get("manifest.txt.sig?t=" + System.currentTimeMillis() / 60000, 1024);
            if (!verify(manifestBytes, Base64.getMimeDecoder().decode(new String(signature, StandardCharsets.US_ASCII).trim()))) {
                return new Result("error", "The update's signature is not valid.");
            }
            Manifest manifest = parse(manifestBytes);
            File reuseFrom;
            long activeVersion;
            synchronized (lock) {
                reuseFrom = servingRoot;
                activeVersion = Math.max(bundledVersion, Math.max(version(new File(root, "current")), version(new File(root, "pending"))));
                if (manifest.version <= activeVersion || badVersions().contains(manifest.version)) {
                    return new Result("current", activeLabelLocked());
                }
            }
            if (manifest.minApk > apkVersion) return new Result("needs-apk", manifest.label);

            File staging = new File(root, "staging");
            deleteTree(staging);
            if (!staging.mkdirs()) throw new IOException("Could not create the update folder");
            boolean changed = false;
            for (Entry entry : manifest.files.values()) {
                byte[] data = reusable(entry, reuseFrom);
                if (data == null) {
                    changed = true;
                    data = http.get("files/" + entry.path, entry.size + 1);
                }
                if (data.length != entry.size || !entry.hash.equals(sha256(data))) {
                    deleteTree(staging);
                    return new Result("error", "A downloaded file did not match the signed list.");
                }
                File target = new File(staging, entry.path);
                File parent = target.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("Could not create a folder");
                Files.write(target.toPath(), data);
            }
            if (!changed) {
                // Same files as the ones already running: nothing to restart for.
                deleteTree(staging);
                return new Result("current", activeLabel());
            }
            Properties meta = new Properties();
            meta.setProperty("version", String.valueOf(manifest.version));
            meta.setProperty("label", manifest.label);
            meta.setProperty("minApk", String.valueOf(manifest.minApk));
            writeProps(new File(staging, "meta.properties"), meta);
            synchronized (lock) {
                File pending = new File(root, "pending");
                deleteTree(pending);
                Files.move(staging.toPath(), pending.toPath(), StandardCopyOption.ATOMIC_MOVE);
            }
            return new Result("ready", manifest.label);
        } catch (IOException | GeneralSecurityException | RuntimeException error) {
            return new Result("error", "Could not check for updates.");
        }
    }

    private String activeLabelLocked() { return servingLabel; }

    /** The bytes of a file the running version already has, if they are identical to the new one. */
    private byte[] reusable(Entry entry, File from) {
        try {
            byte[] data = null;
            if (from != null) {
                File file = new File(from, entry.path);
                if (file.isFile() && file.length() == entry.size) data = Files.readAllBytes(file.toPath());
            } else {
                data = readAll(assets.open("web/" + entry.path), MAX_FILE);
            }
            return data != null && data.length == entry.size && entry.hash.equals(sha256(data)) ? data : null;
        } catch (IOException | GeneralSecurityException | RuntimeException error) {
            return null;
        }
    }

    private boolean verify(byte[] data, byte[] signature) throws GeneralSecurityException {
        Signature verifier = Signature.getInstance("SHA256withECDSA");
        verifier.initVerify(key);
        verifier.update(data);
        return verifier.verify(signature);
    }

    /**
     * Manifest format (UTF-8, one item per line):
     *   geoziptag-ota 1 / version N / label TEXT / min-apk N / file SHA256 SIZE PATH ...
     */
    private static Manifest parse(byte[] bytes) throws IOException {
        String[] lines = new String(bytes, StandardCharsets.UTF_8).split("\n");
        if (lines.length < 5 || !"geoziptag-ota 1".equals(lines[0])) throw new IOException("Unknown update format");
        Manifest manifest = new Manifest();
        boolean haveVersion = false, haveLabel = false, haveMinApk = false;
        long total = 0;
        for (int i = 1; i < lines.length; i++) {
            String line = lines[i];
            if (line.isEmpty()) continue;
            String[] part = line.split(" ", -1);
            if (part[0].equals("version") && part.length == 2 && !haveVersion) {
                manifest.version = Long.parseLong(part[1]);
                haveVersion = manifest.version > 0;
            } else if (part[0].equals("label") && part.length == 2 && !haveLabel && LABEL.matcher(part[1]).matches()) {
                manifest.label = part[1];
                haveLabel = true;
            } else if (part[0].equals("min-apk") && part.length == 2 && !haveMinApk) {
                manifest.minApk = Long.parseLong(part[1]);
                haveMinApk = manifest.minApk >= 0;
            } else if (part[0].equals("file") && part.length == 4) {
                long size = Long.parseLong(part[2]);
                String path = part[3];
                if (!HEX64.matcher(part[1]).matches() || size < 0 || size > MAX_FILE || !isWebPath("/" + path)
                        || manifest.files.containsKey(path) || manifest.files.size() >= MAX_FILES) {
                    throw new IOException("Invalid file entry");
                }
                total += size;
                manifest.files.put(path, new Entry(part[1], size, path));
            } else {
                throw new IOException("Unexpected line in the update list");
            }
        }
        if (!haveVersion || !haveLabel || !haveMinApk || !manifest.files.containsKey("index.html") || total > MAX_TOTAL) {
            throw new IOException("Incomplete update list");
        }
        return manifest;
    }

    // ------------------------------------------------------------------ state on disk

    private Set<Long> badVersions() throws IOException {
        Set<Long> bad = new HashSet<>();
        String list = readProps(new File(root, "state.properties")).getProperty("bad", "");
        for (String item : list.split(",")) {
            if (!item.trim().isEmpty()) bad.add(Long.parseLong(item.trim()));
        }
        return bad;
    }

    private void writeState(boolean confirmed, int attempts, Set<Long> bad) throws IOException {
        Properties state = new Properties();
        state.setProperty("confirmed", confirmed ? "1" : "0");
        state.setProperty("attempts", String.valueOf(attempts));
        StringBuilder list = new StringBuilder();
        for (long version : bad) list.append(list.length() == 0 ? "" : ",").append(version);
        state.setProperty("bad", list.toString());
        if (!root.isDirectory() && !root.mkdirs()) throw new IOException("Could not create the update folder");
        writeProps(new File(root, "state.properties"), state);
    }

    private static long version(File bundle) {
        try { return longOf(readProps(new File(bundle, "meta.properties")), "version"); }
        catch (IOException | RuntimeException error) { return 0; }
    }

    private static long longOf(Properties props, String name) {
        try { return Long.parseLong(props.getProperty(name, "0").trim()); }
        catch (NumberFormatException error) { return 0; }
    }

    private static Properties readProps(File file) throws IOException {
        Properties props = new Properties();
        if (file.isFile()) {
            try (InputStream in = Files.newInputStream(file.toPath())) { props.load(in); }
        }
        return props;
    }

    private static void writeProps(File file, Properties props) throws IOException {
        File temp = new File(file.getPath() + ".tmp");
        try (java.io.OutputStream out = Files.newOutputStream(temp.toPath())) { props.store(out, null); }
        Files.move(temp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING);
    }

    private static void deleteTree(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        file.delete();
    }

    static byte[] readAll(InputStream in, long max) throws IOException {
        try (InputStream stream = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[16384];
            int read;
            while ((read = stream.read(buffer)) != -1) {
                out.write(buffer, 0, read);
                if (out.size() > max) throw new IOException("Too large");
            }
            return out.toByteArray();
        }
    }

    private static String sha256(byte[] data) throws GeneralSecurityException {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(data);
        StringBuilder hex = new StringBuilder();
        for (byte b : digest) hex.append(String.format("%02x", b));
        return hex.toString();
    }

    /** Downloads over HTTPS only, with timeouts and a size limit. */
    static final class HttpsFetcher implements Http {
        private final String base;

        HttpsFetcher(String base) { this.base = base.endsWith("/") ? base : base + "/"; }

        @Override public byte[] get(String relativePath, long maxBytes) throws IOException {
            URL url = new URL(base + relativePath);
            if (!"https".equals(url.getProtocol())) throw new IOException("HTTPS is required");
            HttpURLConnection connection = (HttpURLConnection) url.openConnection();
            try {
                connection.setConnectTimeout(8000);
                connection.setReadTimeout(20000);
                connection.setUseCaches(false);
                connection.setRequestProperty("User-Agent", "GeoZipTag-updater");
                if (connection.getResponseCode() != 200) throw new IOException("HTTP " + connection.getResponseCode());
                if (connection.getContentLengthLong() > maxBytes) throw new IOException("Too large");
                return readAll(connection.getInputStream(), maxBytes);
            } finally {
                connection.disconnect();
            }
        }
    }
}
