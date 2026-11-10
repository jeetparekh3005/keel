package io.keel.core.web;

/** Reports whether the service's dependencies are reachable (e.g. a DB ping). Backs /readyz. */
@FunctionalInterface
public interface ReadinessCheck {
  boolean isReady();
}
