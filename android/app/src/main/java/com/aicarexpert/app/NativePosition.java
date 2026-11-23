package com.aicarexpert.app;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Bundle;
import android.os.Looper;
import android.os.SystemClock;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;
import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

@CapacitorPlugin(name = "NativePosition", permissions = @Permission(
    alias = "position", strings = { Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION }
))
public class NativePosition extends Plugin implements LocationListener, SensorEventListener {
    private LocationManager manager;
    private FusedLocationProviderClient fused;
    private SensorManager sensors;
    private boolean active;
    private boolean oriented;
    private boolean earthFrame;
    private long lastMotion;
    private long accelerationAt;
    private double east;
    private double north;
    private final float[] matrix = new float[9];
    private final float[] gyro = new float[3];
    private final LocationCallback fusedCallback = new LocationCallback() {
        @Override
        public void onLocationResult(LocationResult result) {
            for (Location location : result.getLocations()) emit(location, "fused");
        }
    };

    @PluginMethod
    public void start(PluginCall call) {
        final boolean ask = Boolean.TRUE.equals(call.getBoolean("ask", true));
        if (!permitted(Manifest.permission.ACCESS_COARSE_LOCATION) && !permitted(Manifest.permission.ACCESS_FINE_LOCATION)) {
            if (ask) requestPermissionForAlias("position", call, "positionPermission");
            else call.reject("Разрешите местоположение", "DENIED");
            return;
        }
        positionPermission(call);
    }

    private boolean permitted(String permission) {
        return ContextCompat.checkSelfPermission(getContext(), permission) == PackageManager.PERMISSION_GRANTED;
    }

    @PermissionCallback
    private void positionPermission(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!permitted(Manifest.permission.ACCESS_COARSE_LOCATION) && !permitted(Manifest.permission.ACCESS_FINE_LOCATION)) {
                call.reject("Разрешите местоположение", "DENIED");
                return;
            }
            if (active) {
                call.resolve();
                return;
            }
            active = true;
            boolean precise = permitted(Manifest.permission.ACCESS_FINE_LOCATION);
            manager = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
            subscribe(LocationManager.NETWORK_PROVIDER);
            if (precise) subscribe(LocationManager.GPS_PROVIDER);
            if (GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(getContext()) == ConnectionResult.SUCCESS) {
                try {
                    fused = LocationServices.getFusedLocationProviderClient(getActivity());
                    LocationRequest request = new LocationRequest.Builder(
                        precise ? Priority.PRIORITY_HIGH_ACCURACY : Priority.PRIORITY_BALANCED_POWER_ACCURACY, 1000)
                        .setMinUpdateIntervalMillis(650).setMaxUpdateAgeMillis(4000).build();
                    fused.requestLocationUpdates(request, fusedCallback, Looper.getMainLooper());
                } catch (RuntimeException ignored) {
                    // System providers remain active if Play Services is unavailable.
                }
            }
            sensors = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
            Sensor attitude = sensors.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
            if (attitude == null) attitude = sensors.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR);
            earthFrame = attitude != null && attitude.getType() == Sensor.TYPE_ROTATION_VECTOR;
            register(attitude);
            register(sensors.getDefaultSensor(Sensor.TYPE_GYROSCOPE));
            register(sensors.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION));
            call.resolve();
        });
    }

    private void subscribe(String provider) {
        try {
            if (!manager.getAllProviders().contains(provider)) return;
            manager.requestLocationUpdates(provider, 1000, 0, this, Looper.getMainLooper());
            Location cached = manager.getLastKnownLocation(provider);
            if (cached != null) emit(cached, provider);
        } catch (RuntimeException ignored) {
            // Provider may be disabled or unavailable on this device.
        }
    }

    private void register(Sensor sensor) {
        if (sensor != null) sensors.registerListener(this, sensor, 50_000);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            deactivate();
            call.resolve();
        });
    }

    @Override protected void handleOnStop() { deactivate(); }

    private void deactivate() {
        active = false;
        if (manager != null) manager.removeUpdates(this);
        if (fused != null) fused.removeLocationUpdates(fusedCallback);
        if (sensors != null) sensors.unregisterListener(this);
        oriented = false;
        lastMotion = accelerationAt = 0;
        java.util.Arrays.fill(gyro, 0);
    }

    @Override public void onLocationChanged(Location location) { emit(location, location.getProvider()); }
    @Override public void onProviderEnabled(String provider) {}
    @Override public void onProviderDisabled(String provider) {}
    @Override public void onStatusChanged(String provider, int status, Bundle extras) {}

    private void emit(Location fix, String provider) {
        if (!active || !fix.hasAccuracy()) return;
        JSObject data = new JSObject();
        data.put("at", System.currentTimeMillis() - (SystemClock.elapsedRealtimeNanos() - fix.getElapsedRealtimeNanos()) / 1_000_000L);
        data.put("source", provider);
        data.put("lat", fix.getLatitude());
        data.put("lon", fix.getLongitude());
        data.put("accuracy", fix.getAccuracy());
        data.put("mock", android.os.Build.VERSION.SDK_INT >= 31 ? fix.isMock() : fix.isFromMockProvider());
        if (fix.hasSpeed()) data.put("speed", fix.getSpeed());
        if (fix.hasBearing()) data.put("heading", fix.getBearing());
        if (android.os.Build.VERSION.SDK_INT >= 26 && fix.hasSpeedAccuracy()) data.put("speedAccuracy", fix.getSpeedAccuracyMetersPerSecond());
        notifyListeners("position", data);
    }

    private double project(int axis, float[] v) {
        return matrix[axis * 3] * v[0] + matrix[axis * 3 + 1] * v[1] + matrix[axis * 3 + 2] * v[2];
    }

    @Override public void onSensorChanged(SensorEvent event) {
        if (!active) return;
        switch (event.sensor.getType()) {
            case Sensor.TYPE_ROTATION_VECTOR:
            case Sensor.TYPE_GAME_ROTATION_VECTOR:
                SensorManager.getRotationMatrixFromVector(matrix, event.values);
                oriented = true;
                break;
            case Sensor.TYPE_GYROSCOPE:
                System.arraycopy(event.values, 0, gyro, 0, 3);
                emitMotion(event);
                break;
            case Sensor.TYPE_LINEAR_ACCELERATION:
                if (oriented && earthFrame) {
                    east = project(0, event.values);
                    north = project(1, event.values);
                    accelerationAt = event.timestamp;
                }
                emitMotion(event);
                break;
            default:
                break;
        }
    }

    private void emitMotion(SensorEvent event) {
        if (!oriented || event.timestamp - lastMotion < 45_000_000L) return;
        lastMotion = event.timestamp;
        JSObject data = new JSObject();
        data.put("at", System.currentTimeMillis() - (SystemClock.elapsedRealtimeNanos() - event.timestamp) / 1_000_000L);
        data.put("yawRate", -Math.toDegrees(project(2, gyro)));
        if (earthFrame && accelerationAt > 0 && Math.abs(event.timestamp - accelerationAt) <= 200_000_000L) {
            data.put("east", east);
            data.put("north", north);
        }
        notifyListeners("motion", data);
    }
    @Override public void onAccuracyChanged(Sensor sensor, int accuracy) {}
}
