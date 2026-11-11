package io.keel.@< service_pkg >@.@< aggregate_plural >@;

import io.keel.core.domain.DomainException;
import io.keel.core.domain.ErrorCategory;
import jakarta.annotation.PostConstruct;
import java.util.List;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/**
 * The Postgres-backed @< aggregate_pascal >@Repository over Spring's JdbcClient. Ensures its table exists at startup
 * (dev convenience; production applies versioned migrations) and maps a missing row to a NotFound
 * DomainException and any driver failure to an Internal one, so internals never leak.
 */
@Repository
public class Jdbc@< aggregate_pascal >@Repository implements @< aggregate_pascal >@Repository {

  private final JdbcClient jdbc;

  public Jdbc@< aggregate_pascal >@Repository(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  @PostConstruct
  void ensureSchema() {
    try {
      jdbc.sql("CREATE TABLE IF NOT EXISTS @< aggregate_plural >@ (id text PRIMARY KEY, name text NOT NULL)")
          .update();
    } catch (DataAccessException e) {
      throw new DomainException(ErrorCategory.UNAVAILABLE, "ensure schema: " + e.getMessage());
    }
  }

  @Override
  public void create(@< aggregate_pascal >@ @< aggregate >@) {
    try {
      jdbc.sql("INSERT INTO @< aggregate_plural >@ (id, name) VALUES (?, ?)")
          .params(@< aggregate >@.id(), @< aggregate >@.name())
          .update();
    } catch (DataAccessException e) {
      throw new DomainException(ErrorCategory.INTERNAL, "insert @< aggregate >@: " + e.getMessage());
    }
  }

  @Override
  public @< aggregate_pascal >@ get(String id) {
    try {
      return jdbc.sql("SELECT id, name FROM @< aggregate_plural >@ WHERE id = ?")
          .param(id)
          .query(@< aggregate_pascal >@.class)
          .optional()
          .orElseThrow(() -> new DomainException(ErrorCategory.NOT_FOUND, "@< aggregate >@ not found"));
    } catch (DataAccessException e) {
      throw new DomainException(ErrorCategory.INTERNAL, "get @< aggregate >@: " + e.getMessage());
    }
  }

  @Override
  public List<@< aggregate_pascal >@> list(int limit, int offset) {
    try {
      return jdbc.sql("SELECT id, name FROM @< aggregate_plural >@ ORDER BY id LIMIT ? OFFSET ?")
          .params(limit, offset)
          .query(@< aggregate_pascal >@.class)
          .list();
    } catch (DataAccessException e) {
      throw new DomainException(ErrorCategory.INTERNAL, "list @< aggregate_plural >@: " + e.getMessage());
    }
  }
}
