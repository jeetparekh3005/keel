package app

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/domain"
	"github.com/jeetparekh3005/keel/packages/keel-core-go/persistence"
)

// SqlItemRepository is the Postgres-backed ItemRepository.
type SqlItemRepository struct {
	db *persistence.Database
}

// NewSqlItemRepository wires the repository to the database.
func NewSqlItemRepository(db *persistence.Database) *SqlItemRepository {
	return &SqlItemRepository{db: db}
}

// EnsureSchema creates the items table if absent (dev convenience; production applies
// versioned migrations instead).
func (r *SqlItemRepository) EnsureSchema(ctx context.Context) error {
	_, err := r.db.Pool().Exec(ctx, `CREATE TABLE IF NOT EXISTS items (id text PRIMARY KEY, name text NOT NULL)`)
	if err != nil {
		return domain.New(domain.Unavailable, "ensure schema: "+err.Error())
	}
	return nil
}

func (r *SqlItemRepository) Create(ctx context.Context, item Item) error {
	if _, err := r.db.Pool().Exec(ctx, `INSERT INTO items (id, name) VALUES ($1, $2)`, item.ID, item.Name); err != nil {
		return domain.New(domain.Internal, "insert item: "+err.Error())
	}
	return nil
}

func (r *SqlItemRepository) Get(ctx context.Context, id string) (Item, error) {
	var item Item
	err := r.db.Pool().QueryRow(ctx, `SELECT id, name FROM items WHERE id = $1`, id).Scan(&item.ID, &item.Name)
	if errors.Is(err, pgx.ErrNoRows) {
		return Item{}, domain.New(domain.NotFound, "item not found")
	}
	if err != nil {
		return Item{}, domain.New(domain.Internal, "get item: "+err.Error())
	}
	return item, nil
}

func (r *SqlItemRepository) List(ctx context.Context, limit, offset int) ([]Item, error) {
	rows, err := r.db.Pool().Query(ctx, `SELECT id, name FROM items ORDER BY id LIMIT $1 OFFSET $2`, limit, offset)
	if err != nil {
		return nil, domain.New(domain.Internal, "list items: "+err.Error())
	}
	defer rows.Close()

	items := make([]Item, 0)
	for rows.Next() {
		var item Item
		if err := rows.Scan(&item.ID, &item.Name); err != nil {
			return nil, domain.New(domain.Internal, "scan item: "+err.Error())
		}
		items = append(items, item)
	}
	if rows.Err() != nil {
		return nil, domain.New(domain.Internal, "list items: "+rows.Err().Error())
	}
	return items, nil
}

var _ ItemRepository = (*SqlItemRepository)(nil)
