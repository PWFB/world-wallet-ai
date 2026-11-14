# Release signing and public APK downloads

A signed release uses one permanent Android signing key. Create it only once, keep the original keystore offline, and use the same key for every future update.

## Create the keystore

On a trusted computer or Termux installation with JDK 17 or later, run:

    keytool -genkeypair -v -keystore balmz-ai-apt-release.jks -alias balmz-ai-apt -keyalg RSA -keysize 4096 -validity 10000
    base64 balmz-ai-apt-release.jks | tr -d '\n' > balmz-ai-apt-release.jks.base64

Save the keystore and passwords somewhere secure offline. Do not commit either file.

## Add GitHub Actions secrets

In the PWFB/world-wallet-ai repository, open Settings → Secrets and variables → Actions → New repository secret and create:

| Secret name | Secret value |
|---|---|
| APTIDO_KEYSTORE_BASE64 | Entire contents of balmz-ai-apt-release.jks.base64 |
| APTIDO_KEYSTORE_PASSWORD | Keystore password chosen during key creation |
| APTIDO_KEY_ALIAS | balmz-ai-apt |
| APTIDO_KEY_PASSWORD | Key password chosen during key creation |

Never paste signing credentials into source files, issues, pull requests or chat.

## Publish

After the Android project is reviewed and merged, create and push a version tag from the approved main-branch commit:

    git checkout main
    git pull
    git tag apt-v1.0.0
    git push origin apt-v1.0.0

The Android workflow builds and signs the release APK, computes its SHA-256 checksum, and attaches both files to a public GitHub Release:

https://github.com/PWFB/world-wallet-ai/releases/latest

Do not reuse a version tag for a different build. Increase the Android versionCode and versionName for every subsequent update.
