package com.fileshare.floating;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.ValueCallback;

import java.util.ArrayList;

public class FilePickerActivity extends Activity {
    private static final int PICK_FILE_REQUEST = 4701;
    private static ValueCallback<Uri[]> pendingCallback;

    public static void open(Activity activity, ValueCallback<Uri[]> callback, boolean fromService) {
        if (pendingCallback != null) pendingCallback.onReceiveValue(null);
        pendingCallback = callback;
        Intent intent = new Intent(activity, FilePickerActivity.class);
        if (fromService) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        activity.startActivity(intent);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        pick.addCategory(Intent.CATEGORY_OPENABLE);
        pick.setType("*/*");
        pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        try {
            startActivityForResult(pick, PICK_FILE_REQUEST);
        } catch (Exception error) {
            deliver(null);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != PICK_FILE_REQUEST) return;
        Uri[] selected = null;
        if (resultCode == RESULT_OK && data != null) {
            ArrayList<Uri> uris = new ArrayList<>();
            ClipData clip = data.getClipData();
            if (clip != null) {
                for (int i = 0; i < clip.getItemCount(); i++) {
                    Uri uri = clip.getItemAt(i).getUri();
                    if (uri != null) uris.add(uri);
                }
            }
            if (uris.isEmpty() && data.getData() != null) uris.add(data.getData());
            if (!uris.isEmpty()) selected = uris.toArray(new Uri[0]);
        }
        deliver(selected);
    }

    private void deliver(Uri[] uris) {
        ValueCallback<Uri[]> callback = pendingCallback;
        pendingCallback = null;
        if (callback != null) callback.onReceiveValue(uris);
        finish();
    }
}
