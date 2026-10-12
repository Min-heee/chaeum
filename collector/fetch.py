"""받기: 출처의 파일을 내려받거나(--offline 이면) 받아 둔 파일을 확인한다.

지키는 것
- robots.txt 를 먼저 읽고, 막혀 있으면 받지 않는다. robots.txt 를 읽지 못해도 받지 않는다(없음 404 는 "규칙 없음"이다).
- 요청과 요청 사이를 띄운다(아래 끝 1초. robots.txt 의 Crawl-delay 가 더 길면 그 값). User-Agent 로 누구인지 밝힌다.
- 다른 주소로 넘기는 답(3xx)을 저절로 따라가지 않는다. 같은 호스트 안에서만, 넘겨진 주소마다 robots 와 간격을 다시 본 뒤 따라간다.
  다른 호스트로 넘기면 그 호스트에는 요청을 보내지 않고 멈춘다. robots.txt 가 다른 곳으로 넘겨지면 읽지 못한 것으로 본다.
- 로그인·양식 제출·자동입력 방지 넘기기를 하지 않는다. CSV 대신 HTML 이 오거나, 첫 줄에 이 출처의 칸 이름이 하나도 없으면 멈춘다.
- 이미 받은 파일이 있으면 다시 요청하지 않는다(--refresh 일 때만 다시 받고, 내용이 같으면 그대로 둔다).
"""

from __future__ import annotations

import hashlib
import json
import os
import urllib.error
import urllib.request
import urllib.robotparser
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlsplit

from . import __version__, paths
from .sources import Source, needed_columns

USER_AGENT = f"chaeum-collector/{__version__} (public open-data file fetch; python-urllib)"
DEFAULT_DELAY_SECONDS = 5.0
# 요청 사이 간격의 아래 끝. 명령 줄이나 부르는 쪽이 더 짧게 줘도 이만큼은 띄운다.
MIN_DELAY_SECONDS = 1.0
# 같은 호스트 안에서 넘겨지는 것을 따라가는 횟수
MAX_REDIRECTS = 3
MAX_BYTES = 100 * 1024 * 1024
TIMEOUT_SECONDS = 60
_CHUNK = 256 * 1024


@dataclass
class FetchOptions:
    refresh: bool = False
    delay_seconds: float = DEFAULT_DELAY_SECONDS
    user_agent: str = USER_AGENT


@dataclass
class Tools:
    """시계와 기다리기. 시험에서는 가짜를 넣는다."""

    now: Callable[[], datetime]
    sleep: Callable[[float], None]
    requests_made: int = 0
    # 호스트마다 robots.txt 가 바란 간격(Crawl-delay). 읽은 뒤에 채운다.
    crawl_delays: dict[str, float] = field(default_factory=dict)


class FetchRefused(Exception):
    """받지 않기로 한 까닭(robots, HTML 응답, 너무 큼 등)."""


# ── 기록 ───────────────────────────────────────────────────


def read_log(base: Path) -> dict[str, dict[str, Any]]:
    path = paths.fetch_log_file(base)
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def write_log(base: Path, log: dict[str, dict[str, Any]]) -> None:
    path = paths.fetch_log_file(base)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(log, handle, ensure_ascii=False, indent=2, sort_keys=True)


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def _entry(source: Source, path: Path, status: str, fetched_at: str, note: str = "") -> dict[str, Any]:
    return {
        "status": status,
        "url": source.download_url,
        "path": str(path),
        "bytes": path.stat().st_size,
        "sha256": sha256_of(path),
        "fetched_at": fetched_at,
        "note": note,
    }


def _failed(source: Source, status: str, note: str) -> dict[str, Any]:
    return {"status": status, "url": source.download_url, "note": note}


# ── 받아 둔 파일 쓰기(--offline) ────────────────────────────


def fetch_offline(source: Source, base: Path) -> dict[str, Any]:
    """받아 둔 파일을 확인하고 기록한다. 요청을 보내지 않는다."""
    path = paths.raw_file(base, source.id)
    if not path.exists():
        return _failed(source, "missing", f"받아 둔 파일이 없습니다: raw/{source.id}/{source.id}.csv")
    digest = sha256_of(path)
    fetched_at, note = _known_fetch_time(base, source.id, digest, path)
    return _entry(source, path, "offline", fetched_at, note)


