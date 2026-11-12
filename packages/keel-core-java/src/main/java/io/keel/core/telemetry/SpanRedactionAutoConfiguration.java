package io.keel.core.telemetry;

import io.opentelemetry.sdk.trace.export.SpanExporter;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.context.annotation.Bean;

/**
 * Wraps every autoconfigured {@link SpanExporter} bean (the Boot/OpenTelemetry OTLP span exporter)
 * in a {@link RedactingSpanExporter} so exported span attributes are scrubbed of secrets with the
 * same {@link io.keel.core.logging.Redactor} the JSON log sink uses (parity epic #419, v0.6).
 *
 * <p>A {@link BeanPostProcessor} is used rather than defining a replacement bean because the
 * exporter is created by Boot's OpenTelemetry tracing auto-configuration and is only present when
 * an OTLP endpoint is configured ({@link io.keel.core.KeelEnvironmentPostProcessor}); decorating
 * the existing bean leaves that gating, exporter selection (gRPC vs HTTP), and the batch span
 * processor wiring to Boot. When no exporter bean exists the post-processor simply never fires.
 * Registered via {@code AutoConfiguration.imports} alongside the other telemetry auto-configs.
 */
@AutoConfiguration
@ConditionalOnClass(SpanExporter.class)
public class SpanRedactionAutoConfiguration {

  @Bean
  static BeanPostProcessor redactingSpanExporterPostProcessor() {
    return new BeanPostProcessor() {
      @Override
      public Object postProcessAfterInitialization(Object bean, String beanName) {
        if (bean instanceof SpanExporter exporter && !(bean instanceof RedactingSpanExporter)) {
          return new RedactingSpanExporter(exporter);
        }
        return bean;
      }
    };
  }
}
