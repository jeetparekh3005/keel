package io.keel.core;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;

import com.tngtech.archunit.junit.AnalyzeClasses;
import com.tngtech.archunit.junit.ArchTest;
import com.tngtech.archunit.lang.ArchRule;

/**
 * Enforces the hexagonal boundaries (ADR-0002, ADR-0009): the domain stays pure and the ports do
 * not depend on their adapters. The Java analog of Python's import-linter contracts.
 */
@AnalyzeClasses(packages = "io.keel.core")
class ArchitectureTest {

  @ArchTest
  static final ArchRule domainIsPure =
      noClasses()
          .that()
          .resideInAPackage("..domain..")
          .should()
          .dependOnClassesThat()
          .resideInAnyPackage(
              "io.keel.core.web..",
              "io.keel.core.auth..",
              "io.keel.core.adapters..",
              "io.keel.core.conformance..",
              "io.keel.core.config..");

  @ArchTest
  static final ArchRule portsDoNotDependOnAdapters =
      noClasses()
          .that()
          .resideInAPackage("io.keel.core.ports..")
          .should()
          .dependOnClassesThat()
          .resideInAPackage("io.keel.core.adapters..");
}
