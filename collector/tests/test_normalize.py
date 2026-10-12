"""정리: 출처마다 실제 파일을 본뜬 작은 견본(fixtures/)을 넣어 결과를 본다."""

from __future__ import annotations

import io
import json
from datetime import date
from typing import Any

import pytest

from collector import normalize
from collector.rowshape import row_problems
from collector.sources import Source
from collector.textio import detect_encoding, read_records

from .conftest import FIXTURES

TODAY = date(2026, 10, 12)
Result = tuple[list[dict[str, Any]], dict[int, list[str]], normalize.Stats]


def run(source: Source) -> Result:
    """견본 파일 하나를 정리한다. (줄들, 줄 번호 → 표시, 수)"""
    path = FIXTURES / f"{source.id}.csv"
    codec, guessed = detect_encoding(path, source.encoding_hint)
    stats = normalize.Stats(source.id)
    pairs = list(normalize.normalize_records(source, read_records(path, codec), TODAY, guessed, stats))
    return [row for row, _ in pairs], {row["line"]: marks for row, marks in pairs}, stats


def without_raw(row: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in row.items() if key != "raw"}


def test_every_source_has_a_fixture_and_every_row_fits_the_server_shape(sources: dict[str, Source]) -> None:
    assert len(sources) == 12
    for source in sources.values():
        rows, _, stats = run(source)
        assert rows, source.id
        assert stats.unreadable_total == 0, source.id
        for row in rows:
            assert row_problems(row) == [], (source.id, row["line"])


def test_seoul_line_station_and_quantity(sources: dict[str, Source]) -> None:
    rows, marks, _ = run(sources["seoul-metro-ad-facilities"])
    assert without_raw(rows[1]) == {
        "line": 2,
        "kind": "지하철 광고",
        "name": "서울역 기둥조명",
        "subway_line": "1호선",
        "station": "서울역",
        "media_type": "기둥조명",
        "operator": "가상애드",
        "quantity": 4,
    }
    assert rows[1]["raw"]["역명"] == "서울역(1)"  # 원래 줄은 고치지 않는다
    assert rows[0]["quantity"] == 0 and marks[1] == ["quantity_zero"]
    assert "quantity" not in rows[2] and marks[3] == ["quantity_not_integer"]  # 15.5 는 정수가 아니다
    assert "operator" not in rows[3]  # 빈칸은 칸을 뺀다(빈 글자를 보내지 않는다)


def test_busan_and_daegu_lines_with_commas(sources: dict[str, Source]) -> None:
    busan, _, _ = run(sources["busan-metro-ad-facilities"])
    assert busan[3]["subway_line"] == "1,2호선"
    assert busan[0]["operator"] == "(주)가상애드원"  # ㈜ 한 글자를 (주) 로
    daegu, _, _ = run(sources["daegu-metro-ad-media"])
    assert [row["subway_line"] for row in daegu] == ["1호선", "1호선", "1,2호선", "1,2호선"]
    assert daegu[3]["media_type"] == "PSD광고_1,2반월당, 중앙로, 동대구역"
    assert daegu[0]["kind"] == "전동차광고"


def test_daegu_bukgu_two_size_columns_with_stated_unit(sources: dict[str, Source]) -> None:
    rows, marks, _ = run(sources["daegu-bukgu-led-commercial"])
    assert (rows[0]["width_m"], rows[0]["height_m"], rows[0]["quantity"]) == (12.8, 7.68, 1)
    assert rows[0]["region"] == "대구광역시 북구"
    assert "flags" not in rows[0] and marks[1] == []


def test_jeonju_tabs_mm_and_out_of_area_coords(sources: dict[str, Source]) -> None:
    rows, marks, stats = run(sources["jeonju-led"])
    assert (rows[0]["width_m"], rows[0]["height_m"]) == (4.206, 1.262)
    assert "flags" not in rows[0]  # 값에 mm 가 붙어 있으니 단위를 짐작한 것이 아니다
    assert rows[2]["address"] == "동부대로 680" and rows[3]["address"] == "모악로 4746"
    assert "lat" not in rows[1] and marks[2] == ["coord_out_of_area"]  # 다른 시의 좌표가 든 줄
    assert stats.rows_in == 5 and stats.rows_out == 4
    assert stats.exact_duplicates == 1  # 탭 글자만 다른 줄은 같은 줄이다
    assert rows[0]["raw"]["표출형식"] == "\tJPG+MP4"