def _known_fetch_time(base: Path, source_id: str, digest: str, path: Path) -> tuple[str, str]:
    """받은 시각을 찾는다: 지난 기록 → 자료 폴더의 manifest.json → 파일의 고친 시각."""
    earlier = read_log(base).get(source_id, {})
    if earlier.get("sha256") == digest and earlier.get("fetched_at"):
        return earlier["fetched_at"], earlier.get("note", "")
    for item in _manifest_items(base):
        if item.get("id") == source_id and item.get("sha256") == digest and item.get("fetched_at"):
            return _iso(datetime.fromisoformat(item["fetched_at"])), "받은 시각은 manifest.json 에서 읽음"
    modified = datetime.fromtimestamp(path.stat().st_mtime).astimezone()
    return _iso(modified), "받은 시각을 몰라 파일의 고친 시각을 적음"


def _manifest_items(base: Path) -> list[dict[str, Any]]:
    path = base / "manifest.json"
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as handle:
        return json.load(handle).get("datasets", [])


def _iso(moment: datetime) -> str:
    """시간대가 붙은 ISO 8601(서버가 받는 꼴: 2026-10-12T16:07:45+09:00)."""
    return moment.replace(microsecond=0).isoformat()


# ── 내려받기 ───────────────────────────────────────────────


def fetch_online(source: Source, base: Path, options: FetchOptions, tools: Tools) -> dict[str, Any]:
    """파일 하나를 받는다. 이미 있으면 --refresh 가 아닌 한 요청하지 않는다."""
    path = paths.raw_file(base, source.id)
    earlier = read_log(base).get(source.id, {})
    if path.exists() and not options.refresh:
        fetched_at, note = _known_fetch_time(base, source.id, sha256_of(path), path)
        return _entry(source, path, "kept", fetched_at, note or "이미 받은 파일이 있어 요청하지 않음")
    try:
        temp = _download_checked(source.download_url, path, options, tools)
        _check_first_line(source, temp)
    except FetchRefused as refused:
        return _failed(source, "refused", str(refused))
    except (urllib.error.URLError, OSError) as error:
        return _failed(source, "failed", f"{type(error).__name__}: {error}")
    return _keep_or_replace(source, path, temp, earlier, tools)


def _check_first_line(source: Source, temp: Path) -> None:
    """받은 것의 첫 줄에 이 출처의 칸 이름이 하나라도 있는지 본다. 없으면 버린다.

    200 으로 온 오류 글(JSON, 안내 문구)이 있던 파일을 덮어쓰지 않게 하려는 것이다. 칸 이름이 다 맞는지는 정리 단계가 본다.
    """
    with temp.open("rb") as handle:
        head = handle.read(64 * 1024).split(b"\n", 1)[0]
    texts = [head.decode(codec, errors="replace") for codec in ("utf-8", "cp949")]
    if not any(name in text for name in needed_columns(source) for text in texts):
        temp.unlink(missing_ok=True)
        raise FetchRefused("받은 것의 첫 줄에 이 출처의 칸 이름이 하나도 없습니다(오류 글이나 다른 파일일 수 있음). 저장하지 않았습니다.")


def _keep_or_replace(source: Source, path: Path, temp: Path, earlier: dict[str, Any], tools: Tools) -> dict[str, Any]:
    """새로 받은 것이 있던 파일과 같으면 그대로 두고(받은 시각도 그대로), 다르면 바꾼다."""
    if path.exists() and sha256_of(path) == sha256_of(temp):
        temp.unlink()
        fetched_at = earlier.get("fetched_at") or _iso(tools.now())
        return _entry(source, path, "unchanged", fetched_at, f"{_iso(tools.now())} 에 다시 받았고 내용이 같음")
    os.replace(temp, path)
    return _entry(source, path, "downloaded", _iso(tools.now()))


def _download_checked(url: str, path: Path, options: FetchOptions, tools: Tools) -> Path:
    """주소의 꼴 → robots → 간격 → 받기. 같은 호스트 안에서 넘겨지면 넘겨진 주소로 이 순서를 처음부터 다시 밟는다."""
    host = urlsplit(url).netloc
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".part")
    for _ in range(MAX_REDIRECTS + 1):
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https"):
            raise FetchRefused("http·https 주소만 받습니다.")
        if parts.netloc != host:
            # 그 호스트에는 요청을 보내지 않는다(목록에 사람이 적은 호스트가 아니다).
            raise FetchRefused(f"다른 호스트({parts.netloc})로 넘겨져 받지 않았습니다.")
        if not robots_allows(url, options, tools):
            raise FetchRefused("robots.txt 가 막았거나 robots.txt 를 읽지 못했습니다.")
        _wait(options, tools, host)
        try:
            moved_to = _download(url, temp, options.user_agent)
        except BaseException:
            temp.unlink(missing_ok=True)  # 받다 만 조각을 남기지 않는다
            raise
        if moved_to is None:
            return temp
        url = urljoin(url, moved_to)
    raise FetchRefused(f"{MAX_REDIRECTS}번 넘게 다른 주소로 넘겨져 멈췄습니다.")


