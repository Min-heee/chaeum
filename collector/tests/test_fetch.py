"""받기. 공공 사이트에 요청을 보내지 않는다: 가짜 서버(127.0.0.1)와 견본 파일로만 본다."""

from __future__ import annotations

import dataclasses
import hashlib
import json
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from collector import fetch, paths
from collector.sources import Source

from .conftest import FIXTURES, FakeServer

KST = timezone(timedelta(hours=9))
# 무주 출처의 칸 이름이 든 머리줄(받기는 첫 줄에 그 출처의 칸 이름이 하나라도 있는지 본다)
CSV = "전광판구분,크기(cm),주소,위도,경도\r\n실외,540x100,가상로 1,35.9,127.5\r\n".encode("cp949")
ALLOW_ALL = b"User-agent: *\nAllow: /\n"


class Clock:
    """가짜 시계와 가짜 기다리기. 기다린 초를 적어 둔다."""

    def __init__(self) -> None:
        self.moment = datetime(2026, 10, 12, 9, 0, 0, tzinfo=KST)
        self.slept: list[float] = []

    def now(self) -> datetime:
        return self.moment

    def tools(self) -> fetch.Tools:
        return fetch.Tools(now=self.now, sleep=self.slept.append)


def site(robots: bytes | None, file: bytes, content_type: str = "text/csv") -> Any:
    """robots.txt 와 파일 하나를 주는 가짜 사이트."""

    def handler(method: str, path: str, headers: dict[str, str], body: bytes) -> tuple[int, dict[str, str], bytes]:
        if path == "/robots.txt":
            return (404, {}, b"") if robots is None else (200, {"Content-Type": "text/plain"}, robots)
        return 200, {"Content-Type": content_type}, file

    return handler


def source_at(sources: dict[str, Source], server: FakeServer, path: str = "/data/file.csv") -> Source:
    return dataclasses.replace(sources["muju-led"], download_url=server.url + path)


def test_downloads_after_robots_and_records_hash_and_time(tmp_path: Path, sources: dict[str, Source], fake_server: Any) -> None:
    server = fake_server(site(ALLOW_ALL, CSV))
    clock = Clock()
    entry = fetch.fetch_online(source_at(sources, server), tmp_path, fetch.FetchOptions(delay_seconds=7), clock.tools())
    assert entry["status"] == "downloaded"
    assert entry["sha256"] == hashlib.sha256(CSV).hexdigest() and entry["bytes"] == len(CSV)
    assert entry["fetched_at"] == "2026-10-12T09:00:00+09:00"
    assert paths.raw_file(tmp_path, "muju-led").read_bytes() == CSV
    assert [request["path"] for request in server.requests] == ["/robots.txt", "/data/file.csv"]
    assert all(request["headers"]["user-agent"].startswith("chaeum-collector/") for request in server.requests)
    assert clock.slept == [7]  # 두 요청 사이를 띄웠다


def test_robots_disallow_means_no_download(tmp_path: Path, sources: dict[str, Source], fake_server: Any) -> None:
    server = fake_server(site(b"User-agent: *\nDisallow: /data/\n", CSV))
    entry = fetch.fetch_online(source_at(sources, server), tmp_path, fetch.FetchOptions(), Clock().tools())
    assert entry["status"] == "refused" and "robots" in entry["note"]
    assert [request["path"] for request in server.requests] == ["/robots.txt"]
    assert not paths.raw_file(tmp_path, "muju-led").exists()


def test_missing_robots_means_no_rules(tmp_path: Path, sources: dict[str, Source], fake_server: Any) -> None:
    server = fake_server(site(None, CSV))
    entry = fetch.fetch_online(source_at(sources, server), tmp_path, fetch.FetchOptions(), Clock().tools())
    assert entry["status"] == "downloaded"


def test_robots_that_cannot_be_read_means_no_download(tmp_path: Path, sources: dict[str, Source], fake_server: Any) -> None:
    def handler(method: str, path: str, headers: dict[str, str], body: bytes) -> tuple[int, dict[str, str], bytes]:
        return (503, {}, b"") if path == "/robots.txt" else (200, {}, CSV)

    server = fake_server(handler)
    entry = fetch.fetch_online(source_at(sources, server), tmp_path, fetch.FetchOptions(), Clock().tools())
    assert entry["status"] == "refused"
    assert len(server.requests) == 1


def test_html_instead_of_csv_is_refused_and_leaves_no_file(tmp_path: Path, sources: dict[str, Source], fake_server: Any) -> None:
    server = fake_server(site(ALLOW_ALL, b"<!DOCTYPE html><html><body>notice</body></html>", "text/html"))
    entry = fetch.fetch_online(source_at(sources, server), tmp_path, fetch.FetchOptions(), Clock().tools())
    assert entry["status"] == "refused" and "HTML" in entry["note"]
    assert list((tmp_path / "raw" / "muju-led").iterdir()) == []


