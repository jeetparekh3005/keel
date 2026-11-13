package io.keel.core.adapters.inbound.rpc;

import io.grpc.Server;
import java.io.IOException;
import java.util.concurrent.TimeUnit;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.SmartLifecycle;

/**
 * Starts and stops the gRPC {@link Server} with the Spring application context (ADR-0022). As a
 * {@link SmartLifecycle} the server binds its port when the context refreshes and drains on
 * shutdown, so a service never has to manage the server by hand; a failed bind fails context
 * startup, surfacing a port conflict loudly rather than silently serving nothing.
 */
public final class GrpcServerLifecycle implements SmartLifecycle {

  private static final Logger log = LoggerFactory.getLogger(GrpcServerLifecycle.class);

  private final Server server;
  private volatile boolean running;

  public GrpcServerLifecycle(Server server) {
    this.server = server;
  }

  @Override
  public synchronized void start() {
    if (running) {
      return;
    }
    try {
      server.start();
    } catch (IOException e) {
      throw new IllegalStateException("failed to start gRPC server on port " + server.getPort(), e);
    }
    running = true;
    log.info("gRPC server listening on port {}", server.getPort());
  }

  @Override
  public synchronized void stop() {
    if (!running) {
      return;
    }
    running = false;
    try {
      // Give in-flight calls a moment to finish, then force termination so shutdown never hangs.
      server.shutdown();
      if (!server.awaitTermination(5, TimeUnit.SECONDS)) {
        server.shutdownNow();
      }
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      server.shutdownNow();
    }
  }

  @Override
  public boolean isRunning() {
    return running;
  }

  /** The bound port (useful once started with port 0, which binds an ephemeral port). */
  public int port() {
    return server.getPort();
  }
}
