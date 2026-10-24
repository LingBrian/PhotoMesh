# Local Android toolchain

The repository-local Android toolchain lives under the repository-root `android/` directory. The root `.gitignore` anchors this rule as `/android/`, so SDK binaries and emulator state stay out of Git without hiding the tracked Flutter project at `apps/mobile/android/`. This setup copies the existing machine-wide SDK rather than moving or deleting it, and uses a separate clean AVD.

## Directory layout

- `android/flutter/` — Flutter SDK (currently 3.47.8 stable).
- `android/sdk/` — Android SDK packages, including `platform-tools/`, `build-tools/`, `platforms/`, `system-images/`, and `emulator/`.
- `android/jdk-17/` — JDK 17 used for Android Gradle builds.
- `android/.android/avd/PhotoMesh_API35.avd/` — local Pixel 6 API 35 virtual device and its writable emulator data.
- `android/.android/`, `android/.gradle/`, `android/pub-cache/` — local Android, Gradle, and Dart package caches.
- `android/tmp/` — temporary scratch space for Flutter and its child tools.
- `android/home/` and `android/appdata/` — Flutter/Gradle per-user home, config, and state directories.

`scripts/android-toolchain.ps1` prioritizes this local toolchain when present and sets `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `ANDROID_AVD_HOME`, `ANDROID_USER_HOME`, `ANDROID_SDK_HOME`, `JAVA_HOME`, `HOME`, `USERPROFILE`, `TEMP`, `TMP`, `APPDATA`, `LOCALAPPDATA`, `GRADLE_USER_HOME`, and `PUB_CACHE` only in the invoking PowerShell process; on Windows it also sets `HOMEDRIVE` and `HOMEPATH`. It does not persist machine-wide environment changes. If no local Flutter SDK is installed, Flutter can be selected from `PATH`; set `PHOTOMESH_FLUTTER_BIN` to explicitly override the CLI.

## Common commands

From the repository root:

```powershell
pnpm test:mobile
pnpm build:mobile
```

These commands run `flutter pub get`, `flutter analyze`, and `flutter test`, or build the default APK, using the repository-local SDK when present.

## APK signing and emulator smoke tests

`pnpm build:mobile` runs `flutter build apk` in its default release mode. Gradle configures release signing only when `PHOTOMESH_ANDROID_KEYSTORE` is set; it also reads `PHOTOMESH_ANDROID_KEYSTORE_PASSWORD`, `PHOTOMESH_ANDROID_KEY_ALIAS`, and `PHOTOMESH_ANDROID_KEY_PASSWORD`. Without a keystore, the build can succeed while producing an unsigned APK that Android cannot install or publish. Do not treat that build result as release-ready.

For a local emulator smoke test, build a debug-signed APK with `flutter build apk --debug`. For a distributable release, provide signing values through a secure local or CI secret store, never commit the keystore or passwords, and verify the artifact with `apksigner verify --verbose --print-certs` before distribution.

To start the local emulator manually:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
. (Join-Path (Get-Location).Path 'scripts\android-toolchain.ps1')
$toolchain = Get-PhotoMeshAndroidToolchain -RepositoryRoot (Get-Location).Path
& (Join-Path $env:ANDROID_HOME 'emulator\emulator.exe') -avd PhotoMesh_API35 -no-snapshot-load
```

The Android SDK and AVD are local development tools, not application source or release artifacts. Keep credentials and personal emulator data out of Git; do not remove the ignored `android/` directory without checking whether it contains state you need.
