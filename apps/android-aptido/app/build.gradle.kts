plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

val signingStorePath = System.getenv("APTIDO_KEYSTORE_PATH")
val signingStorePassword = System.getenv("APTIDO_KEYSTORE_PASSWORD")
val signingKeyAlias = System.getenv("APTIDO_KEY_ALIAS")
val signingKeyPassword = System.getenv("APTIDO_KEY_PASSWORD")

android {
    namespace = "com.balmz.aptido"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.balmz.aptido"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"
        ndk {
            abiFilters += setOf("arm64-v8a")
        }
        buildConfigField("String", "API_BASE_URL", "\"https://world-wallet-ai-backend.onrender.com\"")
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    signingConfigs {
        if (!signingStorePath.isNullOrBlank() &&
            !signingStorePassword.isNullOrBlank() &&
            !signingKeyAlias.isNullOrBlank() &&
            !signingKeyPassword.isNullOrBlank()
        ) {
            create("release") {
                storeFile = file(signingStorePath)
                storePassword = signingStorePassword
                keyAlias = signingKeyAlias
                keyPassword = signingKeyPassword
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        release {
            isMinifyEnabled = false
            if (signingConfigs.findByName("release") != null) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    packaging {
        resources {
            excludes += setOf("META-INF/AL2.0", "META-INF/LGPL2.1", "META-INF/DEPENDENCIES")
        }
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    debugImplementation("androidx.compose.ui:ui-tooling")
}
