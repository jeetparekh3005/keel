package grpc

import (
	referencev1 "github.com/jeetparekh3005/keel/packages/keel-core-go/genproto/keel/reference/v1"
)

// Reference aggregate scopes (ADR-0022). Kept as named constants rather than proto options
// so the deny-by-default interceptor enforces the same scopes every vertical declares.
const (
	ScopeItemsRead  = "items:read"
	ScopeItemsWrite = "items:write"
)

// ItemServiceScopes is the per-method scope map for keel.reference.v1.ItemService, matching
// the Python factory's required_scopes: the two reads require items:read and the write
// requires items:write. The method paths come from the generated stubs, so they stay in sync
// with the contract. Pass it via WithRequiredScopes when building the server.
func ItemServiceScopes() MethodScopes {
	return MethodScopes{
		referencev1.ItemService_GetItem_FullMethodName:    {ScopeItemsRead},
		referencev1.ItemService_ListItems_FullMethodName:  {ScopeItemsRead},
		referencev1.ItemService_CreateItem_FullMethodName: {ScopeItemsWrite},
	}
}