def test_muju_bom_cm_and_trailing_spaces(sources: dict[str, Source]) -> None:
    rows, marks, _ = run(sources["muju-led"])
    assert list(rows[0]["raw"])[0] == "전광판구분"  # BOM 이 칸 이름에 붙지 않았다
    assert (rows[0]["width_m"], rows[0]["height_m"]) == (5.4, 1.0)
    assert (rows[3]["width_m"], rows[3]["height_m"]) == (3.84, 0.64)  # 384X64
    assert (rows[0]["lat"], rows[0]["lng"]) == (35.97356, 127.559068)
    assert "lng" not in rows[2] and marks[3] == ["coord_out_of_area"]  # 경도 126.6…
    assert rows[1]["raw"]["표출형식"] == "문자,영상"


def test_iksan_sample_coords_are_blanked(sources: dict[str, Source]) -> None:
    rows, marks, stats = run(sources["iksan-led"])
    assert stats.rows_out == 5  # 마지막 줄에 줄바꿈이 없어도 읽는다
    assert marks[3] == ["coord_sample"] and marks[4] == ["coord_sample"]
    assert "lat" not in rows[2] and "lat" in rows[4]
    assert rows[1]["name"] == rows[1]["address"] == "익산역 광장"


def test_imsil_coords_that_are_words(sources: dict[str, Source]) -> None:
    rows, marks, _ = run(sources["imsil-led"])
    assert [marks[line] for line in (1, 2, 3, 4)] == [[], ["coord_not_number"], ["coord_not_number"], ["coord_not_number"]]
    assert (rows[2]["width_m"], rows[2]["height_m"]) == (2.6, 0.38)  # "2.6 x 0.38"
    assert rows[0]["operator"] == "보건사업과"


def test_gwangju_faces_height_note_and_outside_area(sources: dict[str, Source]) -> None:
    rows, marks, _ = run(sources["gwangju-bukgu-ooh-permits"])
    assert "width_m" not in rows[0] and marks[1] == ["size_faces_differ"]
    assert rows[1]["flags"] == ["unit_assumed"]
    assert (rows[2]["width_m"], rows[2]["height_m"]) == (1.5, 2.0)  # "1.5*2    높이:6"
    assert marks[4] == ["size_faces_differ", "address_outside_area"]
    assert rows[3]["region"] == "서울특별시 영등포구"
    assert marks[5] == ["size_faces_same", "unit_assumed"]
    assert "operator" not in rows[1]  # 업소명은 운영 기관이 아니다


def test_daejeon_dates_blank_rows_and_exact_duplicate(sources: dict[str, Source]) -> None:
    rows, marks, stats = run(sources["daejeon-junggu-ooh-permits"])
    assert marks[2] == ["unit_assumed", "end_date_open"]  # 9999-12-31
    assert marks[5] == ["unit_assumed", "end_date_passed"]  # 2026-01-05 는 받은 날보다 앞이다
    assert stats.exact_duplicates == 1 and [row["line"] for row in rows] == [1, 2, 3, 5]
    assert without_raw(rows[2]) == {"line": 3, "kind": "옥외광고물", "name": "(주)가상광고연합 교통수단이용 광고물", "media_type": "교통수단이용 광고물"}
    assert (rows[3]["width_m"], rows[3]["height_m"]) == (9.0, 3.4)  # "9.*3.4"
    assert rows[0]["raw"]["표시장소_지번"].endswith("  ")  # 원래 줄의 끝 빈칸은 그대로


def test_suwon_zero_coords_zero_size_and_formula_like(sources: dict[str, Source]) -> None:
    rows, marks, _ = run(sources["suwon-ooh-survey"])
    assert rows[0]["address"] == "경기도 수원시 팔달구 인계동 1009-2"
    assert "lat" not in rows[2] and "coord_zero" in marks[3]
    assert rows[3]["name"] == "@가상카페 돌출간판" and "formula_like" in marks[4]  # 값은 고치지 않고 표시만
    assert "width_m" not in rows[4] and "size_zero" in marks[5]
    assert rows[0]["flags"] == ["unit_assumed"]


