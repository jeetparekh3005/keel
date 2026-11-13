package io.keel.core.ports.messaging;

/**
 * Consumes a delivered {@link InboundMessage} (platform.yaml interservice.async: the driving
 * MessageConsumer side of the MessageBus port). A handler may throw: the bus treats any thrown
 * exception as a processing failure and schedules redelivery, so a handler never has to manage
 * acknowledgement itself.
 */
@FunctionalInterface
public interface MessageHandler {

  /**
   * Handle one delivered message. Throwing signals failure and triggers redelivery (and eventual
   * dead-lettering past the delivery cap); returning normally acknowledges the message.
   *
   * @param message the delivered message
   * @throws Exception to signal a processing failure that should be retried
   */
  void handle(InboundMessage message) throws Exception;
}
