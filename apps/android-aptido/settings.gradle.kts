pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        maven {
            name = "TrustWalletCoreGitHubPackages"
            url = uri("https://maven.pkg.github.com/trustwallet/wallet-core")
            credentials {
                username = providers.gradleProperty("gpr.user")
                    .orElse(providers.environmentVariable("GITHUB_USER"))
                    .orElse(providers.environmentVariable("GITHUB_ACTOR"))
                    .getOrElse("Balmasexy")
                password = providers.gradleProperty("gpr.key")
                    .orElse(providers.environmentVariable("TRUST_WALLET_PACKAGES_TOKEN"))
                    .orElse(providers.environmentVariable("GITHUB_TOKEN"))
                    .getOrElse("")
            }
        }
    }
}

rootProject.name = "BALMZ AI APT"
include(":app")
