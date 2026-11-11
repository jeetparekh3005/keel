package keelcore

import "testing"

func TestContractVersionMatchesTheContract(t *testing.T) {
	if ContractVersion != "0.2.0" {
		t.Fatalf("ContractVersion = %q, want %q", ContractVersion, "0.2.0")
	}
}
