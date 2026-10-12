"""명령 줄을 처음부터 끝까지: 받아 둔 파일 확인 → 정리 → 보내기(가짜 서버) → 보고."""

from __future__ import annotations

import json
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any

import pytest

from collector import paths
from collector.__main__ import main

from .conftest import FIXTURES
from .test_push import WORKSPACE, Imports

IDS = ["jeonju-led", "iksan-led", "seoul-metro-ad-facilities"]


@pytest.fixture
def data_dir(tmp_path: Path) -> Path:
    for source_id in IDS:
        target = paths.raw_file(tmp_path, source_id)
        target.parent.mkdir(parents=True)
        shutil.copyfile(FIXTURES / f"{source_id}.csv", target)
    return tmp_path


def run(data_dir: Path, *args: str) -> int:
    only = [part for source_id in IDS for part in ("--only", source_id)]
    return main(["--data-dir", str(data_dir), *args, *only])


def test_offline_pipeline(data_dir: Path, fake_server: Any, capsys: pytest.CaptureFixture[str]) -> None:
    assert run(data_dir, "fetch", "--offline") == 0
    assert run(data_dir, "normalize") == 0
    stats = json.loads(paths.stats_file(data_dir, "jeonju-led").read_text(encoding="utf-8"))
    assert (stats["rows_in"], stats["rows_out"], stats["exact_duplicates"]) == (5, 4, 1)
    assert stats["elapsed_seconds"] >= 0 and stats["peak_rss_mb"] > 0 and len(stats["sha256"]) == 64
    lines = paths.rows_file(data_dir, "jeonju-led").read_text(encoding="utf-8").splitlines()
    assert len(lines) == 4 and json.loads(lines[0])["width_m"] == 4.206

    capsys.readouterr()
    assert run(data_dir, "push", "--dry-run") == 0
    dry = [json.loads(text) for text in capsys.readouterr().out.splitlines()]
    assert [(entry["rows"], entry["bad_rows"]) for entry in dry] == [(4, 0), (4, 0), (5, 0)]

    imports = Imports()
    server = fake_server(imports)
    assert run(data_dir, "push", "--server", server.url, "--workspace", WORKSPACE, "--skip-mark", "quantity_zero") == 0
    by_source = {body["source"]["id"]: body for body in imports.bodies}
    assert len(by_source["seoul-metro-ad-facilities"]["rows"]) == 2  # 수량 0 인 두 줄은 보내지 않았다
    # 줄을 골라 보낼 때는 수집기가 뺀 줄 수를 싣지 않는다(파일 전체에서 뺀 수라 고른 줄의 묶음에 붙이면 틀리게 읽힌다).
    assert all("collector" not in body for body in imports.bodies)
    push_log = json.loads(paths.push_log_file(data_dir).read_text(encoding="utf-8"))
    assert push_log["jeonju-led"]["collector_counts_sent"] is False
    fetched_at = datetime.fromisoformat(by_source["jeonju-led"]["source"]["fetchedAt"])
    assert fetched_at.tzinfo is not None  # 서버는 시간대가 붙은 시각만 받는다

    capsys.readouterr()
    assert run(data_dir, "report") == 0
    out = capsys.readouterr().out
    assert "| jeonju-led | 5 | 4 | 1 | 0 | 0 |" in out
    assert "합계(3개)" in out and "서버로 보낸 결과" in out and "coord_sample" in out


def write_raw(base: Path, source_id: str, text: str, encoding: str = "cp949") -> None:
    target = paths.raw_file(base, source_id)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(text.encode(encoding))


BUSAN = "busan-metro-ad-facilities"
DAEGU = "daegu-metro-ad-media"


def only(data_dir: Path, command: list[str], *ids: str) -> int:
    return main(["--data-dir", str(data_dir), *command, *(part for source_id in ids for part in ("--only", source_id))])


