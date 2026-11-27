package com.geostampcam.mobile;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Tests OtaUpdater on a plain JVM against a site built by tools/ota/publish.mjs.
 * Usage: OtaUpdaterTest <site dir> <private key pem> <public key b64> <web dir>
 */
public final class OtaUpdaterTest {
    private static int failures, passes;
    private static PrivateKey signingKey;
    private static PublicKey publicKey;

    private static void check(String name, boolean ok) {
        if (ok) passes++; else failures++;
        System.out.println((ok ? "PASS " : "FAIL ") + name);
    }

    /** Serves a signed update straight from memory, counting the files that get downloaded. */
    static final class FakeHttp implements OtaUpdater.Http {
        final Map<String, byte[]> files = new HashMap<>();
        final List<String> downloads = new ArrayList<>();
        boolean offline;

        @Override public byte[] get(String path, long max) throws IOException {
            if (offline) throw new IOException("offline");
            String clean = path.contains("?") ? path.substring(0, path.indexOf('?')) : path;
            byte[] body = files.get(clean);
            if (body == null) throw new IOException("HTTP 404");
            if (body.length > max) throw new IOException("Too large");
            if (clean.startsWith("files/")) downloads.add(clean.substring(6));
            return body;
        }
    }

    static String sha256(byte[] data) throws Exception {
        StringBuilder hex = new StringBuilder();
        for (byte b : MessageDigest.getInstance("SHA-256").digest(data)) hex.append(String.format("%02x", b));
        return hex.toString();
    }

    static byte[] sign(byte[] manifest, PrivateKey key) throws Exception {
        Signature s = Signature.getInstance("SHA256withECDSA");
        s.initSign(key);
        s.update(manifest);
        return (Base64.getEncoder().encodeToString(s.sign()) + "\n").getBytes(StandardCharsets.US_ASCII);
    }

    /** Builds a signed update from the given file contents. */
    static FakeHttp update(long version, long minApk, Map<String, byte[]> content) throws Exception {
        return update(version, minApk, content, signingKey);
    }

    static FakeHttp update(long version, long minApk, Map<String, byte[]> content, PrivateKey key) throws Exception {
        FakeHttp http = new FakeHttp();
        StringBuilder text = new StringBuilder("geoziptag-ota 1\nversion " + version + "\nlabel v" + version + "\nmin-apk " + minApk + "\n");
        for (Map.Entry<String, byte[]> file : content.entrySet()) {
            text.append("file ").append(sha256(file.getValue())).append(' ').append(file.getValue().length).append(' ').append(file.getKey()).append('\n');
            http.files.put("files/" + file.getKey(), file.getValue());
        }
        byte[] manifest = text.toString().getBytes(StandardCharsets.UTF_8);
        http.files.put("manifest.txt", manifest);
        http.files.put("manifest.txt.sig", sign(manifest, key));
        return http;
    }

    static Map<String, byte[]> files(String html, String js) {
        Map<String, byte[]> map = new java.util.TreeMap<>();
        map.put("index.html", html.getBytes(StandardCharsets.UTF_8));
        map.put("camera.js", js.getBytes(StandardCharsets.UTF_8));
        map.put("style.css", "body{}".getBytes(StandardCharsets.UTF_8));
        return map;
    }

    static File temp() throws IOException { return Files.createTempDirectory("ota-test").toFile(); }

    static OtaUpdater updater(File root, OtaUpdater.Http http, long apk, long bundled) {
        OtaUpdater.Assets assets = path -> {
            switch (path) {
                case "web/index.html": return new java.io.ByteArrayInputStream("<html>bundled</html>".getBytes(StandardCharsets.UTF_8));
                case "web/camera.js": return new java.io.ByteArrayInputStream("bundled js".getBytes(StandardCharsets.UTF_8));
                case "web/style.css": return new java.io.ByteArrayInputStream("body{}".getBytes(StandardCharsets.UTF_8));
                default: throw new IOException("missing " + path);
            }
        };
        return new OtaUpdater(root, assets, http, publicKey, apk, bundled, "bundled");
    }

