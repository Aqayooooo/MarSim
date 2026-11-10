"""Własny plan wyjścia: backend zwraca listę punktów razem z trasą (interfejs odtwarza z niej plan po odświeżeniu)."""


def test_route_reports_custom_waypoints(client):
    wps = [{"id": "WP1", "x": 643.5, "y": 526.5, "stopMin": 5}, {"id": "WP2", "x": 1000, "y": 300, "stopMin": 12}]
    assert client.post("/api/plan", json={"waypoints": wps}).status_code == 200
    body = client.get("/api/route").json()
    assert [w["id"] for w in body["waypoints"]] == ["WP1", "WP2"]
    assert body["waypoints"][1]["stopMin"] == 12
    assert body["route"]["waypointIds"] == ["WP1", "WP2"]


def test_route_without_plan_has_mission_waypoints(client):
    body = client.get("/api/route").json()
    assert body["route"] is None
    assert [w["id"] for w in body["waypoints"]] == [w["id"] for w in client.app.state.active().cfg["waypoints"]]
