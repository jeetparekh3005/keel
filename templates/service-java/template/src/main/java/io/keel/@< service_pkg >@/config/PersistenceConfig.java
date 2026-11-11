package io.keel.@< service_pkg >@.config;

import io.keel.core.config.KeelProperties;
import io.keel.core.web.ReadinessCheck;
import javax.sql.DataSource;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.simple.JdbcClient;

/**
 * Service persistence: the connection pool built from {@code KEEL_DATABASE_URL} and a readiness
 * check that backs /readyz with a real {@code SELECT 1} round-trip (overriding the always-ready
 * default in keel-core). Spring Boot auto-configures a JdbcClient on the pool.
 */
@Configuration
public class PersistenceConfig {

  @Bean
  public DataSource dataSource(KeelProperties properties) {
    return DataSourceFactory.from(properties.databaseUrl());
  }

  @Bean
  public ReadinessCheck readinessCheck(JdbcClient jdbc) {
    return () -> {
      try {
        jdbc.sql("SELECT 1").query(Integer.class).single();
        return true;
      } catch (RuntimeException e) {
        return false;
      }
    };
  }
}
