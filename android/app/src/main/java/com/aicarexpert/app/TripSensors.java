package com.aicarexpert.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.view.WindowManager;
import android.os.Bundle;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;

@CapacitorPlugin(name = "TripSensors", permissions = @Permission(
    alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }
))
public class TripSensors extends Plugin implements SensorEventListener, LocationListener {
    private final float[] frame = new float[9];
    private final float[] rotation = new float[3];
    private SensorManager sensors;
    private LocationManager location;
    private boolean active;
    private boolean gps;
    private boolean hudAwake;
    private boolean oriented;
    private boolean rotating;
    private long last;

    @PluginMethod
    public void start(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            deactivate();
            sensors = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
            Sensor attitude = sensors.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR);
            if (attitude == null) attitude = sensors.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
            Sensor acceleration = sensors.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION);
            if (acceleration == null) acceleration = sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
            Sensor gyro = sensors.getDefaultSensor(Sensor.TYPE_GYROSCOPE);
            boolean registered = attitude != null && acceleration != null && gyro != null
                && (sensors.registerListener(this, attitude, 50_000)
                & sensors.registerListener(this, acceleration, 50_000)
                & sensors.registerListener(this, gyro, 50_000));
            if (!registered) {
                sensors.unregisterListener(this);
                if (!Boolean.TRUE.equals(call.getBoolean("allowGpsOnly", false))) {
                    call.reject("Датчики движения недоступны");
                    return;
                }
            }
            active = true;
            gps = Boolean.TRUE.equals(call.getBoolean("gps", false));
            keepScreen();
            call.resolve();
        });
    }

    @PluginMethod
    public void startGps(PluginCall call) {
        gps = true;
        if (getPermissionState("location") != PermissionState.GRANTED) {
            requestPermissionForAlias("location", call, "locationPermission");
            return;
        }
        locationPermission(call);
    }

    @PluginMethod
    public void stopGps(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            gps = false;
            if (location != null) location.removeUpdates(this);
            call.resolve();
        });
    }

    @PermissionCallback
    private void locationPermission(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!active || !gps || getPermissionState("location") != PermissionState.GRANTED) {
                call.reject("Точная геолокация недоступна");
                return;
            }
            try {
                location = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
                location.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000, 0, this);
                call.resolve();
            } catch (RuntimeException e) {
                call.reject("Не удалось запустить GPS", e);
            }
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            deactivate();
            call.resolve();
        });
    }

    private void deactivate() {
        active = false;
        keepScreen();
        oriented = false;
        rotating = false;
        last = 0;
        if (sensors != null) sensors.unregisterListener(this);
        if (location != null) location.removeUpdates(this);
    }

    @Override
    protected void handleOnStop() {
        hudAwake = false;
        deactivate();
    }

    private void keepScreen() {
        if (active || hudAwake) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    @PluginMethod
    public void setHudAwake(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            hudAwake = Boolean.TRUE.equals(call.getBoolean("enabled", false));
            keepScreen();
            call.resolve();
        });
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        if (!active) return;
        switch (event.sensor.getType()) {
            case Sensor.TYPE_ROTATION_VECTOR:
            case Sensor.TYPE_GAME_ROTATION_VECTOR:
                SensorManager.getRotationMatrixFromVector(frame, event.values);
                oriented = true;
                break;
            case Sensor.TYPE_GYROSCOPE:
                System.arraycopy(event.values, 0, rotation, 0, 3);
                rotating = true;
                break;
            case Sensor.TYPE_ACCELEROMETER:
            case Sensor.TYPE_LINEAR_ACCELERATION:
                if (!oriented || !rotating || (last != 0 && event.timestamp - last < 45_000_000)) return;
                last = event.timestamp;
                JSObject m = new JSObject();
                m.put("at", System.currentTimeMillis() - (android.os.SystemClock.elapsedRealtimeNanos() - event.timestamp) / 1_000_000L);
                m.put("x", project(0, event.values));
                m.put("y", project(1, event.values));
                m.put("yawRate", -Math.toDegrees(project(2, rotation)));
                JSONArray orientation = new JSONArray();
                for (float v : frame) orientation.put(Float.valueOf(v));
                m.put("orientation", orientation);
                notifyListeners("motion", m);
                break;
            default:
                break;
        }
    }

    private double project(int axis, float[] vector) {
        int i = axis * 3;
        return frame[i] * vector[0] + frame[i + 1] * vector[1] + frame[i + 2] * vector[2];
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {}

    @Override
    public void onLocationChanged(Location fix) {
        if (!active || !gps || (android.os.Build.VERSION.SDK_INT >= 31 ? fix.isMock() : fix.isFromMockProvider())) return;
        JSObject m = new JSObject();
        m.put("at", fix.getTime());
        m.put("lat", fix.getLatitude());
        m.put("lon", fix.getLongitude());
        m.put("accuracy", fix.hasAccuracy() ? fix.getAccuracy() : -1);
        if (fix.hasSpeed()) m.put("speed", fix.getSpeed());
        if (fix.hasBearing()) m.put("course", fix.getBearing());
        if (android.os.Build.VERSION.SDK_INT >= 26) {
            if (fix.hasSpeedAccuracy()) m.put("speedAccuracy", fix.getSpeedAccuracyMetersPerSecond());
            if (fix.hasVerticalAccuracy()) m.put("verticalAccuracy", fix.getVerticalAccuracyMeters());
            if (fix.hasBearingAccuracy()) m.put("courseAccuracy", fix.getBearingAccuracyDegrees());
        }
        notifyListeners("gps", m);
    }

    @Override public void onProviderEnabled(String provider) {}
    @Override public void onProviderDisabled(String provider) {}
    @Override public void onStatusChanged(String provider, int status, Bundle extras) {}

    @PluginMethod
    public void exportTrip(PluginCall call) {
        String data = call.getString("data");
        if (data == null) {
            call.reject("Нет записи для экспорта");
            return;
        }
        try {
            File file = File.createTempFile("ai-car-trip-", ".json", getContext().getCacheDir());
            try (FileOutputStream out = new FileOutputStream(file)) {
                out.write(data.getBytes(StandardCharsets.UTF_8));
            }
            var uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
            Intent send = new Intent(Intent.ACTION_SEND).setType("application/json")
                .putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().runOnUiThread(() -> {
                getActivity().startActivity(Intent.createChooser(send, "Экспорт поездки"));
                call.resolve();
            });
        } catch (Exception e) {
            call.reject("Не удалось подготовить экспорт", e);
        }
    }
}
