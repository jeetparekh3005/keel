# syntax=docker/dockerfile:1
# Hardened image per ADR-0008 for the Java/Spring Boot vertical. Build context is the repo root
# (the Maven reactor). The runtime is a rolling Chainguard JRE (non-root, continuously rebuilt;
# scanned every build, ADR-0008). Trivy scans the shipped fat jar's bundled dependencies.

FROM maven:3-eclipse-temurin-25 AS build
WORKDIR /build
# Resolve dependencies first (cached unless the poms change), then build the executable jar.
COPY pom.xml ./
COPY packages/keel-core-java/pom.xml packages/keel-core-java/pom.xml
COPY services/reference-service-java/pom.xml services/reference-service-java/pom.xml
RUN mvn -B -q -pl services/reference-service-java -am dependency:go-offline -DskipTests || true
COPY packages/keel-core-java packages/keel-core-java
COPY services/reference-service-java services/reference-service-java
RUN mvn -B -pl services/reference-service-java -am package -DskipTests -Dspotless.check.skip=true \
  && cp services/reference-service-java/target/reference-service-*.jar /build/app.jar

FROM cgr.dev/chainguard/jre:latest
WORKDIR /app
COPY --from=build /build/app.jar /app/app.jar
EXPOSE 8000
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
