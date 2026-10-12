"""중복 열쇠. docs/IMPORT-FORMAT.md 3절의 표 세 줄을 그대로 넣는다(서버와 같은 글자가 나와야 한다)."""

import pytest

from collector.dedupe import dedupe_key, key_number, key_text

SAMPLE = {
    "name": "홍대입구역 9번 출구 전광판",
    "region": "서울 마포구",
    "address": "서울 마포구 양화로 160",
    "subway_line": "2호선",
    "station": "홍대입구역",
    "media_type": "LED 전광판",
    "width_m": 7,
    "height_m": 12,
}


def test_document_example_rows() -> None:
    assert dedupe_key(SAMPLE) == "서울마포구양화로160|2호선|홍대입구역|led전광판|7|12|"
    assert dedupe_key({**SAMPLE, "address": None}) == "서울마포구|2호선|홍대입구역|led전광판|7|12|"
    assert dedupe_key({"name": "가 전광판"}) == "||||||가전광판"


@pytest.mark.parametrize(
    ("value", "expected"),
    [(7, "7"), (7.0, "7"), (7.004, "7"), (7.25, "7.25"), (0.125, "0.13"), (4.206, "4.21"), (0.9, "0.9"), (None, "")],
)
def test_key_number_rounds_like_the_server(value: float | None, expected: str) -> None:
    assert key_number(value) == expected


def test_key_text_ignores_width_case_and_spaces() -> None:
    assert key_text("ＬＥＤ  전광판\t") == "led전광판"
    assert key_text("㈜가상") == key_text("(주) 가상")
    assert key_text(None) == ""


def test_name_counts_only_without_place_and_station() -> None:
    with_place = {"address": "가로 1", "name": "가"}
    assert dedupe_key(with_place) == dedupe_key({**with_place, "name": "나"})
    assert dedupe_key({"station": "강남역", "name": "가"}) == dedupe_key({"station": "강남역", "name": "나"})
    assert dedupe_key({"name": "가"}) != dedupe_key({"name": "나"})


def test_same_line_and_media_in_two_cities_are_not_one_row(sources) -> None:  # type: ignore[no-untyped-def]
    """부산·대구 자료는 호선 × 매체 종류 표라 역도 주소도 없다. 지역이 없으면 '1호선 역구내 광고'가 서버에서 한 줄로 합쳐진다.

    실제 서버로 보냈을 때 대구 33줄 가운데 2줄이 부산 줄의 중복으로 갈렸던 것을 막는다(출처 목록에 도시를 적었다).
    """
    from datetime import date

    from collector.normalize import build_row

    record = {"호선": "1호선", "광고종류": "역구내 광고", "광고대행사": "", "상세위치": "대합실"}
    busan, _ = build_row(sources["busan-metro-ad-facilities"], 1, record, date(2026, 10, 12))
    record = {"호선": "1", "구분": "역사광고", "매체명": "역구내 광고", "광고대행사": ""}
    daegu, _ = build_row(sources["daegu-metro-ad-media"], 1, record, date(2026, 10, 12))
    assert busan["subway_line"] == daegu["subway_line"] == "1호선"
    assert busan["media_type"] == daegu["media_type"]
    assert dedupe_key(busan) != dedupe_key(daegu)
