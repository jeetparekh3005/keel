package app

import (
	"context"

	"github.com/google/uuid"
)

// << aggregate_pascal >>Service is the application service for the << aggregate_plural >> aggregate.
type << aggregate_pascal >>Service struct {
	repo << aggregate_pascal >>Repository
}

// New<< aggregate_pascal >>Service wires the service to its repository.
func New<< aggregate_pascal >>Service(repo << aggregate_pascal >>Repository) *<< aggregate_pascal >>Service {
	return &<< aggregate_pascal >>Service{repo: repo}
}

// Create persists a new << aggregate >> with a generated id.
func (s *<< aggregate_pascal >>Service) Create(ctx context.Context, name string) (<< aggregate_pascal >>, error) {
	<< aggregate >> := << aggregate_pascal >>{ID: uuid.NewString(), Name: name}
	if err := s.repo.Create(ctx, << aggregate >>); err != nil {
		return << aggregate_pascal >>{}, err
	}
	return << aggregate >>, nil
}

// Get returns the << aggregate >> by id (NotFound if absent).
func (s *<< aggregate_pascal >>Service) Get(ctx context.Context, id string) (<< aggregate_pascal >>, error) {
	return s.repo.Get(ctx, id)
}

// List returns a page of << aggregate_plural >>.
func (s *<< aggregate_pascal >>Service) List(ctx context.Context, limit, offset int) ([]<< aggregate_pascal >>, error) {
	return s.repo.List(ctx, limit, offset)
}
