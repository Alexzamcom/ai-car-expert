package com.aicarexpert.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(TripSensors.class);
        registerPlugin(NativePosition.class);
        registerPlugin(OfflineStorage.class);
        super.onCreate(savedInstanceState);
    }
}