    static String read(File file) throws IOException { return new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8); }

    public static void main(String[] args) throws Exception {
        Path site = Paths.get(args[0]);
        String pem = new String(Files.readAllBytes(Paths.get(args[1])), StandardCharsets.US_ASCII)
                .replaceAll("-----[A-Z ]+-----", "").replaceAll("\\s", "");
        signingKey = KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(Base64.getDecoder().decode(pem)));
        publicKey = OtaUpdater.parseKey(new String(Files.readAllBytes(Paths.get(args[2])), StandardCharsets.US_ASCII));
        System.out.println("--- real site built by publish.mjs");
        realSite(site, Paths.get(args[3]));
        System.out.println("--- update flow");
        flow();
        System.out.println("--- attacks and failures");
        attacks();
        System.out.println("--- rollback and bookkeeping");
        rollback();
        System.out.println("\n" + passes + " passed, " + failures + " failed");
        System.exit(failures == 0 ? 0 : 1);
    }

    static void realSite(Path site, Path webDir) throws Exception {
        FakeHttp http = new FakeHttp();
        Path ota = site.resolve("ota");
        try (java.util.stream.Stream<Path> walk = Files.walk(ota)) {
            for (Path p : (Iterable<Path>) walk.filter(Files::isRegularFile)::iterator) {
                http.files.put(ota.relativize(p).toString().replace('\\', '/'), Files.readAllBytes(p));
            }
        }
        File root = temp();
        // The "installed" app has an older camera.js and style.css, so the update has real work to do.
        Path older = Files.createTempDirectory("ota-older");
        try (java.util.stream.Stream<Path> walk = Files.walk(webDir)) {
            for (Path p : (Iterable<Path>) walk.filter(Files::isRegularFile)::iterator) {
                Path target = older.resolve(webDir.relativize(p).toString());
                Files.createDirectories(target.getParent());
                byte[] data = Files.readAllBytes(p);
                if (p.getFileName().toString().equals("camera.js") || p.getFileName().toString().equals("style.css")) data = (new String(data, StandardCharsets.UTF_8) + "\n// older").getBytes(StandardCharsets.UTF_8);
                Files.write(target, data);
            }
        }
        OtaUpdater.Assets assets = path -> Files.newInputStream(older.resolve(path.substring(4)));   // strip "web/"
        OtaUpdater u = new OtaUpdater(root, assets, http, publicKey, 10, 1, "bundled");
        OtaUpdater.Result r = u.check();
        check("real published site: update verifies, downloads and stages (" + r.state + " " + r.detail + ")", r.state.equals("ready"));
        if (r.state.equals("ready")) {
            File served = u.servingRoot();
            check("real site: promoted bundle is served", served != null && new File(served, "index.html").isFile());
            boolean same = true;
            for (String name : new String[]{"index.html", "camera.js", "style.css"}) {
                same &= java.util.Arrays.equals(Files.readAllBytes(webDir.resolve(name)), Files.readAllBytes(new File(served, name).toPath()));
            }
            check("real site: served files are byte-identical to the app's web files", same);
            check("real site: downloaded only the 2 changed files (" + http.downloads + ")", http.downloads.size() == 2);
        }
    }

    static void flow() throws Exception {
        File root = temp();
        FakeHttp http = update(100, 5, files("<html>v100</html>", "js 100"));
        OtaUpdater u = updater(root, http, 9, 50);
        check("before any update the bundled files are served", u.servingRoot() == null && u.activeLabel().equals("bundled"));
        OtaUpdater.Result r = u.check();
        check("newer signed update is downloaded and staged", r.state.equals("ready") && r.detail.equals("v100"));
        check("only the files that differ from the bundle are downloaded (index.html, camera.js)", http.downloads.size() == 2 && !http.downloads.contains("style.css"));
        check("staged update is NOT served until the next page load", u.pendingLabel() != null && u.activeLabel().equals("bundled"));
        File served = u.servingRoot();
        check("next page load serves the new version", served != null && read(new File(served, "index.html")).contains("v100") && u.activeLabel().equals("v100"));
        check("pending slot is empty after promotion", u.pendingLabel() == null);
        u.confirm();
        OtaUpdater again = updater(root, http, 9, 50);
        check("a new process keeps serving the confirmed update", again.servingRoot() != null && again.activeLabel().equals("v100"));
        check("checking again: already current", again.check().state.equals("current"));
        FakeHttp next = update(101, 5, files("<html>v101</html>", "js 100"));
        OtaUpdater.Result r2 = again.check();
        check("same version offered again does nothing", r2.state.equals("current"));
        OtaUpdater third = updater(root, next, 9, 50);
        third.servingRoot();
        OtaUpdater.Result r3 = third.check();
        check("next update reuses the unchanged files (only index.html downloaded)", r3.state.equals("ready") && next.downloads.size() == 1 && next.downloads.get(0).equals("index.html"));
        FakeHttp identical = update(102, 5, files("<html>v101</html>", "js 100"));
        OtaUpdater fourth = updater(root, identical, 9, 50);
        File promoted = fourth.servingRoot();
        check("(setup) pending v101 promoted", promoted != null && fourth.activeLabel().equals("v101"));
        OtaUpdater.Result r4 = fourth.check();
        check("newer version with identical files: no restart prompt", r4.state.equals("current") && identical.downloads.isEmpty());
        FakeHttp offline = update(103, 5, files("x", "y"));
        offline.offline = true;
        check("offline: reports an error and changes nothing", updater(root, offline, 9, 50).check().state.equals("error"));
        FakeHttp needsApk = update(200, 99, files("<html>needs new apk</html>", "js"));
        check("update that needs a newer app is not installed", updater(root, needsApk, 9, 50).check().state.equals("needs-apk") && needsApk.downloads.isEmpty());
        File newApk = temp();
        OtaUpdater withNewApk = updater(newApk, update(300, 5, files("a", "b")), 9, 400);
        check("update older than the files bundled in the APK is ignored", withNewApk.check().state.equals("current"));
        // New APK with newer bundled web files than a downloaded update: the downloaded copy is discarded.
        OtaUpdater upgraded = updater(root, http, 9, 500);
        check("installing a newer APK drops the older downloaded update", upgraded.servingRoot() == null && !new File(root, "current").exists());
    }

    static void attacks() throws Exception {
        Map<String, byte[]> good = files("<html>evil?</html>", "js");
        // 1. tampered file
        FakeHttp tampered = update(100, 0, good);
        tampered.files.put("files/camera.js", "alert('hacked')".getBytes(StandardCharsets.UTF_8));
        File r1 = temp(); OtaUpdater u1 = updater(r1, tampered, 9, 1);
        check("file changed after signing is rejected", u1.check().state.equals("error") && u1.pendingLabel() == null && u1.servingRoot() == null);
        // 2. tampered manifest
        FakeHttp forgedManifest = update(100, 0, good);
        forgedManifest.files.put("manifest.txt", new String(forgedManifest.files.get("manifest.txt"), StandardCharsets.UTF_8).replace("version 100", "version 999").getBytes(StandardCharsets.UTF_8));
        check("edited manifest fails the signature", updater(temp(), forgedManifest, 9, 1).check().state.equals("error"));
        // 3. signed by somebody else
        java.security.KeyPairGenerator generator = java.security.KeyPairGenerator.getInstance("EC");
        generator.initialize(new java.security.spec.ECGenParameterSpec("secp256r1"));
        FakeHttp stranger = update(100, 0, good, generator.generateKeyPair().getPrivate());
        check("update signed with a different key is rejected", updater(temp(), stranger, 9, 1).check().state.equals("error"));
        // 4. missing / garbage signature
        FakeHttp noSig = update(100, 0, good); noSig.files.put("manifest.txt.sig", "AAAA\n".getBytes(StandardCharsets.US_ASCII));
        check("garbage signature is rejected", updater(temp(), noSig, 9, 1).check().state.equals("error"));
        FakeHttp missingSig = update(100, 0, good); missingSig.files.remove("manifest.txt.sig");
        check("missing signature is rejected", updater(temp(), missingSig, 9, 1).check().state.equals("error"));
        // 5. validly signed but malicious manifests (the signer is trusted, the format must still be safe)
        for (String bad : new String[]{"../../evil.js", "/etc/passwd", "assets/..%2Fx.png", "vendor/../camera.js", "native.so", "assets/UPPER.png", "assets/a/b.png", "index.html/../x"}) {
            Map<String, byte[]> m = files("<html>x</html>", "js");
            FakeHttp h = update(100, 0, m);
            String text = new String(h.files.get("manifest.txt"), StandardCharsets.UTF_8) + "file " + sha256("x".getBytes()) + " 1 " + bad + "\n";
            h.files.put("manifest.txt", text.getBytes(StandardCharsets.UTF_8));
            h.files.put("manifest.txt.sig", sign(text.getBytes(StandardCharsets.UTF_8), signingKey));
            h.files.put("files/" + bad, "x".getBytes());
            OtaUpdater u = updater(temp(), h, 9, 1);
            check("path '" + bad + "' in a signed manifest is refused", u.check().state.equals("error") && u.pendingLabel() == null);
        }
        Map<String, byte[]> noIndex = new java.util.TreeMap<>(); noIndex.put("camera.js", "js".getBytes());
        check("manifest without index.html is refused", updater(temp(), update(100, 0, noIndex), 9, 1).check().state.equals("error"));
        FakeHttp dup = update(100, 0, good); String dupText = new String(dup.files.get("manifest.txt"), StandardCharsets.UTF_8) + "file " + sha256("<html>evil?</html>".getBytes()) + " 18 index.html\n";
        dup.files.put("manifest.txt", dupText.getBytes(StandardCharsets.UTF_8)); dup.files.put("manifest.txt.sig", sign(dupText.getBytes(StandardCharsets.UTF_8), signingKey));
        check("duplicate file entries are refused", updater(temp(), dup, 9, 1).check().state.equals("error"));
        FakeHttp junk = update(100, 0, good); String junkText = new String(junk.files.get("manifest.txt"), StandardCharsets.UTF_8) + "run rm -rf /\n";
        junk.files.put("manifest.txt", junkText.getBytes(StandardCharsets.UTF_8)); junk.files.put("manifest.txt.sig", sign(junkText.getBytes(StandardCharsets.UTF_8), signingKey));
        check("unknown lines in the manifest are refused", updater(temp(), junk, 9, 1).check().state.equals("error"));
        FakeHttp wrongFormat = update(100, 0, good); String fmt = new String(wrongFormat.files.get("manifest.txt"), StandardCharsets.UTF_8).replace("geoziptag-ota 1", "geoziptag-ota 2");
        wrongFormat.files.put("manifest.txt", fmt.getBytes(StandardCharsets.UTF_8)); wrongFormat.files.put("manifest.txt.sig", sign(fmt.getBytes(StandardCharsets.UTF_8), signingKey));
        check("unknown manifest format is refused", updater(temp(), wrongFormat, 9, 1).check().state.equals("error"));
        // 6. server sends more or less data than the signed size
        FakeHttp longer = update(100, 0, good); longer.files.put("files/camera.js", "js and a lot more".getBytes());
        check("file longer than its signed size is rejected", updater(temp(), longer, 9, 1).check().state.equals("error"));
        FakeHttp shorter = update(100, 0, good); shorter.files.put("files/camera.js", "j".getBytes());
        check("truncated file is rejected", updater(temp(), shorter, 9, 1).check().state.equals("error"));
        // 7. downgrade / replay of an old signed update
        File root = temp();
        FakeHttp v200 = update(200, 0, files("<html>v200</html>", "js200"));
        OtaUpdater u = updater(root, v200, 9, 1);
        u.check(); u.servingRoot(); u.confirm();
        FakeHttp v150 = update(150, 0, files("<html>v150</html>", "js150"));
        OtaUpdater replay = updater(root, v150, 9, 1);
        replay.servingRoot();
        check("replaying an older signed update is ignored", replay.check().state.equals("current") && replay.activeLabel().equals("v200") && v150.downloads.isEmpty());
        // 8. a failed download must not disturb the running version
        FakeHttp half = update(300, 0, files("<html>v300</html>", "js300")); half.files.remove("files/camera.js");
        OtaUpdater h = updater(root, half, 9, 1); h.servingRoot();
        check("update with a missing file fails cleanly", h.check().state.equals("error") && h.pendingLabel() == null && read(new File(h.servingRoot(), "index.html")).contains("v200"));
    }

    static void rollback() throws Exception {
        File root = temp();
        FakeHttp http = update(100, 0, files("<html>broken</html>", "throws at startup"));
        OtaUpdater first = updater(root, http, 9, 1);
        first.check();
        check("launch 1: broken update is served", first.servingRoot() != null);
        // The page never calls confirm(): the app crashed before finishing startup.
        check("launch 2 (no confirmation yet): tried once more", updater(root, http, 9, 1).servingRoot() != null);
        OtaUpdater third = updater(root, http, 9, 1);
        check("launch 3: rolled back to the bundled files", third.servingRoot() == null && third.activeLabel().equals("bundled") && !new File(root, "current").exists());
        check("the failed version is not downloaded again", third.check().state.equals("current") && http.downloads.size() == 2);
        FakeHttp fixed = update(101, 0, files("<html>fixed</html>", "works"));
        OtaUpdater fourth = updater(root, fixed, 9, 1);
        fourth.servingRoot();
        check("a newer fixed version is accepted after a rollback", fourth.check().state.equals("ready"));
        File served = fourth.servingRoot();
        fourth.confirm();
        check("confirmed version survives many launches", served != null && updater(root, fixed, 9, 1).servingRoot() != null && updater(root, fixed, 9, 1).servingRoot() != null && updater(root, fixed, 9, 1).servingRoot() != null);
        check("isWebPath only allows the app's own files", OtaUpdater.isWebPath("/index.html") && OtaUpdater.isWebPath("/assets/app-icon.png") && !OtaUpdater.isWebPath("/../x") && !OtaUpdater.isWebPath("/ota-public-key.b64") && !OtaUpdater.isWebPath("/assets/../a.png") && !OtaUpdater.isWebPath(null));
    }
}
