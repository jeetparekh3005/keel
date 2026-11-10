package io.keel.reference.items;

import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Service;

/** The application service for the items aggregate. */
@Service
public class ItemService {

  private final ItemRepository repository;

  public ItemService(ItemRepository repository) {
    this.repository = repository;
  }

  /** Persist a new item with a generated id. */
  public Item create(String name) {
    Item item = new Item(UUID.randomUUID().toString(), name);
    repository.create(item);
    return item;
  }

  /** Return the item by id (NotFound if absent). */
  public Item get(String id) {
    return repository.get(id);
  }

  /** Return a page of items. */
  public List<Item> list(int limit, int offset) {
    return repository.list(limit, offset);
  }
}
