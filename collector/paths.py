"""폴더와 파일 자리. 원자료와 정리 결과는 저장소 밖(자료 폴더)에 둔다."""

from __future__ import annotations

import os
from pathlib import Path

# 이 꾸러미가 놓인 폴더(collector/)
PACKAGE_DIR = Path(__file__).resolve().parent

# 사람이 손으로 관리하는 출처 목록
SOURCES_FILE = PACKAGE_DIR / "sources.json"

# 자료 폴더를 정하는 환경 변수
DATA_DIR_ENV = "CHAEUM_DATA_DIR"


def data_dir(explicit: str | None = None) -> Path:
    """자료 폴더. 명령 줄 값 → 환경 변수 → collector/.cache 순서로 고른다."""
    chosen = explicit or os.environ.get(DATA_DIR_ENV)
    return Path(chosen).expanduser() if chosen else PACKAGE_DIR / ".cache"


def raw_file(base: Path, source_id: str) -> Path:
    """받은 원본 파일의 자리: raw/<id>/<id>.csv"""
    return base / "raw" / source_id / f"{source_id}.csv"


def out_dir(base: Path) -> Path:
    """정리 결과를 쓰는 폴더: out/"""
    return base / "out"


def fetch_log_file(base: Path) -> Path:
    return out_dir(base) / "fetch-log.json"


def rows_file(base: Path, source_id: str) -> Path:
    """정리된 줄(JSON Lines). 한 줄이 서버에 보내는 줄 하나와 꼴이 같다."""
    return out_dir(base) / f"{source_id}.jsonl"


def marks_file(base: Path, source_id: str) -> Path:
    """줄마다 붙인 의심 표시. 서버로 보내지 않고 수집기만 쓴다."""
    return out_dir(base) / f"{source_id}.marks.jsonl"


def unreadable_file(base: Path, source_id: str) -> Path:
    """읽지 못해 뺀 줄의 번호와 까닭. 사람이 원본에서 찾아갈 때 쓴다."""
    return out_dir(base) / f"{source_id}.unreadable.jsonl"


def stats_file(base: Path, source_id: str) -> Path:
    return out_dir(base) / f"{source_id}.stats.json"


def push_log_file(base: Path) -> Path:
    return out_dir(base) / "push-log.json"
