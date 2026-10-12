"""보내기. 가짜 서버가 본체의 POST /api/imports 를 흉내 낸다(중복 열쇠로 가르는 것까지)."""

from __future__ import annotations

import json
from typing import Any

from collector import push
from collector.dedupe import dedupe_key

from .conftest import FakeServer, json_answer

SOURCE = {
    "id": "sample-outdoor-2026",
    "name": "가상 기관 옥외광고 현황",
    "url": "https://example.org/data/outdoor.csv",
    "license": "시험용",
    "fetchedAt": "2026-10-12T03:00:00+00:00",
}
WORKSPACE = "11111111-1111-4111-8111-111111111111"


def make_rows(count: int) -> list[dict[str, Any]]:
    return [{"line": n, "name": f"전광판 {n}", "address": f"가상로 {n}", "raw": {"이름": f"전광판 {n}"}} for n in range(1, count + 1)]


class Imports:
    """서버 흉내: 열쇠가 같은 줄은 중복, 공간의 줄 수 상한을 넘으면 LIMIT_EXCEEDED."""

    def __init__(self, limit: int = 2000, fail_first: int = 0, reject: tuple[int, str] | None = None) -> None:
        self.keys: dict[str, int] = {}
        self.limit = limit
        self.fail_first = fail_first
        self.reject = reject
        self.bodies: list[dict[str, Any]] = []

    def __call__(self, method: str, path: str, headers: dict[str, str], body: bytes) -> tuple[int, dict[str, str], bytes]:
        assert (method, path) == ("POST", "/api/imports")
        if self.fail_first > 0:
            self.fail_first -= 1
            return json_answer(503, {"code": "UNAVAILABLE", "message": "잠시 뒤에"})
        if self.reject:
            return json_answer(self.reject[0], {"code": self.reject[1], "message": "거절"})
        request = json.loads(body)
        self.bodies.append(request)
        items = [self._item(index, row) for index, row in enumerate(request["rows"])]
        count = {name: sum(1 for item in items if item["result"] == name) for name in ("new", "duplicate", "error")}
        batch = {"id": len(self.bodies), "received": len(items), "new": count["new"], "duplicate": count["duplicate"], "unreadable": count["error"]}
        return json_answer(202, {"workspace": headers.get("x-workspace") or WORKSPACE, "batch": batch, "items": items})

    def _item(self, index: int, row: dict[str, Any]) -> dict[str, Any]:
        key = dedupe_key(row)
        if key in self.keys:
            return {"index": index, "line": row["line"], "result": "duplicate", "itemId": self.keys[key]}
        if len(self.keys) >= self.limit:
            return {"index": index, "result": "error", "code": "LIMIT_EXCEEDED", "message": "가득 참"}
        self.keys[key] = len(self.keys) + 1
        return {"index": index, "line": row["line"], "result": "new", "itemId": self.keys[key]}


def send(server: FakeServer, rows: list[dict[str, Any]], workspace: str | None = WORKSPACE, slept: list[float] | None = None) -> tuple[push.PushTotals, str | None]:
    waits = slept if slept is not None else []
    return push.push_source(server.url + "/api/imports", SOURCE, rows, {"unreadable": 2, "duplicates": 3}, workspace, waits.append)


def test_sends_500_rows_per_request_with_the_workspace_header(fake_server: Any) -> None:
    imports = Imports()
    server = fake_server(imports)
    totals, workspace = send(server, make_rows(1201))
    assert [len(body["rows"]) for body in imports.bodies] == [500, 500, 201]
    assert (totals.requests, totals.sent, totals.received, totals.new, totals.duplicate) == (3, 1201, 1201, 1201, 0)
    assert workspace == WORKSPACE and totals.stopped == ""
    assert all(request["headers"]["x-workspace"] == WORKSPACE for request in server.requests)
    assert all(request["headers"]["content-type"] == "application/json" for request in server.requests)


