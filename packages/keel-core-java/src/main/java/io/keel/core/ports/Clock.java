package io.keel.core.ports;

import java.time.Instant;

/** The time seam, so time-dependent logic is testable with a frozen clock. */
public interface Clock {
  Instant now();
}
