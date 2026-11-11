package io.keel.@< service_pkg >@.@< aggregate_plural >@;

import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Service;

/** The application service for the @< aggregate_plural >@ aggregate. */
@Service
public class @< aggregate_pascal >@Service {

  private final @< aggregate_pascal >@Repository repository;

  public @< aggregate_pascal >@Service(@< aggregate_pascal >@Repository repository) {
    this.repository = repository;
  }

  /** Persist a new @< aggregate >@ with a generated id. */
  public @< aggregate_pascal >@ create(String name) {
    @< aggregate_pascal >@ @< aggregate >@ = new @< aggregate_pascal >@(UUID.randomUUID().toString(), name);
    repository.create(@< aggregate >@);
    return @< aggregate >@;
  }

  /** Return the @< aggregate >@ by id (NotFound if absent). */
  public @< aggregate_pascal >@ get(String id) {
    return repository.get(id);
  }

  /** Return a page of @< aggregate_plural >@. */
  public List<@< aggregate_pascal >@> list(int limit, int offset) {
    return repository.list(limit, offset);
  }
}