def test_yeongdo_quoted_address(sources: dict[str, Source]) -> None:
    rows, _, _ = run(sources["busan-yeongdo-banner-boards"])
    assert rows[1]["address"] == "부산광역시 영도구 함지로79번길 76, 와치사회농합복지관 앞(동삼동)"
    assert (rows[0]["width_m"], rows[0]["height_m"], rows[0]["quantity"]) == (6.0, 0.9, 15)
    assert rows[0]["raw"]["점용료"] == "16200" and "price" not in rows[0]  # 가격 칸은 만들지 않는다


# ── 견본 없이 꼴만 보는 시험 ────────────────────────────────


def make_source(**extra: Any) -> Source:
    columns = {"name": "이름", "address": "주소", "media_type": "종류"}
    return Source("t", "시험", "시험 기관", "https://example.org", "https://example.org/a.csv", "시험용", "", None, columns, **extra)


def records(*lines: list[str]) -> list[list[str]]:
    return [["이름", "주소", "종류", "규격"], *lines]


def normalize_lines(source: Source, lines: list[list[str]], guessed: bool = False) -> Result:
    stats = normalize.Stats(source.id)
    pairs = list(normalize.normalize_records(source, lines, TODAY, guessed, stats))
    return [row for row, _ in pairs], {row["line"]: marks for row, marks in pairs}, stats


def test_same_place_and_size_is_one_row() -> None:
    source = make_source(size={"column": "규격", "unit": "m", "unit_stated": True})
    lines = records(["가", "가로 1", "전광판", "3*2"], ["나", "가로  1", "전광판", "3.0*2"], ["다", "가로 1", "전광판", "3*4"])
    rows, _, stats = normalize_lines(source, lines)
    assert [row["line"] for row in rows] == [1, 3]
    assert stats.key_duplicates == 1 and stats.exact_duplicates == 0


def test_rows_without_any_key_piece_are_not_merged() -> None:
    # 주소도 종류도 이름도 없는 줄은 열쇠가 비어 있다. 그런 줄끼리 "같은 자리"로 합치지 않는다.
    source = Source("t", "시험", "시험 기관", "https://example.org", "https://example.org/a.csv", "시험용", "", None, {"name": "이름", "address": "주소"})
    lines = [["이름", "주소", "비고"], ["", "", "하나"], ["", "", "둘"], ["-", "-", "셋"]]
    rows, _, stats = normalize_lines(source, lines)
    assert [row["line"] for row in rows] == [1, 2, 3]
    assert stats.key_duplicates == 0 and stats.exact_duplicates == 0


def test_placeholder_address_is_not_a_place() -> None:
    # 주소 칸의 "-" 는 값이 아니다. 주소가 "-" 인 줄끼리 같은 규격이라고 한 건으로 합쳐지지 않는다(이름으로 갈린다).
    source = make_source(size={"column": "규격", "unit": "m", "unit_stated": True})
    lines = records(["가 간판", "-", "간판", "3*2"], ["나 간판", "-", "간판", "3*2"], ["가 간판", " - ", "간판", "3.0*2"])
    rows, _, stats = normalize_lines(source, lines)
    assert [row["line"] for row in rows] == [1, 2]
    assert all("address" not in row for row in rows)
    assert rows[0]["raw"]["주소"] == "-"  # 원래 줄은 고치지 않는다
    assert stats.key_duplicates == 1


def test_header_names_are_trimmed() -> None:
    rows, _, _ = normalize_lines(make_source(), [[" 이름", "주소 ", "\t종류", "규격"], ["가", "가로 1", "전광판", ""]])
    assert without_raw(rows[0]) == {"line": 1, "name": "가", "address": "가로 1", "media_type": "전광판"}
    assert set(rows[0]["raw"]) == {"이름", "주소", "종류", "규격"}


def test_rows_with_extra_or_missing_cells_are_unreadable() -> None:
    lines = records(["가", "가로 1", "전광판", "", "남는 칸"], ["나", "가로 2", "전광판"], ["다", "가로 3", "전광판", ""])
    rows, _, stats = normalize_lines(make_source(), lines)
    assert [row["line"] for row in rows] == [3]
    assert dict(stats.unreadable) == {"column_count": 2}


def test_total_line_is_dropped_however_many_cells_are_filled() -> None:
    # 칸이 다 찬 합계 줄도 자료 줄이 아니다("전체 3개" 가 지면 하나로 들어가지 않는다).
    lines = records(["합계", "3개 업체", "전체", "38.4"], ["소계", "", "", ""], [" 계 ", "x", "y", "z"], ["합계상사", "가로 9", "전광판", ""])
    rows, _, stats = normalize_lines(make_source(), lines)
    assert [row["name"] for row in rows] == ["합계상사"]  # 첫 칸이 합계 말과 꼭 같을 때만 뺀다
    assert dict(stats.unreadable) == {"total_line": 3}


