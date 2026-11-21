# AI Car Expert — Android debug APK

This is a first experimental Capacitor wrapper around the existing Vite app. The GitHub Pages release is unchanged.

## Build

Open GitHub Actions → **Android debug APK** → **Run workflow**, selecting branch `feature/android-capacitor-apk`. After success, download the `ai-car-expert-android-debug-apk` artifact. Unzip it and install `app-debug.apk` on Android (allow installation from the selected source when prompted).

This is a debug APK for testing only, not a Play Store release. GPS requires location permission and enabled location services. Keep the app in the foreground with the screen on during navigation.

## Test on a real Android device

1. Open the app and grant location access while using it.
2. Check initial position and road matching, then test a route with several turns.
3. Check map gestures, 3D camera, HUD and mirror mode.
4. Lock and unlock the phone; verify that navigation refreshes from current GPS position.
5. Compare with Google Maps on the same device. Report model, Android version, screenshots, route segment, and whether position drifts.

## Limitations

The wrapper currently uses the WebView Geolocation API. Native GPS plugins, background navigation, OBD and store publication are intentionally out of scope. A successful CI build does not prove road navigation works on physical Android hardware.

The workflow installs Capacitor v7 temporarily rather than committing its dependency lockfile; before merging this prototype, commit pinned Capacitor dependencies and native Android project in a follow-up PR.
