"""시험이 함께 쓰는 것: 견본 폴더, 출처 목록, 가짜 서버."""

from __future__ import annotations

import json
import threading
from collections.abc import Callable, Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from collector import paths
from collector.sources import Source, load_sources

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(scope="session")
def sources() -> dict[str, Source]:
    return {source.id: source for source in load_sources(paths.SOURCES_FILE)}


Handler = Callable[[str, str, dict[str, str], bytes], tuple[int, dict[str, str], bytes]]


class FakeServer:
    """127.0.0.1 에 잠깐 뜨는 가짜 서버. 받은 요청을 적어 두고, 시험이 준 함수로 답한다."""

    def __init__(self, handler: Handler) -> None:
        self.requests: list[dict[str, Any]] = []
        outer = self

        class _Handler(BaseHTTPRequestHandler):
            def _serve(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                headers = {key.lower(): value for key, value in self.headers.items()}
                outer.requests.append({"method": self.command, "path": self.path, "headers": headers, "body": body})
                status, answer_headers, answer = handler(self.command, self.path, headers, body)
                self.send_response(status)
                for key, value in answer_headers.items():
                    self.send_header(key, value)
                self.send_header("Content-Length", str(len(answer)))
                self.end_headers()
                self.wfile.write(answer)

            do_GET = _serve  # noqa: N815
            do_POST = _serve  # noqa: N815

            def log_message(self, *args: Any) -> None:  # 시험 출력에 접속 기록을 찍지 않는다
                return

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.url = f"http://127.0.0.1:{self._server.server_address[1]}"
        self._thread = threading.Thread(target=self._server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)

    def __enter__(self) -> "FakeServer":
        self._thread.start()
        return self

    def __exit__(self, *args: Any) -> None:
        self._server.shutdown()
        self._server.server_close()


@pytest.fixture
def fake_server() -> Iterator[Callable[[Handler], FakeServer]]:
    started: list[FakeServer] = []

    def start(handler: Handler) -> FakeServer:
        server = FakeServer(handler).__enter__()
        started.append(server)
        return server

    yield start
    for server in started:
        server.__exit__()


def json_answer(status: int, data: dict[str, Any]) -> tuple[int, dict[str, str], bytes]:
    return status, {"Content-Type": "application/json"}, json.dumps(data, ensure_ascii=False).encode("utf-8")