def test_repeated_header_inside_the_data_is_dropped() -> None:
    lines = records(["가", "가로 1", "전광판", ""], ["이름", "주소", "종류", "규격"], [" 이름 ", "주소", "종류", "규격 "], ["나", "가로 2", "전광판", ""])
    rows, _, stats = normalize_lines(make_source(), lines)
    assert [row["line"] for row in rows] == [1, 4]
    assert dict(stats.unreadable) == {"repeated_header": 2}


def test_duplicate_header_names_stop_the_source() -> None:
    # 같은 이름의 칸이 둘이면 뒤 칸이 앞 칸을 덮는다. 조용히 지나가지 않고 멈춘다.
    with pytest.raises(normalize.LayoutChanged, match="같은 칸 이름"):
        normalize_lines(make_source(), [["이름", "주소", "종류", "종류"], ["가", "가로 1", "진짜종류", "비고값"]])
    # 빈 칸 이름이 여럿인 것은 겹친 것으로 보지 않는다... 그 칸들은 raw 에서 하나로 합쳐지므로 그것도 멈춘다.
    with pytest.raises(normalize.LayoutChanged):
        normalize_lines(make_source(), [["이름", "주소", "종류", "비고", "비고"], ["가", "가로 1", "전광판", "", ""]])


def test_newline_in_a_row_with_wrong_cell_count_stops_the_source() -> None:
    # 따옴표가 잘못 닫혀 여러 줄이 한 칸으로 읽힌 꼴. 한 줄을 "못 읽은 줄"로 세고 넘어가면 삼킨 줄들이 어디에도 남지 않는다.
    lines = records(["가", "가로 1", "전광판", ""], ["나", "가로 2\n다,가로 3,전광판,\n라,가로 4", "전광판"])
    with pytest.raises(normalize.BrokenQuotes, match="2번째 줄"):
        normalize_lines(make_source(), lines)
    # 칸 수가 맞으면 칸 안의 줄바꿈은 그냥 값이다.
    rows, _, _ = normalize_lines(make_source(), records(["가", "가로 1\n2층", "전광판", ""]))
    assert rows[0]["address"] == "가로 1 2층"


def test_unreadable_lines_are_listed_with_line_numbers() -> None:
    lines = records(["가", "가로 1", "전광판"], ["", " ", "", ""], ["합계", "", "", "3"], ["나", "가로 2", "전광판", ""], ["다", "가로 3", "전광판", "9" * 4100])
    stats = normalize.Stats("t")
    skipped: list[dict[str, Any]] = []
    list(normalize.normalize_records(make_source(), lines, TODAY, False, stats, skipped))
    assert skipped == [
        {"line": 1, "reason": "column_count"},
        {"line": 2, "reason": "blank_line"},
        {"line": 3, "reason": "total_line"},
        {"line": 5, "reason": "raw_too_long"},
    ]
    assert stats.unreadable_total == len(skipped)


def test_size_columns_are_checked_against_the_one_cell_size() -> None:
    size = {"width": "가로", "height": "세로", "unit": "m", "unit_stated": False, "check_column": "규격2"}
    source = Source("t", "시험", "시험 기관", "https://example.org", "https://example.org/a.csv", "시험용", "", None, {"name": "이름"}, size=size)
    lines = [
        ["이름", "가로", "세로", "규격2"],
        ["같음", "0.8", "3.5", "0.8*3.5*7.5"],
        ["다름", "23.1", "35", "23*1.35"],
        ["두 칸이 0", "0", "0", "10.34*1.73"],
        ["견줄 칸이 빔", "2", "3", ""],
        ["견줄 칸을 못 읽음", "2", "3", "넓음"],
    ]
    rows, marks, stats = normalize_lines(source, lines)
    assert [(row.get("width_m"), row.get("height_m")) for row in rows] == [(0.8, 3.5), (23.1, 35.0), (None, None), (2.0, 3.0), (2.0, 3.0)]
    assert marks[1] == ["unit_assumed"]
    assert marks[2] == ["size_mismatch", "unit_assumed"]  # 값은 두 칸의 것 그대로이고 표시만 붙는다
    assert marks[3] == ["size_zero", "size_in_other_column"]  # 다른 칸의 값으로 채우지 않는다
    assert marks[4] == ["unit_assumed"] and marks[5] == ["unit_assumed"]
    assert stats.marks["size_mismatch"] == 1