def _wait(options: FetchOptions, tools: Tools, host: str = "") -> None:
    """첫 요청이 아니면 요청 사이를 띄운다. 간격은 정한 값, 아래 끝, 그 호스트의 Crawl-delay 가운데 가장 긴 것이다."""
    if tools.requests_made > 0:
        tools.sleep(max(options.delay_seconds, MIN_DELAY_SECONDS, tools.crawl_delays.get(host, 0.0)))
    tools.requests_made += 1


def robots_allows(url: str, options: FetchOptions, tools: Tools) -> bool:
    """그 호스트의 robots.txt 가 이 주소를 우리 User-Agent 에게 허락하는가. Crawl-delay 가 적혀 있으면 기억해 둔다."""
    parts = urlsplit(url)
    robots_url = f"{parts.scheme}://{parts.netloc}/robots.txt"
    _wait(options, tools, parts.netloc)
    try:
        with _open(robots_url, options.user_agent) as response:
            text = response.read(512 * 1024).decode("utf-8", errors="replace")
    except urllib.error.HTTPError as error:
        # 없으면(404·410) 규칙이 없는 것이다. 그 밖의 오류와 다른 곳으로 넘기는 답(3xx)은 허락을 확인하지 못한 것이므로 받지 않는다.
        return error.code in (404, 410)
    except (urllib.error.URLError, OSError):
        return False
    parser = urllib.robotparser.RobotFileParser()
    parser.parse(text.splitlines())
    delay = parser.crawl_delay(options.user_agent)
    if delay:
        tools.crawl_delays[parts.netloc] = float(delay)
    return parser.can_fetch(options.user_agent, url)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """넘기는 답(3xx)을 저절로 따라가지 않는다. urllib 은 이때 그 답을 HTTPError 로 올린다."""

    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def _open(url: str, user_agent: str) -> Any:
    request = urllib.request.Request(url, headers={"User-Agent": user_agent})
    return _OPENER.open(request, timeout=TIMEOUT_SECONDS)  # noqa: S310 (주소의 꼴은 부르는 쪽이 본다)


def _download(url: str, temp: Path, user_agent: str) -> str | None:
    """파일을 임시 자리에 받는다. HTML 이 왔거나 너무 크거나 비었으면 버린다.

    다른 주소로 넘기는 답이 오면 받지 않고 그 주소를 돌려준다(따라갈지는 부르는 쪽이 정한다). 다 받았으면 None.
    """
    try:
        response = _open(url, user_agent)
    except urllib.error.HTTPError as error:
        location = error.headers.get("Location") if error.code in (301, 302, 303, 307, 308) else None
        if location:
            return location
        raise
    with response, temp.open("wb") as out:
        total = 0
        while chunk := response.read(_CHUNK):
            if total == 0 and looks_like_html(chunk):
                raise FetchRefused("CSV 가 아니라 HTML 이 왔습니다(안내·오류 페이지일 수 있음). 멈춥니다.")
            total += len(chunk)
            if total > MAX_BYTES:
                raise FetchRefused("파일이 100MB 를 넘어 받지 않았습니다.")
            out.write(chunk)
    if total == 0:
        raise FetchRefused("빈 파일이 왔습니다.")
    return None


def looks_like_html(head: bytes) -> bool:
    start = head.lstrip(b"\xef\xbb\xbf \t\r\n")[:200].lower()
    return start.startswith((b"<!doctype", b"<html", b"<?xml", b"<head", b"<script", b"<body", b"<div", b"<meta", b"<title"))


def fetch_all(sources: list[Source], base: Path, offline: bool, options: FetchOptions, tools: Tools) -> dict[str, dict[str, Any]]:
    """출처들을 차례로 받고 기록 파일을 고친다. 하나가 틀려도 나머지는 이어서 한다."""
    log = read_log(base)
    for source in sources:
        entry = fetch_offline(source, base) if offline else fetch_online(source, base, options, tools)
        log[source.id] = entry
        write_log(base, log)
    return {source.id: log[source.id] for source in sources}
