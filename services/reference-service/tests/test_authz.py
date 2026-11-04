_READONLY = {"authorization": "Bearer readonly"}
_FULL = {"authorization": "Bearer tok"}


async def test_read_scope_can_list(client):
    assert (await client.get("/v1/items", headers=_READONLY)).status_code == 200


async def test_write_requires_write_scope(client):
    response = await client.post("/v1/items", json={"name": "x"}, headers=_READONLY)
    assert response.status_code == 403
    assert response.json()["type"] == "urn:keel:error:forbidden"


async def test_write_scope_can_create(client):
    assert (await client.post("/v1/items", json={"name": "x"}, headers=_FULL)).status_code == 201


async def test_oversized_name_is_rejected_with_invalid_params(client):
    response = await client.post("/v1/items", json={"name": "a" * 500}, headers=_FULL)
    assert response.status_code == 400
    assert response.headers["content-type"].startswith("application/problem+json")
    body = response.json()
    # RFC 9457 extension: the offending field is named so the client can fix it.
    assert body["invalid-params"]
    assert any("name" in param["name"] for param in body["invalid-params"])
