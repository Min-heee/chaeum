"""출처 목록 파일."""

import json
from pathlib import Path

import pytest

from collector import paths
from collector.sources import Source, SourceError, load_sources, needed_columns, pick_sources


def entry(**changes: object) -> dict[str, object]:
    base: dict[str, object] = {
        "id": "sample-a",
        "name": "가상 기관 현황",
        "provider": "가상 기관",
        "landing_page": "https://example.org/a",
        "download_url": "https://example.org/a.csv",
        "license": "시험용",
        "columns": {"name": "이름"},
    }
    return {**base, **changes}


def write(tmp_path: Path, *entries: dict[str, object]) -> Path:
    path = tmp_path / "sources.json"
    path.write_text(json.dumps({"sources": list(entries)}, ensure_ascii=False), encoding="utf-8")
    return path


def test_the_real_list_loads_with_twelve_sources(sources: dict[str, Source]) -> None:
    assert len(sources) == 12
    for source in sources.values():
        assert source.license and source.landing_page.startswith("https://") and source.download_url.startswith("https://")
        assert "name" in source.columns


def test_only_picks_and_rejects_unknown_ids() -> None:
    everything = load_sources(paths.SOURCES_FILE)
    assert [source.id for source in pick_sources(everything, ["muju-led"])] == ["muju-led"]
    with pytest.raises(SourceError):
        pick_sources(everything, ["없는-출처"])


def test_needed_columns_lists_their_column_names(sources: dict[str, Source]) -> None:
    assert needed_columns(sources["seoul-metro-ad-facilities"]) == ["호선", "역명", "광고시설물명", "광고대행사", "광고시설물 수량"]
    assert set(needed_columns(sources["suwon-ooh-survey"])) == {"광고물종류", "소재지지번주소", "업소명", "가로", "세로", "규격2", "위도", "경도", "수량"}


@pytest.mark.parametrize(
    "bad",
    [
        entry(id="대문자A"),
        entry(license=" "),
        entry(columns={"price": "가격"}),
        entry(columns={"name": {"guess": "이름"}}),
        entry(columns={"name": {"compose": ["그쪽 칸"]}}),
        entry(size={"column": "규격", "unit": "inch"}),
        entry(coords={"lat": "위도", "lng": "경도", "bounds": [1, 2]}),
    ],
)
def test_bad_entries_are_refused(tmp_path: Path, bad: dict[str, object]) -> None:
    with pytest.raises(SourceError):
        load_sources(write(tmp_path, bad))


def test_duplicate_ids_are_refused(tmp_path: Path) -> None:
    with pytest.raises(SourceError):
        load_sources(write(tmp_path, entry(), entry()))
