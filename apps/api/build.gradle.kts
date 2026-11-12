// FRAME backend (Spring Boot): the relay API and, later, the product API in one process.
// Build: ./gradlew build   Run: ./gradlew bootRun   Jar: build/libs/frame-api.jar (README.md)
plugins {
    java
    id("org.springframework.boot") version "4.1.2"
}

group = "frame"
version = "0.1.0"

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(21)
    }
}

repositories {
    mavenCentral()
}

dependencies {
    implementation(platform(org.springframework.boot.gradle.plugin.SpringBootPlugin.BOM_COORDINATES))
    implementation("org.springframework.boot:spring-boot-starter-webmvc")
    implementation("org.springframework.boot:spring-boot-starter-websocket")
    implementation("org.springframework.boot:spring-boot-starter-security")
    implementation("org.springframework.boot:spring-boot-starter-jdbc")
    implementation("org.springframework.boot:spring-boot-starter-session-data-redis")
    implementation("org.springframework.boot:spring-boot-starter-flyway")
    runtimeOnly("org.postgresql:postgresql")
    runtimeOnly("org.flywaydb:flyway-database-postgresql")
    testImplementation("org.springframework.boot:spring-boot-starter-webmvc-test")
    testImplementation("org.springframework.security:spring-security-test")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.withType<JavaCompile> {
    options.encoding = "UTF-8"
    options.compilerArgs.add("-parameters")
}

tasks.test {
    useJUnitPlatform()
    // Selecting native vs Docker verification storage must rerun the real integration checks.
    inputs.property("productTestConfigPath", providers.environmentVariable("FRAME_PRODUCT_TEST_CONFIG").orElse("disabled"))
}

tasks.bootJar {
    archiveFileName = "frame-api.jar"
}

tasks.jar {
    enabled = false
}