def test_existing_file_is_kept_without_any_request(tmp_path: Path, sources: dict[str, Source], fake_server: Any) -> None:
    server = fake_server(site(ALLOW_ALL, CSV))
    source = source_at(sources, server)
    fetch.fetch_all([source], tmp_path, False, fetch.FetchOptions(), Clock().tools())
    before = len(server.requests)
    result = fetch.fetch_all([source], tmp_path, False, fetch.FetchOptions(), Clock().tools())
    assert result["muju-led"]["status"] == "kept"
    assert len(server.requests) == before


def test_refresh_with_same_hash_keeps_the_first_fetch_time(tmp_path: Path, sources: dict[str, Source], fake_server: Any) -> None:
    server = fake_server(site(ALLOW_ALL, CSV))
    source = source_at(sources, server)
    clock = Clock()
    fetch.fetch_all([source], tmp_path, False, fetch.FetchOptions(), clock.tools())
    clock.moment += timedelta(days=30)
    result = fetch.fetch_all([source], tmp_path, False, fetch.FetchOptions(refresh=True), clock.tools())
    assert result["muju-led"]["status"] == "unchanged"
    assert result["muju-led"]["fetched_at"] == "2026-10-12T09:00:00+09:00"
    assert not paths.raw_file(tmp_path, "muju-led").with_suffix(".part").exists()


def test_refresh_with_new_content_replaces_the_file(tmp_path: Path, sources: dict[str, Source], fake_server: Any) -> None:
    content = [CSV]
    server = fake_server(lambda m, p, h, b: site(ALLOW_ALL, content[0])(m, p, h, b))
    source = source_at(sources, server)
    clock = Clock()
    fetch.fetch_all([source], tmp_path, False, fetch.FetchOptions(), clock.tools())
    content[0] = CSV + "실내,384x64,가상로 2,35.9,127.5\r\n".encode("cp949")
    clock.moment += timedelta(days=1)
    result = fetch.fetch_all([source], tmp_path, False, fetch.FetchOptions(refresh=True), clock.tools())
    assert result["muju-led"]["status"] == "downloaded"
    assert result["muju-led"]["fetched_at"] == "2026-10-13T09:00:00+09:00"
    assert paths.raw_file(tmp_path, "muju-led").read_bytes() == content[0]


def test_other_schemes_are_refused(tmp_path: Path, sources: dict[str, Source]) -> None:
    source = dataclasses.replace(sources["muju-led"], download_url="file:///etc/hosts")
    entry = fetch.fetch_online(source, tmp_path, fetch.FetchOptions(), Clock().tools())
    assert entry["status"] == "refused" and "http·https" in entry["note"]


# ── 다른 주소로 넘기는 답 ──────────────────────────────────


def redirecting(robots: bytes, moves: dict[str, str], files: dict[str, bytes]) -> Any:
    """robots.txt, 넘기는 주소(경로 → 가는 곳), 파일(경로 → 내용)을 가진 가짜 사이트."""

    def handler(method: str, path: str, headers: dict[str, str], body: bytes) -> tuple[int, dict[str, str], bytes]:
        if path == "/robots.txt":
            return 200, {"Content-Type": "text/plain"}, robots
        if path in moves:
            return 302, {"Location": moves[path]}, b""
        return (200, {"Content-Type": "text/csv"}, files[path]) if path in files else (404, {}, b"")

    return handler


def test_redirect_to_another_host_sends_nothing_there(tmp_path: Path, sources: dict[str, Source], fake_server: Any) -> None:
    other = fake_server(site(b"User-agent: *\nDisallow: /\n", CSV))
    server = fake_server(redirecting(ALLOW_ALL, {"/data/file.csv": other.url + "/secret.csv"}, {}))
    entry = fetch.fetch_online(source_at(sources, server), tmp_path, fetch.FetchOptions(), Clock().tools())
    assert entry["status"] == "refused" and "다른 호스트" in entry["note"]
    assert other.requests == []  # 목록에 없는 호스트에는 요청이 가지 않는다
    assert not paths.raw_file(tmp_path, "muju-led").exists()
    assert list((tmp_path / "raw" / "muju-led").iterdir()) == []


def test_redirect_to_a_disallowed_path_on_the_same_host_is_refused(tmp_path: Path, sources: dict[str, Source], fake_server: Any) -> None:
    robots = b"User-agent: *\nDisallow: /private/\n"
    server = fake_server(redirecting(robots, {"/data/file.csv": "/private/file.csv"}, {"/private/file.csv": CSV}))
    entry = fetch.fetch_online(source_at(sources, server), tmp_path, fetch.FetchOptions(), Clock().tools())
    assert entry["status"] == "refused" and "robots" in entry["note"]
    assert "/private/file.csv" not in [request["path"] for request in server.requests]


