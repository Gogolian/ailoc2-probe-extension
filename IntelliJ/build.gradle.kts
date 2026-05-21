plugins {
    id("java")
    id("org.jetbrains.intellij.platform")
}

val ideaEdition = providers.gradleProperty("ideaEdition").orNull?.trim()?.lowercase() ?: "community"
val ideaVersion = providers.gradleProperty("ideaVersion").orNull?.trim()
    ?: when (ideaEdition) {
        "community", "ic" -> "2025.2.3"
        "ultimate", "iu" -> "2026.1"
        else -> throw GradleException("Unsupported IntelliJ edition '$ideaEdition'. Use community/ic or ultimate/iu.")
    }
val ideaSinceBuild = providers.gradleProperty("ideaSinceBuild").orNull?.trim()
    ?: when ("$ideaEdition:$ideaVersion") {
        "community:2025.2.3",
        "ic:2025.2.3" -> "252"
        "ultimate:2026.1",
        "iu:2026.1" -> "261"
        else -> throw GradleException(
            "Unsupported IntelliJ target '$ideaEdition:$ideaVersion'. Pass -PideaSinceBuild explicitly or use community 2025.2.3 / ultimate 2026.1."
        )
    }

group = "com.ailoc2"
version = "1.0.3"

dependencies {
    intellijPlatform {
        when (ideaEdition) {
            "community", "ic" -> intellijIdeaCommunity(ideaVersion)
            "ultimate", "iu" -> intellijIdeaUltimate(ideaVersion)
            else -> throw GradleException("Unsupported IntelliJ edition '$ideaEdition'. Use community/ic or ultimate/iu.")
        }
        bundledPlugin("Git4Idea")
    }
}

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(21))
    }
}

intellijPlatform {
    pluginConfiguration {
        name = "AILoc2 Probe"
        ideaVersion {
            sinceBuild = ideaSinceBuild
        }
    }
}

tasks.named("buildSearchableOptions") {
    enabled = false
}
