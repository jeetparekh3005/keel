# syntax=docker/dockerfile:1
# Hardened image per ADR-0008 for the Java/Spring Boot vertical. Build context is the repo root
# (the Maven reactor). The runtime is a rolling Chainguard JRE (non-root, continuously rebuilt;
# scanned every build, ADR-0008). Trivy scans the shipped fat jar's bundled dependencies.

FROM maven:3-eclipse-temurin-25 AS build
WORKDIR /build
# Resolve dependencies first (cached unless the poms change), then build the executable jar.
COPY pom.xml ./
COPY packages/keel-core-java/pom.xml packages/keel-core-java/pom.xml
COPY services/@< service_slug >@/pom.xml services/@< service_slug >@/pom.xml
RUN mvn -B -q -pl services/@< service_slug >@ -am dependency:go-offline -DskipTests || true
COPY packages/keel-core-java packages/keel-core-java
COPY services/@< service_slug >@ services/@< service_slug >@
RUN mvn -B -pl services/@< service_slug >@ -am package -DskipTests -Dspotless.check.skip=true \
  && cp services/@< service_slug >@/target/@< service_name >@-*.jar /build/app.jar

FROM cgr.dev/chainguard/jre:latest
WORKDIR /app
COPY --from=build /build/app.jar /app/app.jar
EXPOSE 8000
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