def test_push_without_picking_sends_the_collector_counts_with_both_kinds_of_duplicates(tmp_path: Path, fake_server: Any) -> None:
    # 같은 줄 하나(둘째 줄과 셋째 줄) + 같은 자리·규격 하나(넷째 줄은 대행사만 다르다) → 수집기가 뺀 중복은 둘이다.
    write_raw(tmp_path, BUSAN, "호선,광고종류,광고대행사,상세위치\r\n1호선,조명광고,가상애드,대합실\r\n1호선,조명광고,가상애드,대합실\r\n1호선,조명광고,다른애드,승강장\r\n")
    assert only(tmp_path, ["fetch", "--offline"], BUSAN) == 0
    assert only(tmp_path, ["normalize"], BUSAN) == 0
    stats = json.loads(paths.stats_file(tmp_path, BUSAN).read_text(encoding="utf-8"))
    assert (stats["rows_out"], stats["exact_duplicates"], stats["key_duplicates"]) == (1, 1, 1)
    imports = Imports()
    server = fake_server(imports)
    assert only(tmp_path, ["push", "--server", server.url, "--workspace", WORKSPACE], BUSAN) == 0
    assert imports.bodies[0]["collector"] == {"unreadable": 0, "duplicates": 2}
    assert json.loads(paths.push_log_file(tmp_path).read_text(encoding="utf-8"))[BUSAN]["collector_counts_sent"] is True
    # --limit 로 골라 보내면 싣지 않는다.
    assert only(tmp_path, ["push", "--server", server.url, "--workspace", WORKSPACE, "--limit", "1"], BUSAN) == 0
    assert "collector" not in imports.bodies[-1]


def test_failed_normalize_keeps_the_earlier_result_and_says_failed(tmp_path: Path, fake_server: Any, capsys: pytest.CaptureFixture[str]) -> None:
    good = "호선,광고종류,광고대행사,상세위치\r\n1호선,조명광고,가상애드,대합실\r\n2호선,포스터,가상애드,승강장\r\n"
    write_raw(tmp_path, BUSAN, good)
    assert only(tmp_path, ["fetch", "--offline"], BUSAN) == 0
    assert only(tmp_path, ["normalize"], BUSAN) == 0
    before = paths.rows_file(tmp_path, BUSAN).read_text(encoding="utf-8")
    assert before.count("\n") == 2

    # 기관이 칸 이름을 바꿨다. 다시 정리하면 실패한다.
    write_raw(tmp_path, BUSAN, good.replace("광고종류", "광고 종류"))
    assert only(tmp_path, ["fetch", "--offline"], BUSAN) == 0
    capsys.readouterr()
    assert only(tmp_path, ["normalize"], BUSAN) == 1
    captured = capsys.readouterr()
    assert "머리줄에 없는 칸" in captured.err
    # 앞서 만든 결과 파일은 0줄로 비지 않는다. 임시 파일도 남지 않는다.
    assert paths.rows_file(tmp_path, BUSAN).read_text(encoding="utf-8") == before
    assert not list(paths.out_dir(tmp_path).glob("*.part"))
    # 기록과 보고 표는 지난번의 수를 내지 않는다.
    stats = json.loads(paths.stats_file(tmp_path, BUSAN).read_text(encoding="utf-8"))
    assert "LayoutChanged" in stats["failed"] and "rows_out" not in stats
    assert f"| {BUSAN} | 정리 실패 |" in captured.out and "정리 실패 1개는 빠짐" in captured.out
    # 보내기는 멈춘다(지난 결과를 조용히 보내지 않는다). 요청이 나가지 않는다.
    server = fake_server(Imports())
    assert only(tmp_path, ["push", "--server", server.url, "--workspace", WORKSPACE], BUSAN) == 1
    assert "지난 정리가 실패" in capsys.readouterr().err
    assert only(tmp_path, ["push", "--dry-run"], BUSAN) == 1
    assert server.requests == []