def test_redirect_inside_the_host_is_followed_after_robots_and_a_wait(tmp_path: Path, sources: dict[str, Source], fake_server: Any) -> None:
    server = fake_server(redirecting(ALLOW_ALL, {"/data/file.csv": "/files/real.csv"}, {"/files/real.csv": CSV}))
    clock = Clock()
    entry = fetch.fetch_online(source_at(sources, server), tmp_path, fetch.FetchOptions(delay_seconds=7), clock.tools())
    assert entry["status"] == "downloaded"
    assert paths.raw_file(tmp_path, "muju-led").read_bytes() == CSV
    # 넘겨진 주소로 가기 전에 robots 를 다시 읽었고, 요청마다 사이를 띄웠다.
    assert [request["path"] for request in server.requests] == ["/robots.txt", "/data/file.csv", "/robots.txt", "/files/real.csv"]
    assert clock.slept == [7, 7, 7]


def test_endless_redirects_stop(tmp_path: Path, sources: dict[str, Source], fake_server: Any) -> None:
    server = fake_server(redirecting(ALLOW_ALL, {"/data/file.csv": "/data/file.csv"}, {}))
    entry = fetch.fetch_online(source_at(sources, server), tmp_path, fetch.FetchOptions(), Clock().tools())
    assert entry["status"] == "refused" and "넘겨져" in entry["note"]
    assert [request["path"] for request in server.requests].count("/data/file.csv") == fetch.MAX_REDIRECTS + 1


def test_redirected_robots_is_not_followed_and_means_no_download(tmp_path: Path, sources: dict[str, Source], fake_server: Any) -> None:
    other = fake_server(site(ALLOW_ALL, CSV))

    def handler(method: str, path: str, headers: dict[str, str], body: bytes) -> tuple[int, dict[str, str], bytes]:
        return (302, {"Location": other.url + "/robots.txt"}, b"") if path == "/robots.txt" else (200, {}, CSV)

    server = fake_server(handler)
    entry = fetch.fetch_online(source_at(sources, server), tmp_path, fetch.FetchOptions(), Clock().tools())
    assert entry["status"] == "refused"
    assert other.requests == [] and len(server.requests) == 1


# ── 간격 ───────────────────────────────────────────────────


def test_crawl_delay_from_robots_is_honoured_when_longer(tmp_path: Path, sources: dict[str, Source], fake_server: Any) -> None:
    server = fake_server(site(b"User-agent: *\nCrawl-delay: 30\nAllow: /\n", CSV))
    clock = Clock()
    fetch.fetch_online(source_at(sources, server), tmp_path, fetch.FetchOptions(delay_seconds=5), clock.tools())
    assert clock.slept == [30]
    # 정한 간격이 더 길면 그 값이다.
    clock = Clock()
    fetch.fetch_online(source_at(sources, server), tmp_path, fetch.FetchOptions(delay_seconds=45, refresh=True), clock.tools())
    assert clock.slept == [45]


def test_delay_has_a_floor(tmp_path: Path, sources: dict[str, Source], fake_server: Any) -> None:
    for asked in (0, -3, 0.2):
        server = fake_server(site(ALLOW_ALL, CSV))
        clock = Clock()
        fetch.fetch_online(source_at(sources, server), tmp_path, fetch.FetchOptions(delay_seconds=asked, refresh=True), clock.tools())
        assert clock.slept == [fetch.MIN_DELAY_SECONDS]


# ── 받지 않는 답 ───────────────────────────────────────────


def test_robots_connection_failure_means_refused_not_tried(tmp_path: Path, sources: dict[str, Source], fake_server: Any) -> None:
    server = fake_server(site(ALLOW_ALL, CSV))
    url = server.url
    server.__exit__()  # 서버를 내린다. robots.txt 를 읽을 수 없다
    source = dataclasses.replace(sources["muju-led"], download_url=url + "/data/file.csv")
    entry = fetch.fetch_online(source, tmp_path, fetch.FetchOptions(), Clock().tools())
    assert entry["status"] == "refused" and "robots" in entry["note"]


def test_error_text_with_status_200_is_not_saved_over_a_good_file(tmp_path: Path, sources: dict[str, Source], fake_server: Any) -> None:
    content = [CSV]
    server = fake_server(lambda m, p, h, b: site(ALLOW_ALL, content[0])(m, p, h, b))
    source = source_at(sources, server)
    fetch.fetch_all([source], tmp_path, False, fetch.FetchOptions(), Clock().tools())
    for answer in (b'{"error":"login required"}', b"<div class='notice'>closed</div>", "점검 중입니다\r\n".encode("cp949")):
        content[0] = answer
        result = fetch.fetch_all([source], tmp_path, False, fetch.FetchOptions(refresh=True), Clock().tools())
        assert result["muju-led"]["status"] == "refused", answer
        assert paths.raw_file(tmp_path, "muju-led").read_bytes() == CSV  # 있던 파일은 그대로다
        assert not paths.raw_file(tmp_path, "muju-led").with_suffix(".part").exists()


