package io.keel.@< service_pkg >@.web;

import io.keel.@< service_pkg >@.@< aggregate_plural >@.@< aggregate_pascal >@;
import io.keel.@< service_pkg >@.@< aggregate_plural >@.@< aggregate_pascal >@Service;
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
 * The @< aggregate_plural >@ aggregate routes. Each declares its required scope with {@code @PreAuthorize}; the
 * deny-by-default security chain enforces authentication and the scope before the handler runs.
 */
@RestController
@RequestMapping("/v1/@< aggregate_plural >@")
public class @< aggregate_pascal_plural >@Controller {

  private static final int MAX_LIMIT = 200;

  private final @< aggregate_pascal >@Service @< aggregate_plural >@;

  public @< aggregate_pascal_plural >@Controller(@< aggregate_pascal >@Service @< aggregate_plural >@) {
    this.@< aggregate_plural >@ = @< aggregate_plural >@;
  }

  @PostMapping
  @PreAuthorize("hasAuthority('SCOPE_@< scope_prefix >@:write')")
  @ResponseStatus(HttpStatus.CREATED)
  public @< aggregate_pascal >@Response create(@Valid @RequestBody Create@< aggregate_pascal >@Request request) {
    return @< aggregate_pascal >@Response.from(@< aggregate_plural >@.create(request.name()));
  }

  @GetMapping
  @PreAuthorize("hasAuthority('SCOPE_@< scope_prefix >@:read')")
  public @< aggregate_pascal >@ListResponse list(
      @RequestParam(defaultValue = "50") int limit, @RequestParam(defaultValue = "0") int offset) {
    int boundedLimit = Math.max(1, Math.min(limit, MAX_LIMIT));
    int boundedOffset = Math.max(0, offset);
    List<@< aggregate_pascal >@Response> page =
        @< aggregate_plural >@.list(boundedLimit, boundedOffset).stream().map(@< aggregate_pascal >@Response::from).toList();
    return new @< aggregate_pascal >@ListResponse(page, boundedLimit, boundedOffset, page.size());
  }

  @GetMapping("/{id}")
  @PreAuthorize("hasAuthority('SCOPE_@< scope_prefix >@:read')")
  public @< aggregate_pascal >@Response get(@PathVariable String id) {
    return @< aggregate_pascal >@Response.from(@< aggregate_plural >@.get(id));
  }

  /** Request body for creating an @< aggregate >@ (validated: 1..=200 characters). */
  public record Create@< aggregate_pascal >@Request(@NotBlank @Size(max = 200) String name) {}

  /** The wire representation of an @< aggregate >@. */
  public record @< aggregate_pascal >@Response(String id, String name) {
    static @< aggregate_pascal >@Response from(@< aggregate_pascal >@ @< aggregate >@) {
      return new @< aggregate_pascal >@Response(@< aggregate >@.id(), @< aggregate >@.name());
    }
  }

  /** A page of @< aggregate_plural >@. */
  public record @< aggregate_pascal >@ListResponse(List<@< aggregate_pascal >@Response> @< aggregate_plural >@, int limit, int offset, int count) {}
}
