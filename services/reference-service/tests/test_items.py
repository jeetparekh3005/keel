_AUTH = {"authorization": "Bearer tok"}


async def test_create_requires_authentication(client):
    response = await client.post("/v1/items", json={"name": "widget"})
    assert response.status_code == 401
    assert response.json()["type"] == "urn:keel:error:unauthenticated"


async def test_create_then_fetch(client):
    created = await client.post("/v1/items", json={"name": "widget"}, headers=_AUTH)
    assert created.status_code == 201
    item_id = created.json()["id"]
    # Location header points at the created resource (versioned path).
    assert created.headers["location"] == f"/v1/items/{item_id}"

    fetched = await client.get(f"/v1/items/{item_id}", headers=_AUTH)
    assert fetched.status_code == 200
    assert fetched.json() == {"id": item_id, "name": "widget"}


async def test_list_items_returns_envelope(client):
    await client.post("/v1/items", json={"name": "a"}, headers=_AUTH)
    await client.post("/v1/items", json={"name": "b"}, headers=_AUTH)
    listed = await client.get("/v1/items", headers=_AUTH)
    assert listed.status_code == 200
    body = listed.json()
    assert {item["name"] for item in body["items"]} == {"a", "b"}
    assert body["page"] == {"limit": 50, "offset": 0, "count": 2}


async def test_missing_item_is_problem_json_404(client):
    response = await client.get("/v1/items/does-not-exist", headers=_AUTH)
    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["type"] == "urn:keel:error:not_found"


async def test_health_is_live(client):
    assert (await client.get("/healthz")).status_code == 200


async def test_list_respects_limit(client):
    for index in range(3):
        await client.post("/v1/items", json={"name": f"n{index}"}, headers=_AUTH)
    listed = await client.get("/v1/items?limit=2", headers=_AUTH)
    assert listed.status_code == 200
    body = listed.json()
    assert len(body["items"]) == 2
    assert body["page"]["limit"] == 2
    assert body["page"]["count"] == 2
