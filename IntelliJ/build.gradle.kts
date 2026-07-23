import org.gradle.api.tasks.Copy
import org.gradle.api.tasks.Exec
import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType

plugins {
    id("java")
    id("org.jetbrains.intellij.platform")
}

group = "com.ailoc2"
version = "1.0.18"

val repositoryRoot = rootProject.layout.projectDirectory.dir("..")
val claudeRuntime = repositoryRoot.file("out/claude-code/ailoc2-claude-code.cjs")

fun npmCommand(): String = if (System.getProperty("os.name").lowercase().contains("win")) "npm.cmd" else "npm"

dependencies {
    intellijPlatform {
        intellijIdeaCommunity("2025.2.3")
        bundledPlugin("Git4Idea")
        pluginVerifier()
    }

    testImplementation("org.junit.jupiter:junit-jupiter:5.12.2")
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
            sinceBuild = "252"
            untilBuild = "262.*"
        }
    }
    pluginVerification {
        ides {
            create(IntelliJPlatformType.IntellijIdeaCommunity, "2025.2.3")
            create(IntelliJPlatformType.IntellijIdeaUltimate, "2026.2")
        }
    }
}

tasks.named("buildSearchableOptions") {
    enabled = false
}

tasks.test {
    useJUnitPlatform()
}

val buildClaudeCodeRuntime by tasks.registering(Exec::class) {
    workingDir = repositoryRoot.asFile
    commandLine(npmCommand(), "run", "build:claude-code-runtime")
    outputs.file(claudeRuntime)
}

tasks.named<Copy>("processResources") {
    dependsOn(buildClaudeCodeRuntime)
    from(claudeRuntime) {
        into("claude-code")
    }
}
