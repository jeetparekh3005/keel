package app

import (
	"context"

	"github.com/google/uuid"
)

// ItemService is the application service for the items aggregate.
type ItemService struct {
	repo ItemRepository
}

// NewItemService wires the service to its repository.
func NewItemService(repo ItemRepository) *ItemService {
	return &ItemService{repo: repo}
}

// Create persists a new item with a generated id.
func (s *ItemService) Create(ctx context.Context, name string) (Item, error) {
	item := Item{ID: uuid.NewString(), Name: name}
	if err := s.repo.Create(ctx, item); err != nil {
		return Item{}, err
	}
	return item, nil
}

// Get returns the item by id (NotFound if absent).
func (s *ItemService) Get(ctx context.Context, id string) (Item, error) {
	return s.repo.Get(ctx, id)
}

// List returns a page of items.
func (s *ItemService) List(ctx context.Context, limit, offset int) ([]Item, error) {
	return s.repo.List(ctx, limit, offset)
}
