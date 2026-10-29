# World Wallet AI Android build

This project wraps the existing React/Vite web app with Capacitor. It remains a separate app from PWFB Microfinance.

## Application identity

- Display name: World Wallet AI
- Android application ID: `com.pwfb.worldwalletai`

The application ID is a new identifier for this first Android build. Do not change it after publishing or distributing the app without planning a migration.

## Build a debug APK

Run from the repository root:

```sh
cd apps/web
npm install
npm run build
npx cap add android
npx cap sync android
cd android
./gradlew assembleDebug
```

The debug APK is written to `apps/web/android/app/build/outputs/apk/debug/app-debug.apk`.

If the `android` directory already exists, do not run `npx cap add android` again. Use `npx cap sync android` instead.

## Important checks before release

- The web app currently uses the configured `VITE_API_BASE_URL` (defaulting to the World Wallet AI Render API). Verify the intended API URL in the build environment; never embed secrets in Vite variables.
- Verify Neon Auth sign-in, sign-out, refresh, and OAuth callback behavior in Android. A browser login that returns to a website may need an explicit Capacitor deep-link setup before native login is release-ready.
- Test wallet address validation, Bitcoin balance/history sync, network switching, and error/offline states on a physical device.
- Do not use real funds or submit real transactions during smoke tests.
- Debug APKs are for testing, not production distribution. Release signing credentials must be kept outside the repository.
- This build setup does not deploy the backend or change any database.
