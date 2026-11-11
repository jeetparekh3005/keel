// The @< aggregate_plural >@ aggregate, its repository port, and the application service. The reference
// service imports @keel/core and implements one aggregate against the platform contract
// (ADR-0009, ADR-0019).

/** The aggregate. */
export interface @< aggregate_pascal >@ {
  id: string;
  name: string;
}

/** The driven port for @< aggregate >@ persistence. `get` returns a NotFound DomainError when absent. */
export interface @< aggregate_pascal >@Repository {
  create(@< aggregate >@: @< aggregate_pascal >@): Promise<void>;
  get(id: string): Promise<@< aggregate_pascal >@>;
  list(limit: number, offset: number): Promise<@< aggregate_pascal >@[]>;
}

/** DI token for the @< aggregate >@ repository (bound to the Postgres adapter in production). */
export const @< aggregate_upper >@_REPOSITORY = Symbol('reference.@< aggregate_pascal >@Repository');
