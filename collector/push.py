"""보내기: 정리한 줄을 본체의 POST /api/imports 로 넘긴다(docs/IMPORT-FORMAT.md).

- 한 번에 500줄, 본문 3MB 까지. 요청 하나 = 출처 하나.
- 다시 보내도 줄이 겹치지 않는다. 서버가 중복 열쇠로 가르기 때문이다(다만 묶음은 보낼 때마다 하나씩 는다).
- 연결이 안 되거나 서버 오류(5xx)면 간격을 두고 몇 번 다시 보낸다. 요청이 틀렸다는 답(4xx)은 다시 보내지 않는다.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from collections import Counter
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .rowshape import row_problems

ROWS_PER_REQUEST = 500
# 서버의 한도는 3MB 다. 출처와 수집기 칸이 붙을 자리를 남긴다.
BODY_MAX_BYTES = 3 * 1024 * 1024 - 16 * 1024
TIMEOUT_SECONDS = 60
RETRY_WAITS_SECONDS = (2.0, 5.0, 15.0)


class PushStopped(Exception):
    """서버가 요청 전체를 거절했다(4xx). 다시 보내도 같으므로 멈춘다."""


@dataclass
class PushTotals:
    """출처 하나를 보낸 결과. 서버가 준 수를 그대로 더한다."""

    source_id: str
    requests: int = 0
    sent: int = 0
    received: int = 0
    new: int = 0
    duplicate: int = 0
    unreadable: int = 0
    error_codes: Counter[str] = field(default_factory=Counter)
    retries: int = 0
    stopped: str = ""

    def to_json(self) -> dict[str, Any]:
        data = dict(self.__dict__)
        data["error_codes"] = dict(self.error_codes)
        return data


# ── 줄 읽기와 나누기 ───────────────────────────────────────


def read_rows(path: Path) -> Iterator[dict[str, Any]]:
    with path.open(encoding="utf-8") as handle:
        for text in handle:
            if text.strip():
                yield json.loads(text)


def count_rows(path: Path) -> int:
    """결과 파일의 줄 수. 파일이 없으면 0."""
    if not path.exists():
        return 0
    with path.open(encoding="utf-8") as handle:
        return sum(1 for text in handle if text.strip())


def read_marks(path: Path) -> dict[int, list[str]]:
    """줄 번호 → 표시 목록. 곁 파일이 없으면 빈 것이다."""
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as handle:
        entries = [json.loads(text) for text in handle if text.strip()]
    return {entry["line"]: entry["marks"] for entry in entries}


def select_rows(
    rows: Iterable[dict[str, Any]], marks: dict[int, list[str]], skip_marks: set[str], limit: int | None
) -> Iterator[dict[str, Any]]:
    """보낼 줄 고르기: 빼기로 한 표시가 붙은 줄을 빼고, 앞에서부터 limit 줄까지."""
    count = 0
    for row in rows:
        if skip_marks.intersection(marks.get(row["line"], [])):
            continue
        if limit is not None and count >= limit:
            return
        count += 1
        yield row


def chunk_rows(rows: Iterable[dict[str, Any]], max_rows: int = ROWS_PER_REQUEST, max_bytes: int = BODY_MAX_BYTES) -> Iterator[list[dict[str, Any]]]:
    """줄 수와 본문 크기 한도 안에서 묶음으로 나눈다."""
    chunk: list[dict[str, Any]] = []
    size = 0
    for row in rows:
        row_bytes = len(json.dumps(row, ensure_ascii=False).encode("utf-8")) + 1
        if chunk and (len(chunk) >= max_rows or size + row_bytes > max_bytes):
            yield chunk
            chunk, size = [], 0
        chunk.append(row)
        size += row_bytes
    if chunk:
        yield chunk


def build_body(source: dict[str, str], rows: list[dict[str, Any]], collector: dict[str, int] | None) -> bytes:
    body: dict[str, Any] = {"source": source, "rows": rows}
    if collector is not None:
        body["collector"] = collector
    return json.dumps(body, ensure_ascii=False).encode("utf-8")


# ── 요청 하나 ──────────────────────────────────────────────


def post_once(url: str, body: bytes, workspace: str | None) -> tuple[int, dict[str, Any]]:
    """요청을 한 번 보낸다. (상태 코드, 답의 JSON)을 돌려준다. 연결 실패는 예외로 올린다."""
    headers = {"Content-Type": "application/json"}
    if workspace:
        headers["X-Workspace"] = workspace
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:  # noqa: S310
            return response.status, _json_or_empty(response.read())
    except urllib.error.HTTPError as error:
        return error.code, _json_or_empty(error.read())


def _json_or_empty(data: bytes) -> dict[str, Any]:
    try:
        parsed = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def post_with_retry(
    url: str, body: bytes, workspace: str | None, sleep: Callable[[float], None], totals: PushTotals
) -> dict[str, Any]:
    """연결 실패와 5xx 는 간격을 두고 다시 보낸다. 4xx 는 PushStopped 로 멈춘다."""
    last = "보내지 못함"
    for wait in (0.0, *RETRY_WAITS_SECONDS):
        if wait:
            totals.retries += 1
            sleep(wait)
        try:
            status, answer = post_once(url, body, workspace)
        except (urllib.error.URLError, OSError) as error:
            last = f"연결 실패: {error}"
            continue
        if status < 300:
            return answer
        last = f"{status} {answer.get('code', '')} {answer.get('message', '')}".strip()
        if status < 500:
            raise PushStopped(last)
    raise PushStopped(f"여러 번 다시 보냈지만 실패: {last}")


# ── 출처 하나 ──────────────────────────────────────────────


def add_answer(totals: PushTotals, answer: dict[str, Any]) -> bool:
    """답의 수를 더한다. 공간이 가득 찼다는 줄이 있으면 True(더 보내도 소용없다)."""
    batch = answer.get("batch", {})
    for name in ("received", "new", "duplicate", "unreadable"):
        setattr(totals, name, getattr(totals, name) + int(batch.get(name, 0)))
    codes = [item.get("code", "") for item in answer.get("items", []) if item.get("result") == "error"]
    totals.error_codes.update(codes)
    return "LIMIT_EXCEEDED" in codes


def push_source(
    api_url: str,
    source: dict[str, str],
    rows: Iterable[dict[str, Any]],
    collector: dict[str, int] | None,
    workspace: str | None,
    sleep: Callable[[float], None],
) -> tuple[PushTotals, str | None]:
    """출처 하나의 줄을 나눠 보낸다. (결과, 작업 공간 번호)를 돌려준다.

    수집기가 스스로 뺀 줄 수(collector)는 첫 요청에만 싣는다(겹쳐 세지 않게). None 이면 싣지 않는다(줄을 골라 보낼 때).
    공간 번호 없이 시작하면 서버가 첫 답에 준 번호를 다음 요청부터 쓴다.
    """
    totals = PushTotals(source["id"])
    for index, chunk in enumerate(chunk_rows(rows)):
        body = build_body(source, chunk, collector if index == 0 else None)
        try:
            answer = post_with_retry(api_url, body, workspace, sleep, totals)
        except PushStopped as stopped:
            totals.stopped = str(stopped)
            break
        totals.requests += 1
        totals.sent += len(chunk)
        workspace = workspace or answer.get("workspace")
        if add_answer(totals, answer):
            totals.stopped = "공간에 모아 둘 수 있는 줄 수에 닿아 멈춤(LIMIT_EXCEEDED)"
            break
    return totals, workspace


def dry_run(source_id: str, rows: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """보내지 않고 센다: 줄 수, 요청 수, 꼴이 틀린 줄 수."""
    chunks = 0
    count = 0
    bad = 0
    for chunk in chunk_rows(rows):
        chunks += 1
        count += len(chunk)
        bad += sum(1 for row in chunk if row_problems(row))
    return {"source_id": source_id, "rows": count, "requests": chunks, "bad_rows": bad}