def test_push_stops_when_the_rows_file_does_not_match_the_record(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    write_raw(tmp_path, BUSAN, "호선,광고종류,광고대행사,상세위치\r\n1호선,조명광고,가상애드,대합실\r\n2호선,포스터,가상애드,승강장\r\n")
    assert only(tmp_path, ["fetch", "--offline"], BUSAN) == 0
    assert only(tmp_path, ["normalize"], BUSAN) == 0
    paths.rows_file(tmp_path, BUSAN).write_text("", encoding="utf-8")  # 결과 파일이 비었다
    capsys.readouterr()
    assert only(tmp_path, ["push", "--dry-run"], BUSAN) == 1
    assert "정리 기록은 2줄인데 결과 파일은 0줄" in capsys.readouterr().err


@pytest.mark.parametrize(
    ("broken", "said"),
    [
        (b"\xef\xbb\xbf" + "호선,광고종류,광고대행사,상세위치\r\n1호선,조명광고,가상애드,대합실\r\n".encode("cp949"), "BOM"),
        ("호선,광고종류,광고대행사,상세위치\r\n1호선,조명광고,가상애드,".encode("cp949") + b"x" * 140_000 + b"\r\n", "field larger"),
        ('호선,광고종류,광고대행사,상세위치\r\n1호선,"조명광고,가상애드,대합실\r\n2호선,포스터,가상애드,승강장\r\n'.encode("cp949"), "정리하지 못했습니다"),
    ],
    ids=["bom-then-cp949", "huge-cell", "unclosed-quote"],
)
def test_one_broken_file_does_not_stop_the_next_source(tmp_path: Path, broken: bytes, said: str, capsys: pytest.CaptureFixture[str]) -> None:
    target = paths.raw_file(tmp_path, BUSAN)
    target.parent.mkdir(parents=True)
    target.write_bytes(broken)
    write_raw(tmp_path, DAEGU, (FIXTURES / f"{DAEGU}.csv").read_bytes().decode("cp949"))
    assert only(tmp_path, ["fetch", "--offline"], BUSAN, DAEGU) == 0
    capsys.readouterr()
    assert only(tmp_path, ["normalize"], BUSAN, DAEGU) == 1
    captured = capsys.readouterr()
    assert f"{BUSAN}: 정리하지 못했습니다" in captured.err and said in captured.err
    assert "Traceback" not in captured.err
    # 뒤 출처는 정리됐다.
    assert paths.rows_file(tmp_path, DAEGU).read_text(encoding="utf-8").count("\n") == 4
    assert "failed" in json.loads(paths.stats_file(tmp_path, BUSAN).read_text(encoding="utf-8"))
    assert not paths.rows_file(tmp_path, BUSAN).exists()


def test_the_same_file_normalizes_the_same_on_any_day(tmp_path: Path, sources: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    # 표시 종료일의 "기한 지남"은 정리하는 날이 아니라 받은 날을 기준으로 붙인다.
    source_id = "daejeon-junggu-ooh-permits"
    target = paths.raw_file(tmp_path, source_id)
    target.parent.mkdir(parents=True)
    shutil.copyfile(FIXTURES / f"{source_id}.csv", target)
    end_column = sources[source_id].end_date
    header = (FIXTURES / f"{source_id}.csv").read_bytes().decode("cp949").splitlines()[0].split(",")
    assert end_column in header

    def normalize_as_fetched(day: str) -> list[dict[str, Any]]:
        assert only(tmp_path, ["fetch", "--offline"], source_id) == 0
        log = json.loads(paths.fetch_log_file(tmp_path).read_text(encoding="utf-8"))
        log[source_id]["fetched_at"] = f"{day}T09:00:00+09:00"
        paths.fetch_log_file(tmp_path).write_text(json.dumps(log), encoding="utf-8")
        assert only(tmp_path, ["normalize"], source_id) == 0
        return [json.loads(text) for text in paths.marks_file(tmp_path, source_id).read_text(encoding="utf-8").splitlines()]

    early = normalize_as_fetched("2000-01-01")
    late = normalize_as_fetched("2099-01-01")
    passed = lambda marks: sum("end_date_passed" in entry["marks"] for entry in marks)  # noqa: E731
    # 받은 날이 2000년이면 지난 기한이 없고, 2099년이면 있다. 오늘 날짜(2026년)는 결과에 끼어들지 않는다.
    assert passed(early) == 0 and passed(late) > 0


def test_delay_below_the_floor_is_refused(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    for value in ("0", "-3", "0.5", "nan", "빠르게"):
        with pytest.raises(SystemExit):
            main(["--data-dir", str(tmp_path), "fetch", "--offline", "--delay", value])
    assert "1초 이상" in capsys.readouterr().err
    assert main(["--data-dir", str(tmp_path), "fetch", "--offline", "--delay", "1", "--only", "muju-led"]) == 1  # 받아 둔 파일이 없을 뿐, 값은 받았다


def test_normalize_without_fetch_says_what_to_do(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["--data-dir", str(tmp_path), "normalize", "--only", "muju-led"]) == 1
    assert "먼저 fetch" in capsys.readouterr().err


def test_unknown_source_id(tmp_path: Path) -> None:
    assert main(["--data-dir", str(tmp_path), "report", "--only", "nope"]) == 2


def test_sources_command_lists_license_and_base_date(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["sources"]) == 0
    out = capsys.readouterr().out
    assert "공공누리 1유형" in out and "2023-03-20" in out and out.count("\n") == 14
