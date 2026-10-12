"""파일 읽기: 글자 인코딩 판별과 CSV 읽기."""

from __future__ import annotations

import codecs
import csv
from collections.abc import Iterator
from pathlib import Path

_BOM = b"\xef\xbb\xbf"
_CHUNK = 1024 * 1024


class UnreadableFile(ValueError):
    """어느 인코딩으로도 읽히지 않는 파일."""


def detect_encoding(path: Path, hint: str | None) -> tuple[str, bool]:
    """(파이썬 코덱 이름, 짐작했는가)를 돌려준다.

    어느 길이든 파일 전체가 그 코덱으로 끝까지 풀리는지 확인한 뒤에 정한다.
    BOM 이 있으면 utf-8-sig 다. BOM 이 있는데 utf-8 로 풀리지 않으면 읽지 않는다(앞머리와 내용이 다른 깨진 파일이다).
    BOM 이 없으면 utf-8 → 힌트 → cp949 순서로 풀어 보고 처음 풀리는 것을 쓴다.
    utf-8 을 먼저 보는 까닭: cp949 글은 utf-8 로 거의 풀리지 않지만, 거꾸로는 깨진 글자로 풀려 버린다.
    짐작했다고 보는 때: utf-8 이 아닌 것으로 읽었는데 힌트가 없거나 힌트와 다를 때. utf-8 로 끝까지 풀렸으면 짐작이 아니다.
    """
    with path.open("rb") as handle:
        has_bom = handle.read(3) == _BOM
    if has_bom:
        if _decodes(path, "utf-8-sig"):
            return "utf-8-sig", False
        raise UnreadableFile(f"{path.name}: 앞머리(BOM)는 utf-8 인데 내용이 utf-8 로 읽히지 않습니다.")
    for codec in _candidates(hint):
        if _decodes(path, codec):
            return codec, _was_guessed(codec, hint)
    raise UnreadableFile(f"{path.name}: utf-8 로도 cp949 로도 읽히지 않습니다.")


def _candidates(hint: str | None) -> list[str]:
    ordered = ["utf-8", _plain(hint) if hint else "", "cp949"]
    return list(dict.fromkeys(codec for codec in ordered if codec))


def _plain(codec: str) -> str:
    """utf-8-sig 와 utf-8 은 같은 것으로 본다(BOM 은 따로 본다)."""
    name = codecs.lookup(codec).name
    return "utf-8" if name == "utf-8-sig" else name


def _was_guessed(codec: str, hint: str | None) -> bool:
    if codec == "utf-8":
        return False
    return hint is None or codec != _plain(hint)


def _decodes(path: Path, codec: str) -> bool:
    """파일 전체가 이 코덱으로 풀리는지 본다. 한 덩이씩 읽어 메모리를 아낀다."""
    decoder = codecs.getincrementaldecoder(codec)(errors="strict")
    try:
        with path.open("rb") as handle:
            while chunk := handle.read(_CHUNK):
                decoder.decode(chunk)
        decoder.decode(b"", final=True)
    except UnicodeDecodeError:
        return False
    return True


def count_lines(path: Path) -> int:
    """파일의 줄 수(줄바꿈 글자의 수, 끝 줄에 줄바꿈이 없으면 하나 더). 읽은 줄 수와 견줘 보는 데만 쓴다."""
    lines = 0
    last = b"\n"
    with path.open("rb") as handle:
        while chunk := handle.read(_CHUNK):
            lines += chunk.count(b"\n")
            last = chunk[-1:]
    return lines if last == b"\n" else lines + 1


def read_records(path: Path, codec: str) -> Iterator[list[str]]:
    """CSV 의 줄을 하나씩 낸다. 첫 줄이 머리줄이다.

    csv 모듈로 읽는다(따옴표 안에 쉼표가 든 칸이 있다). newline="" 은 csv 모듈이 줄바꿈을 직접 다루게 하려는 것이다.
    strict=True: 따옴표의 꼴이 깨진 줄(닫히지 않은 따옴표 등)을 조용히 넘기지 않고 csv.Error 로 올린다.
    닫히지 않은 따옴표는 뒤의 줄들을 한 칸으로 삼켜 버리기 때문이다.
    """
    with path.open(encoding=codec, newline="") as handle:
        yield from csv.reader(handle, strict=True)
