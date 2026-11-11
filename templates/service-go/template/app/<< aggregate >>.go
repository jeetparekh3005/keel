// Package app is the << service_slug >> application: the << aggregate_plural >> aggregate, its service and
// repository, the HTTP routes, and the composition root. It imports keel-core-go and
// implements one aggregate against the platform contract (ADR-0009, ADR-0018).
package app

import "context"

// << aggregate_pascal >> is the aggregate.
type << aggregate_pascal >> struct {
	ID   string
	Name string
}

// << aggregate_pascal >>Repository is the driven port for << aggregate >> persistence. Get returns a NotFound
// DomainError when the id is absent.
type << aggregate_pascal >>Repository interface {
	Create(ctx context.Context, << aggregate >> << aggregate_pascal >>) error
	Get(ctx context.Context, id string) (<< aggregate_pascal >>, error)
	List(ctx context.Context, limit, offset int) ([]<< aggregate_pascal >>, error)
}