def test_collector_counts_ride_only_on_the_first_request(fake_server: Any) -> None:
    imports = Imports()
    send(fake_server(imports), make_rows(600))
    assert imports.bodies[0]["collector"] == {"unreadable": 2, "duplicates": 3}
    assert "collector" not in imports.bodies[1]
    assert imports.bodies[0]["source"] == SOURCE


def test_sending_again_makes_no_new_rows(fake_server: Any) -> None:
    imports = Imports()
    server = fake_server(imports)
    send(server, make_rows(30))
    totals, _ = send(server, make_rows(30))
    assert (totals.new, totals.duplicate) == (0, 30)
    assert len(imports.keys) == 30


def test_without_a_workspace_the_first_answer_supplies_it(fake_server: Any) -> None:
    server = fake_server(Imports())
    _, workspace = send(server, make_rows(600), workspace=None)
    assert workspace == WORKSPACE
    assert "x-workspace" not in server.requests[0]["headers"]
    assert server.requests[1]["headers"]["x-workspace"] == WORKSPACE


def test_server_errors_are_retried_with_waits(fake_server: Any) -> None:
    slept: list[float] = []
    totals, _ = send(fake_server(Imports(fail_first=2)), make_rows(10), slept=slept)
    assert slept == [2.0, 5.0] and totals.retries == 2
    assert (totals.requests, totals.new, totals.stopped) == (1, 10, "")


def test_gives_up_after_the_last_retry(fake_server: Any) -> None:
    slept: list[float] = []
    server = fake_server(Imports(fail_first=99))
    totals, _ = send(server, make_rows(10), slept=slept)
    assert slept == [2.0, 5.0, 15.0] and len(server.requests) == 4
    assert totals.requests == 0 and "실패" in totals.stopped


def test_connection_failure_is_retried_then_reported() -> None:
    slept: list[float] = []
    totals, _ = push.push_source("http://127.0.0.1:9/api/imports", SOURCE, make_rows(3), {"unreadable": 0, "duplicates": 0}, WORKSPACE, slept.append)
    assert len(slept) == 3 and "연결 실패" in totals.stopped


def test_a_rejected_request_is_not_retried(fake_server: Any) -> None:
    slept: list[float] = []
    server = fake_server(Imports(reject=(403, "READ_ONLY_WORKSPACE")))
    totals, _ = send(server, make_rows(600), slept=slept)
    assert slept == [] and len(server.requests) == 1
    assert "READ_ONLY_WORKSPACE" in totals.stopped and totals.sent == 0


def test_stops_when_the_workspace_is_full(fake_server: Any) -> None:
    imports = Imports(limit=700)
    totals, _ = send(fake_server(imports), make_rows(1600))
    assert len(imports.bodies) == 2  # 셋째 묶음은 보내지 않는다
    assert (totals.new, totals.unreadable, totals.error_codes["LIMIT_EXCEEDED"]) == (700, 300, 300)
    assert "LIMIT_EXCEEDED" in totals.stopped


def test_chunks_respect_the_body_size_limit() -> None:
    rows = [{"line": n, "raw": {"글": "가" * 1000}} for n in range(1, 11)]
    chunks = list(push.chunk_rows(rows, max_rows=500, max_bytes=7000))
    assert [len(chunk) for chunk in chunks] == [2, 2, 2, 2, 2]
    assert len(push.build_body(SOURCE, make_rows(500), None)) < 3 * 1024 * 1024


def test_select_rows_skips_marks_and_limits() -> None:
    marks = {2: ["quantity_zero"], 4: ["coord_zero", "quantity_zero"]}
    picked = list(push.select_rows(make_rows(6), marks, {"quantity_zero"}, limit=3))
    assert [row["line"] for row in picked] == [1, 3, 5]
    assert len(list(push.select_rows(make_rows(6), marks, set(), None))) == 6


def test_dry_run_counts_without_sending() -> None:
    rows = make_rows(501) + [{"line": 0, "raw": {}}]
    assert push.dry_run("sample", rows) == {"source_id": "sample", "rows": 502, "requests": 2, "bad_rows": 1}
