package io.keel.reference.web;

import io.keel.reference.items.Item;
import io.keel.reference.items.ItemService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * The items aggregate routes. Each declares its required scope with {@code @PreAuthorize}; the
 * deny-by-default security chain enforces authentication and the scope before the handler runs.
 */
@RestController
@RequestMapping("/v1/items")
public class ItemsController {

  private static final int MAX_LIMIT = 200;

  private final ItemService items;

  public ItemsController(ItemService items) {
    this.items = items;
  }

  @PostMapping
  @PreAuthorize("hasAuthority('SCOPE_items:write')")
  @ResponseStatus(HttpStatus.CREATED)
  public ItemResponse create(@Valid @RequestBody CreateItemRequest request) {
    return ItemResponse.from(items.create(request.name()));
  }

  @GetMapping
  @PreAuthorize("hasAuthority('SCOPE_items:read')")
  public ItemListResponse list(
      @RequestParam(defaultValue = "50") int limit, @RequestParam(defaultValue = "0") int offset) {
    int boundedLimit = Math.max(1, Math.min(limit, MAX_LIMIT));
    int boundedOffset = Math.max(0, offset);
    List<ItemResponse> page =
        items.list(boundedLimit, boundedOffset).stream().map(ItemResponse::from).toList();
    return new ItemListResponse(page, boundedLimit, boundedOffset, page.size());
  }

  @GetMapping("/{id}")
  @PreAuthorize("hasAuthority('SCOPE_items:read')")
  public ItemResponse get(@PathVariable String id) {
    return ItemResponse.from(items.get(id));
  }

  /** Request body for creating an item (validated: 1..=200 characters). */
  public record CreateItemRequest(@NotBlank @Size(max = 200) String name) {}

  /** The wire representation of an item. */
  public record ItemResponse(String id, String name) {
    static ItemResponse from(Item item) {
      return new ItemResponse(item.id(), item.name());
    }
  }

  /** A page of items. */
  public record ItemListResponse(List<ItemResponse> items, int limit, int offset, int count) {}
}
