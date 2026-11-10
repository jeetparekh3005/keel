package io.keel.reference.items;

import io.keel.core.domain.DomainException;
import io.keel.core.domain.ErrorCategory;
import jakarta.annotation.PostConstruct;
import java.util.List;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/**
 * The Postgres-backed ItemRepository over Spring's JdbcClient. Ensures its table exists at startup
 * (dev convenience; production applies versioned migrations) and maps a missing row to a NotFound
 * DomainException and any driver failure to an Internal one, so internals never leak.
 */
@Repository
public class JdbcItemRepository implements ItemRepository {

  private final JdbcClient jdbc;

  public JdbcItemRepository(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  @PostConstruct
  void ensureSchema() {
    try {
      jdbc.sql("CREATE TABLE IF NOT EXISTS items (id text PRIMARY KEY, name text NOT NULL)")
          .update();
    } catch (DataAccessException e) {
      throw new DomainException(ErrorCategory.UNAVAILABLE, "ensure schema: " + e.getMessage());
    }
  }

  @Override
  public void create(Item item) {
    try {
      jdbc.sql("INSERT INTO items (id, name) VALUES (?, ?)")
          .params(item.id(), item.name())
          .update();
    } catch (DataAccessException e) {
      throw new DomainException(ErrorCategory.INTERNAL, "insert item: " + e.getMessage());
    }
  }

  @Override
  public Item get(String id) {
    try {
      return jdbc.sql("SELECT id, name FROM items WHERE id = ?")
          .param(id)
          .query(Item.class)
          .optional()
          .orElseThrow(() -> new DomainException(ErrorCategory.NOT_FOUND, "item not found"));
    } catch (DataAccessException e) {
      throw new DomainException(ErrorCategory.INTERNAL, "get item: " + e.getMessage());
    }
  }

  @Override
  public List<Item> list(int limit, int offset) {
    try {
      return jdbc.sql("SELECT id, name FROM items ORDER BY id LIMIT ? OFFSET ?")
          .params(limit, offset)
          .query(Item.class)
          .list();
    } catch (DataAccessException e) {
      throw new DomainException(ErrorCategory.INTERNAL, "list items: " + e.getMessage());
    }
  }
}