def test_utf8_header_with_bom_passes_the_first_line_check(tmp_path: Path, sources: dict[str, Source], fake_server: Any) -> None:
    body = b"\xef\xbb\xbf" + CSV.decode("cp949").encode("utf-8")
    server = fake_server(site(ALLOW_ALL, body))
    entry = fetch.fetch_online(source_at(sources, server), tmp_path, fetch.FetchOptions(), Clock().tools())
    assert entry["status"] == "downloaded"


def test_empty_answer_is_refused(tmp_path: Path, sources: dict[str, Source], fake_server: Any) -> None:
    server = fake_server(site(ALLOW_ALL, b""))
    entry = fetch.fetch_online(source_at(sources, server), tmp_path, fetch.FetchOptions(), Clock().tools())
    assert entry["status"] == "refused" and "빈 파일" in entry["note"]
    assert list((tmp_path / "raw" / "muju-led").iterdir()) == []


def test_too_big_answer_is_refused(tmp_path: Path, sources: dict[str, Source], fake_server: Any, monkeypatch: Any) -> None:
    monkeypatch.setattr(fetch, "MAX_BYTES", len(CSV) + 10)
    server = fake_server(site(ALLOW_ALL, CSV + b"x" * 11))
    entry = fetch.fetch_online(source_at(sources, server), tmp_path, fetch.FetchOptions(), Clock().tools())
    assert entry["status"] == "refused" and "100MB" in entry["note"]
    assert list((tmp_path / "raw" / "muju-led").iterdir()) == []
    # 꼭 상한까지는 받는다.
    exact = fake_server(site(ALLOW_ALL, CSV + b"x" * 10))
    assert fetch.fetch_online(source_at(sources, exact), tmp_path, fetch.FetchOptions(), Clock().tools())["status"] == "downloaded"


def test_server_error_is_recorded_as_failed(tmp_path: Path, sources: dict[str, Source], fake_server: Any) -> None:
    def handler(method: str, path: str, headers: dict[str, str], body: bytes) -> tuple[int, dict[str, str], bytes]:
        return (200, {}, ALLOW_ALL) if path == "/robots.txt" else (500, {}, b"")

    entry = fetch.fetch_online(source_at(sources, fake_server(handler)), tmp_path, fetch.FetchOptions(), Clock().tools())
    assert entry["status"] == "failed"


def put_fixture(base: Path, source_id: str) -> Path:
    target = paths.raw_file(base, source_id)
    target.parent.mkdir(parents=True)
    shutil.copyfile(FIXTURES / f"{source_id}.csv", target)
    return target


def test_offline_uses_the_stored_file_and_the_manifest_time(tmp_path: Path, sources: dict[str, Source]) -> None:
    target = put_fixture(tmp_path, "imsil-led")
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    manifest = {"datasets": [{"id": "imsil-led", "sha256": digest, "fetched_at": "2026-10-12T16:07:01+0900"}]}
    (tmp_path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    result = fetch.fetch_all([sources["imsil-led"]], tmp_path, True, fetch.FetchOptions(), Clock().tools())
    assert result["imsil-led"]["status"] == "offline"
    assert result["imsil-led"]["sha256"] == digest
    assert result["imsil-led"]["fetched_at"] == "2026-10-12T16:07:01+09:00"
    assert fetch.read_log(tmp_path)["imsil-led"]["sha256"] == digest


def test_offline_without_manifest_says_the_time_is_the_file_time(tmp_path: Path, sources: dict[str, Source]) -> None:
    put_fixture(tmp_path, "imsil-led")
    entry = fetch.fetch_offline(sources["imsil-led"], tmp_path)
    assert entry["status"] == "offline" and "고친 시각" in entry["note"]
    assert datetime.fromisoformat(entry["fetched_at"]).tzinfo is not None


def test_offline_missing_file(tmp_path: Path, sources: dict[str, Source]) -> None:
    assert fetch.fetch_offline(sources["imsil-led"], tmp_path)["status"] == "missing"


def test_looks_like_html() -> None:
    assert fetch.looks_like_html(b"\xef\xbb\xbf <!DOCTYPE html>")
    assert fetch.looks_like_html(b"<html lang='ko'>")
    assert not fetch.looks_like_html("연번,호선\r\n".encode("cp949"))
    assert fetch.looks_like_html(b"<div>notice</div>") and fetch.looks_like_html(b"\r\n<BODY>")
