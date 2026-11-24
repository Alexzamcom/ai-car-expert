package com.aicarexpert.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
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
import androidx.activity.result.ActivityResult;
import com.getcapacitor.annotation.ActivityCallback;
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
import com.google.android.gms.location.CurrentLocationRequest;
import com.google.android.gms.tasks.CancellationTokenSource;
import java.io.OutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

@CapacitorPlugin(name = "NativePosition", permissions = @Permission(
    alias = "position", strings = { Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION }
))
public class NativePosition extends Plugin implements LocationListener, SensorEventListener {
    private LocationManager manager;
    private FusedLocationProviderClient fused;
    private SensorManager sensors;
    private CancellationTokenSource currentRequest;
    private String fusedStatus = "idle";
    private boolean active;
    private boolean requested;
    private long requestStartedAt;
    private long firstMeasurementAt;
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
            boolean provisional = !permitted(Manifest.permission.ACCESS_FINE_LOCATION);
            for (Location location : result.getLocations()) emit(location, "fused", false, provisional);
        }
    };

    @PluginMethod
    public void start(PluginCall call) {
        manager = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
        report();
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
                report();
                call.reject("Разрешите местоположение", "DENIED");
                return;
            }
            requested = true;
            if (active) probe();
            else activate();
            call.resolve(status());
        });
    }

    private void activate() {
        active = true;
        boolean precise = permitted(Manifest.permission.ACCESS_FINE_LOCATION);
        manager = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
        subscribe(LocationManager.NETWORK_PROVIDER);
        if (precise) subscribe(LocationManager.GPS_PROVIDER);
        if (playServices() == ConnectionResult.SUCCESS) {
            try {
                fused = LocationServices.getFusedLocationProviderClient(getActivity());
                LocationRequest request = new LocationRequest.Builder(
                    precise ? Priority.PRIORITY_HIGH_ACCURACY : Priority.PRIORITY_BALANCED_POWER_ACCURACY, 1000)
                    .setMinUpdateIntervalMillis(650).setMaxUpdateAgeMillis(4000).build();
                fusedStatus = "starting";
                fused.requestLocationUpdates(request, fusedCallback, Looper.getMainLooper())
                    .addOnSuccessListener(ignored -> { if (active) { fusedStatus = "watching"; report(); } })
                    .addOnFailureListener(error -> { if (active) { fusedStatus = "updates-failed"; report(); } });
            } catch (RuntimeException ignored) {
                fusedStatus = "updates-failed";
            }
        }
        probe();
        sensors = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
        Sensor attitude = sensors.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
        if (attitude == null) attitude = sensors.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR);
        earthFrame = attitude != null && attitude.getType() == Sensor.TYPE_ROTATION_VECTOR;
        register(attitude);
        register(sensors.getDefaultSensor(Sensor.TYPE_GYROSCOPE));
        register(sensors.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION));
    }

    private void subscribe(String provider) {
        try {
            if (manager == null || !manager.getAllProviders().contains(provider)) return;
            manager.requestLocationUpdates(provider, 1000, 0, this, Looper.getMainLooper());

        } catch (RuntimeException ignored) {
            // Provider may be disabled or unavailable on this device.
        }
    }

    private int playServices() {
        return GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(getContext());
    }

    private boolean enabled(String provider) {
        return manager != null && manager.isProviderEnabled(provider);
    }

    private JSObject status() {
        JSObject state = new JSObject();
        state.put("fine", permitted(Manifest.permission.ACCESS_FINE_LOCATION));
        state.put("coarse", permitted(Manifest.permission.ACCESS_COARSE_LOCATION));
        state.put("playServices", playServices());
        state.put("fusedStatus", fusedStatus);
        if (requestStartedAt > 0) state.put("requestStartedAt", requestStartedAt);
        if (firstMeasurementAt > 0) state.put("firstMeasurementAt", firstMeasurementAt);
        state.put("gpsEnabled", enabled(LocationManager.GPS_PROVIDER));
        state.put("networkEnabled", enabled(LocationManager.NETWORK_PROVIDER));
        return state;
    }

    private void report() { notifyListeners("locationStatus", status()); }

    @PluginMethod
    public void refresh(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (active) probe();
            call.resolve(status());
        });
    }

    @PluginMethod
    public void exportDiagnostics(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/json");
        intent.putExtra(Intent.EXTRA_TITLE, "android-location-diagnostics.json");
        startActivityForResult(call, intent, "saveDiagnostics");
    }

    @ActivityCallback
    private void saveDiagnostics(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            call.resolve();
            return;
        }
        try (OutputStream stream = getContext().getContentResolver().openOutputStream(data.getData())) {
            if (stream == null) throw new IOException("Document output stream unavailable");
            stream.write(call.getString("json", "").getBytes(StandardCharsets.UTF_8));
            call.resolve();
        } catch (IOException | SecurityException error) {
            call.reject("Не удалось сохранить журнал");
        }
    }

    private void cached(String provider) {
        if (!enabled(provider)) return;
        try {
            Location location = manager.getLastKnownLocation(provider);
            if (location != null) emit(location, provider, true);
        } catch (SecurityException ignored) {}
    }

    private void probe() {
        long now = System.currentTimeMillis();
        if (active && now - requestStartedAt < 2000) return;
        requestStartedAt = now;
        firstMeasurementAt = 0;
        report();
        cached(LocationManager.NETWORK_PROVIDER);
        if (permitted(Manifest.permission.ACCESS_FINE_LOCATION)) cached(LocationManager.GPS_PROVIDER);
        if (fused == null) return;
        if (currentRequest != null) currentRequest.cancel();
        CancellationTokenSource request = new CancellationTokenSource();
        currentRequest = request;
        try {
            fused.getLastLocation().addOnSuccessListener(location -> {
                if (request == currentRequest && location != null) emit(location, "fused", true);
            });
            requestCurrent(request, Priority.PRIORITY_BALANCED_POWER_ACCURACY);
            if (permitted(Manifest.permission.ACCESS_FINE_LOCATION)) requestCurrent(request, Priority.PRIORITY_HIGH_ACCURACY);
        } catch (RuntimeException ignored) {
            // System LocationManager subscriptions still provide network and GNSS updates.
        }
    }

    private void requestCurrent(CancellationTokenSource request, int priority) {
        CurrentLocationRequest options = new CurrentLocationRequest.Builder()
            .setPriority(priority)
            .setMaxUpdateAgeMillis(0).setDurationMillis(10000).build();
        fused.getCurrentLocation(options, request.getToken()).addOnSuccessListener(location -> {
            if (request == currentRequest && location != null) {
                emit(location, "fused", false, priority == Priority.PRIORITY_BALANCED_POWER_ACCURACY);
            }
        }).addOnFailureListener(error -> { if (request == currentRequest) report(); });
    }

    private void register(Sensor sensor) {
        if (sensor != null) sensors.registerListener(this, sensor, 50_000);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            requested = false;
            deactivate();
            call.resolve();
        });
    }

    @Override protected void handleOnStart() {
        if (requested && !active && (permitted(Manifest.permission.ACCESS_FINE_LOCATION) ||
            permitted(Manifest.permission.ACCESS_COARSE_LOCATION))) activate();
    }

    @Override protected void handleOnStop() { deactivate(); }

    private void deactivate() {
        active = false;
        if (currentRequest != null) currentRequest.cancel();
        currentRequest = null;
        requestStartedAt = firstMeasurementAt = 0;
        if (manager != null) manager.removeUpdates(this);
        if (fused != null) fused.removeLocationUpdates(fusedCallback);
        fused = null;
        fusedStatus = "idle";
        if (sensors != null) sensors.unregisterListener(this);
        oriented = false;
        lastMotion = accelerationAt = 0;
        java.util.Arrays.fill(gyro, 0);
    }

    @Override public void onLocationChanged(Location location) { emit(location, location.getProvider()); }
    @Override public void onProviderEnabled(String provider) { if (active) report(); }
    @Override public void onProviderDisabled(String provider) { if (active) report(); }
    @Override public void onStatusChanged(String provider, int status, Bundle extras) {}

    private void emit(Location fix, String provider) {
        emit(fix, provider, false);
    }

    private void emit(Location fix, String provider, boolean cached) {
        emit(fix, provider, cached, false);
    }

    private void emit(Location fix, String provider, boolean cached, boolean provisional) {
        if (!active) return;
        JSObject data = new JSObject();
        data.put("at", System.currentTimeMillis() - (SystemClock.elapsedRealtimeNanos() - fix.getElapsedRealtimeNanos()) / 1_000_000L);
        data.put("source", provider);
        data.put("lat", fix.getLatitude());
        data.put("lon", fix.getLongitude());
        data.put("accuracy", fix.hasAccuracy() ? fix.getAccuracy() : -1);
        data.put("cached", cached);
        data.put("provisional", provisional);
        data.put("mock", android.os.Build.VERSION.SDK_INT >= 31 ? fix.isMock() : fix.isFromMockProvider());
        if (fix.hasSpeed()) data.put("speed", fix.getSpeed());
        if (fix.hasBearing()) data.put("heading", fix.getBearing());
        if (android.os.Build.VERSION.SDK_INT >= 26 && fix.hasSpeedAccuracy()) data.put("speedAccuracy", fix.getSpeedAccuracyMetersPerSecond());
        if (firstMeasurementAt == 0 && requestStartedAt > 0) {
            firstMeasurementAt = System.currentTimeMillis();
            report();
        }
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
