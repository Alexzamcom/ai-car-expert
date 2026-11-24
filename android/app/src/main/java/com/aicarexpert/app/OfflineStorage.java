package com.aicarexpert.app;

import android.os.StatFs;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "OfflineStorage")
public class OfflineStorage extends Plugin {
    @PluginMethod
    public void capacity(PluginCall call) {
        try {
            StatFs disk = new StatFs(getContext().getFilesDir().getAbsolutePath());
            JSObject result = new JSObject();
            result.put("availableBytes", disk.getAvailableBytes());
            call.resolve(result);
        } catch (RuntimeException e) {
            call.reject("Could not read free device storage", e);
        }
    }
}
