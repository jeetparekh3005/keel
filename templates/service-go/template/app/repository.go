package app

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/domain"
	"github.com/jeetparekh3005/keel/packages/keel-core-go/persistence"
)

// Sql<< aggregate_pascal >>Repository is the Postgres-backed << aggregate_pascal >>Repository.
type Sql<< aggregate_pascal >>Repository struct {
	db *persistence.Database
}

// NewSql<< aggregate_pascal >>Repository wires the repository to the database.
func NewSql<< aggregate_pascal >>Repository(db *persistence.Database) *Sql<< aggregate_pascal >>Repository {
	return &Sql<< aggregate_pascal >>Repository{db: db}
}

// EnsureSchema creates the << aggregate_plural >> table if absent (dev convenience; production applies
// versioned migrations instead).
func (r *Sql<< aggregate_pascal >>Repository) EnsureSchema(ctx context.Context) error {
	_, err := r.db.Pool().Exec(ctx, `CREATE TABLE IF NOT EXISTS << aggregate_plural >> (id text PRIMARY KEY, name text NOT NULL)`)
	if err != nil {
		return domain.New(domain.Unavailable, "ensure schema: "+err.Error())
	}
	return nil
}

func (r *Sql<< aggregate_pascal >>Repository) Create(ctx context.Context, << aggregate >> << aggregate_pascal >>) error {
	if _, err := r.db.Pool().Exec(ctx, `INSERT INTO << aggregate_plural >> (id, name) VALUES ($1, $2)`, << aggregate >>.ID, << aggregate >>.Name); err != nil {
		return domain.New(domain.Internal, "insert << aggregate >>: "+err.Error())
	}
	return nil
}

func (r *Sql<< aggregate_pascal >>Repository) Get(ctx context.Context, id string) (<< aggregate_pascal >>, error) {
	var << aggregate >> << aggregate_pascal >>
	err := r.db.Pool().QueryRow(ctx, `SELECT id, name FROM << aggregate_plural >> WHERE id = $1`, id).Scan(&<< aggregate >>.ID, &<< aggregate >>.Name)
	if errors.Is(err, pgx.ErrNoRows) {
		return << aggregate_pascal >>{}, domain.New(domain.NotFound, "<< aggregate >> not found")
	}
	if err != nil {
		return << aggregate_pascal >>{}, domain.New(domain.Internal, "get << aggregate >>: "+err.Error())
	}
	return << aggregate >>, nil
}

func (r *Sql<< aggregate_pascal >>Repository) List(ctx context.Context, limit, offset int) ([]<< aggregate_pascal >>, error) {
	rows, err := r.db.Pool().Query(ctx, `SELECT id, name FROM << aggregate_plural >> ORDER BY id LIMIT $1 OFFSET $2`, limit, offset)
	if err != nil {
		return nil, domain.New(domain.Internal, "list << aggregate_plural >>: "+err.Error())
	}
	defer rows.Close()

	<< aggregate_plural >> := make([]<< aggregate_pascal >>, 0)
	for rows.Next() {
		var << aggregate >> << aggregate_pascal >>
		if err := rows.Scan(&<< aggregate >>.ID, &<< aggregate >>.Name); err != nil {
			return nil, domain.New(domain.Internal, "scan << aggregate >>: "+err.Error())
		}
		<< aggregate_plural >> = append(<< aggregate_plural >>, << aggregate >>)
	}
	if rows.Err() != nil {
		return nil, domain.New(domain.Internal, "list << aggregate_plural >>: "+rows.Err().Error())
	}
	return << aggregate_plural >>, nil
}

var _ << aggregate_pascal >>Repository = (*Sql<< aggregate_pascal >>Repository)(nil)
