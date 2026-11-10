package io.keel.reference.items;

import java.util.List;

/**
 * The driven port for item persistence. {@code get} throws a NotFound DomainException when the id
 * is absent. The service defines its own repository per aggregate (ADR-0009); keel-core ships no
 * generic repository.
 */
public interface ItemRepository {
  void create(Item item);

  Item get(String id);

  List<Item> list(int limit, int offset);
}
