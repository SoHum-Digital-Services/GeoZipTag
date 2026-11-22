package com.geostampcam.mobile;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileNotFoundException;
import java.util.List;

public final class CacheImageProvider extends ContentProvider {
    private static final String AUTHORITY = "com.geostampcam.mobile.images";

    static Uri uriFor(String folder, String name) {
        return new Uri.Builder().scheme("content").authority(AUTHORITY)
                .appendPath(folder).appendPath(name).build();
    }

    static File folder(Context context, String name) {
        File directory = new File(context.getCacheDir(), name);
        directory.mkdirs();
        return directory;
    }

    private File fileFor(Uri uri) {
        List<String> parts = uri.getPathSegments();
        if (parts.size() != 2 || !parts.get(0).matches("captured|shared")
                || !parts.get(1).matches("[A-Za-z0-9_-]{1,110}\\.jpg")) {
            throw new IllegalArgumentException("Invalid image URI");
        }
        return new File(folder(getContext(), parts.get(0)), parts.get(1));
    }

    @Override public boolean onCreate() { return true; }
    @Override public String getType(Uri uri) { return "image/jpeg"; }

    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        File file = fileFor(uri);
        boolean writable = "captured".equals(uri.getPathSegments().get(0));
        if (!"r".equals(mode) && !writable) throw new FileNotFoundException("Read only");
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.parseMode(mode));
    }

    @Override public Cursor query(Uri uri, String[] projection, String selection,
            String[] selectionArgs, String sortOrder) {
        File file = fileFor(uri);
        String[] columns = projection == null
                ? new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE} : projection;
        MatrixCursor cursor = new MatrixCursor(columns);
        Object[] values = new Object[columns.length];
        for (int index = 0; index < columns.length; index++) {
            if (OpenableColumns.DISPLAY_NAME.equals(columns[index])) values[index] = file.getName();
            if (OpenableColumns.SIZE.equals(columns[index])) values[index] = file.length();
        }
        cursor.addRow(values);
        return cursor;
    }

    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) {
        throw new UnsupportedOperationException();
    }
    @Override public int delete(Uri uri, String selection, String[] args) {
        throw new UnsupportedOperationException();
    }
}