def test_unreadable_lines_are_counted_by_reason() -> None:
    lines = records(["가", "가로 1", "전광판"], ["", " ", "", ""], ["합계", "", "", "3"], ["나", "가로 2", "전광판", ""])
    rows, _, stats = normalize_lines(make_source(), lines)
    assert [row["line"] for row in rows] == [4]
    assert dict(stats.unreadable) == {"column_count": 1, "blank_line": 1, "total_line": 1}
    assert stats.rows_in == 4 and stats.rows_out == 1


def test_guessed_encoding_is_flagged_on_every_row() -> None:
    rows, marks, _ = normalize_lines(make_source(), records(["가", "가로 1", "전광판", ""]), guessed=True)
    assert rows[0]["flags"] == ["encoding_guessed"] and marks[1] == ["encoding_guessed"]


def test_long_text_is_cut_and_marked() -> None:
    rows, marks, _ = normalize_lines(make_source(), records(["가" * 250, "가로 1", "전광판", ""]))
    assert len(rows[0]["name"]) == 200 and marks[1] == ["text_truncated"]
    assert row_problems(rows[0]) == []


def test_too_long_raw_line_is_unreadable() -> None:
    _, _, stats = normalize_lines(make_source(), records(["가", "가로 1", "전광판", "9" * 4100]))
    assert dict(stats.unreadable) == {"raw_too_long": 1}


def test_changed_header_stops_the_source() -> None:
    with pytest.raises(normalize.LayoutChanged):
        normalize_lines(make_source(), [["이름", "소재지", "종류"], ["가", "가로 1", "전광판"]])


def test_normalize_file_writes_json_lines_and_marks(sources: dict[str, Source]) -> None:
    source = sources["jeonju-led"]
    rows_out, marks_out = io.StringIO(), io.StringIO()
    stats = normalize.normalize_file(source, FIXTURES / "jeonju-led.csv", rows_out, marks_out, TODAY)
    written = [json.loads(text) for text in rows_out.getvalue().splitlines()]
    assert len(written) == stats.rows_out == 4
    assert [json.loads(text) for text in marks_out.getvalue().splitlines()] == [{"line": 2, "marks": ["coord_out_of_area"]}]
    assert stats.to_json()["encoding"] == "cp949" and stats.encoding_guessed is False


def test_normalize_file_lists_unreadable_lines_and_counts_file_lines(tmp_path: Any) -> None:
    path = tmp_path / "t.csv"
    path.write_bytes("이름,주소,종류,규격\r\n가,가로 1,전광판,\r\n합계,,,1\r\n나,가로 2\r\n".encode("utf-8"))
    rows_out, marks_out, unreadable_out = io.StringIO(), io.StringIO(), io.StringIO()
    stats = normalize.normalize_file(make_source(), path, rows_out, marks_out, TODAY, unreadable_out)
    assert (stats.file_lines, stats.rows_in, stats.rows_out) == (4, 3, 1)
    assert [json.loads(text) for text in unreadable_out.getvalue().splitlines()] == [
        {"line": 2, "reason": "total_line"},
        {"line": 3, "reason": "column_count"},
    ]


def test_row_problems_catches_what_the_server_refuses() -> None:
    good = {"line": 1, "raw": {"가": "나"}, "name": "가", "width_m": 1.5}
    assert row_problems(good) == []
    assert row_problems({**good, "price": 1000}) == ["표에 없는 칸: price"]
    assert row_problems({**good, "name": ""}) != []
    assert row_problems({**good, "width_m": "7.5"}) != []
    assert row_problems({**good, "quantity": 1.5}) != []
    assert row_problems({**good, "flags": ["coord_zero"]}) != []
    assert row_problems({"line": 0, "raw": {}}) != []
    # 가로·세로는 0 보다 커야 한다. 줄 번호는 서버의 표가 받는 수(4바이트 정수)까지다.
    assert row_problems({**good, "width_m": 0}) != []
    assert row_problems({**good, "height_m": -1}) != []
    assert row_problems({**good, "line": 2_147_483_647}) == []
    assert row_problems({**good, "line": 2_147_483_648}) != []
    assert row_problems({**good, "line": 3_000_000_000}) != []
