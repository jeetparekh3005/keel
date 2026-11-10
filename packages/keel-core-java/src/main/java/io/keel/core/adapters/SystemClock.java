package io.keel.core.adapters;

import io.keel.core.ports.Clock;
import java.time.Instant;

/** The real wall clock. */
public final class SystemClock implements Clock {
  @Override
  public Instant now() {
    return Instant.now();
  }
}
