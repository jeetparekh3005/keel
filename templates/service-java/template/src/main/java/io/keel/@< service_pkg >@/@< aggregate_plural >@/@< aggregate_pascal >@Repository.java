package io.keel.@< service_pkg >@.@< aggregate_plural >@;

import java.util.List;

/**
 * The driven port for @< aggregate >@ persistence. {@code get} throws a NotFound DomainException when the id
 * is absent. The service defines its own repository per aggregate (ADR-0009); keel-core ships no
 * generic repository.
 */
public interface @< aggregate_pascal >@Repository {
  void create(@< aggregate_pascal >@ @< aggregate >@);

  @< aggregate_pascal >@ get(String id);

  List<@< aggregate_pascal >@> list(int limit, int offset);
}
