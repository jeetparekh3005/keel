// Package app is the reference-service-go application: the items aggregate, its service and
// repository, the HTTP routes, and the composition root. It imports keel-core-go and
// implements one aggregate against the platform contract (ADR-0009, ADR-0018).
package app

import "context"

// Item is the aggregate.
type Item struct {
	ID   string
	Name string
}

// ItemRepository is the driven port for item persistence. Get returns a NotFound
// DomainError when the id is absent.
type ItemRepository interface {
	Create(ctx context.Context, item Item) error
	Get(ctx context.Context, id string) (Item, error)
	List(ctx context.Context, limit, offset int) ([]Item, error)
}
