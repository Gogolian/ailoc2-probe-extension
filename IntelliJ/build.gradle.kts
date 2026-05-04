plugins {
    id("java")
    id("org.jetbrains.intellij.platform")
}

group = "com.ailoc2"
version = "0.1.0"

dependencies {
    intellijPlatform {
        intellijIdeaCommunity("2024.3.5")
        bundledPlugin("Git4Idea")
    }
}

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(17))
    }
}

intellijPlatform {
    pluginConfiguration {
        name = "AILoc2 Probe"
        ideaVersion {
            sinceBuild = "243"
        }
    }
}
