package grpc

import (
	"context"
	"strings"
	"sync"

	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	referencev1 "github.com/jeetparekh3005/keel/packages/keel-core-go/genproto/keel/reference/v1"
)

// ItemServer implements the generated referencev1.ItemServiceServer with an in-memory store.
// Persistence is out of scope for this slice (ADR-0022): the point is the deny-by-default
// posture, so items live in a map guarded by a mutex. Embedding the Unimplemented server by
// value keeps it forward-compatible if the contract grows new methods.
type ItemServer struct {
	referencev1.UnimplementedItemServiceServer
	mu    sync.RWMutex
	items map[string]*referencev1.Item
	order []string // insertion order, so ListItems paginates deterministically
}

// NewItemServer returns an empty in-memory ItemServer.
func NewItemServer() *ItemServer {
	return &ItemServer{items: make(map[string]*referencev1.Item)}
}

// GetItem returns the item by id (authorization: items:read, enforced by the interceptor).
func (s *ItemServer) GetItem(_ context.Context, req *referencev1.GetItemRequest) (*referencev1.GetItemResponse, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	item, ok := s.items[req.GetId()]
	if !ok {
		return nil, status.Errorf(codes.NotFound, "item %q not found", req.GetId())
	}
	return &referencev1.GetItemResponse{Item: cloneItem(item)}, nil
}

// ListItems returns a page of items in insertion order (authorization: items:read). A
// non-positive limit returns all remaining items; a negative offset is clamped to zero.
func (s *ItemServer) ListItems(_ context.Context, req *referencev1.ListItemsRequest) (*referencev1.ListItemsResponse, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	offset := int(req.GetOffset())
	if offset < 0 {
		offset = 0
	}
	if offset > len(s.order) {
		offset = len(s.order)
	}
	end := len(s.order)
	if limit := int(req.GetLimit()); limit > 0 && offset+limit < end {
		end = offset + limit
	}

	page := make([]*referencev1.Item, 0, end-offset)
	for _, id := range s.order[offset:end] {
		page = append(page, cloneItem(s.items[id]))
	}
	return &referencev1.ListItemsResponse{Items: page}, nil
}

// CreateItem stores a new item with a generated id (authorization: items:write). An empty
// name is rejected with InvalidArgument.
func (s *ItemServer) CreateItem(_ context.Context, req *referencev1.CreateItemRequest) (*referencev1.CreateItemResponse, error) {
	name := strings.TrimSpace(req.GetName())
	if name == "" {
		return nil, status.Error(codes.InvalidArgument, "name is required")
	}
	item := &referencev1.Item{Id: uuid.NewString(), Name: name}

	s.mu.Lock()
	s.items[item.Id] = item
	s.order = append(s.order, item.Id)
	s.mu.Unlock()

	return &referencev1.CreateItemResponse{Item: cloneItem(item)}, nil
}

// cloneItem copies the stored item so a caller cannot mutate the store's state through the
// returned pointer.
func cloneItem(item *referencev1.Item) *referencev1.Item {
	return &referencev1.Item{Id: item.GetId(), Name: item.GetName()}
}
