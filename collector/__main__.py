"""명령 줄: python -m collector <sources|fetch|normalize|push|report>"""

from __future__ import annotations

import argparse
import csv
import json
import os
import resource
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from . import fetch, normalize, paths, push, report
from .sources import Source, SourceError, load_sources, pick_sources
from .textio import UnreadableFile

_USABLE = ("offline", "kept", "unchanged", "downloaded")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m collector", description="공공 자료를 받아 한 꼴로 정리해 본체로 넘긴다.")
    parser.add_argument("--data-dir", help=f"자료 폴더(기본: 환경 변수 {paths.DATA_DIR_ENV}, 없으면 collector/.cache)")
    commands = parser.add_subparsers(dest="command", required=True)

    commands.add_parser("sources", help="출처 목록을 보여 준다")

    fetch_cmd = commands.add_parser("fetch", help="출처의 파일을 받는다")
    fetch_cmd.add_argument("--offline", action="store_true", help="요청을 보내지 않고 받아 둔 파일을 쓴다")
    fetch_cmd.add_argument("--refresh", action="store_true", help="이미 받은 파일도 다시 받아 견준다")
    fetch_cmd.add_argument(
        "--delay", type=_delay_seconds, default=fetch.DEFAULT_DELAY_SECONDS, help=f"요청 사이 간격(초). {fetch.MIN_DELAY_SECONDS:g}초보다 짧게는 못 쓴다"
    )

    commands.add_parser("normalize", help="받은 파일을 한 꼴로 정리한다")

    push_cmd = commands.add_parser("push", help="정리한 줄을 서버로 보낸다")
    push_cmd.add_argument("--server", default="http://127.0.0.1:3000", help="서버 주소")
    push_cmd.add_argument("--workspace", help="작업 공간 번호(없으면 서버가 새로 만든다)")
    push_cmd.add_argument("--limit", type=int, help="출처마다 앞에서부터 보낼 줄 수")
    push_cmd.add_argument("--skip-mark", action="append", default=[], help="이 표시가 붙은 줄은 보내지 않는다(여러 번 쓸 수 있다)")
    push_cmd.add_argument("--dry-run", action="store_true", help="보내지 않고 수만 센다")

    commands.add_parser("report", help="출처별 수를 표로 낸다")

    for command in commands.choices.values():
        command.add_argument("--only", action="append", help="이 출처만(여러 번 쓸 수 있다)")
    return parser


def _delay_seconds(text: str) -> float:
    """--delay 의 값. 수가 아니거나 아래 끝보다 짧으면 받지 않는다(0 이나 음수로 간격을 없애지 못하게)."""
    try:
        seconds = float(text)
    except ValueError:
        raise argparse.ArgumentTypeError("초 단위의 수를 적어 주세요.") from None
    if not seconds >= fetch.MIN_DELAY_SECONDS:
        raise argparse.ArgumentTypeError(f"요청 사이 간격은 {fetch.MIN_DELAY_SECONDS:g}초 이상이어야 합니다.")
    return seconds


def cmd_sources(sources: list[Source]) -> int:
    rows = [[s.id, s.name, s.provider, s.license, s.base_date] for s in sources]
    print(report.markdown_table(["id", "이름", "기관", "이용 조건", "기준일"], rows))
    return 0


def cmd_fetch(sources: list[Source], base: Path, args: argparse.Namespace) -> int:
    options = fetch.FetchOptions(refresh=args.refresh, delay_seconds=args.delay)
    tools = fetch.Tools(now=lambda: datetime.now().astimezone(), sleep=time.sleep)
    results = fetch.fetch_all(sources, base, args.offline, options, tools)
    rows = [[sid, e["status"], e.get("bytes"), e.get("fetched_at", ""), e.get("note", "")] for sid, e in results.items()]
    print(report.markdown_table(["출처", "결과", "바이트", "받은 시각", "메모"], rows))
    return 0 if all(entry["status"] in _USABLE for entry in results.values()) else 1


def peak_rss_mb() -> float:
    """이 프로세스가 지금까지 쓴 메모리의 최고값. macOS 는 바이트, 리눅스는 KB 로 준다."""
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return round(peak / (1024 * 1024 if sys.platform == "darwin" else 1024), 1)


def _part(path: Path) -> Path:
    """쓰는 동안의 임시 자리. 끝까지 성공했을 때만 진짜 이름으로 바꾼다."""
    return path.with_name(path.name + ".part")


def normalize_one(source: Source, base: Path, entry: dict[str, Any]) -> dict[str, Any]:
    """출처 하나를 정리해 out/ 에 쓰고, 수와 걸린 시간을 기록한다.

    결과는 임시 파일에 쓰고 끝까지 성공했을 때만 바꿔 넣는다. 도중에 실패하면 앞서 만들어 둔 결과 파일은 그대로 남는다
    (0줄짜리 파일로 덮이지 않는다). 그때의 기록은 normalize_failed 가 "실패"로 고쳐 적는다.
    줄의 표시(기한 지남 등)는 오늘이 아니라 받은 날을 기준으로 붙인다. 같은 파일은 언제 정리해도 결과가 같다.
    """
    today = datetime.fromisoformat(entry["fetched_at"]).date()
    started = time.perf_counter()
    targets = [paths.rows_file(base, source.id), paths.marks_file(base, source.id), paths.unreadable_file(base, source.id)]
    temps = [_part(path) for path in targets]
    try:
        with temps[0].open("w", encoding="utf-8") as rows_out, temps[1].open("w", encoding="utf-8") as marks_out:
            with temps[2].open("w", encoding="utf-8") as unreadable_out:
                stats = normalize.normalize_file(source, Path(entry["path"]), rows_out, marks_out, today, unreadable_out)
    except BaseException:
        for temp in temps:
            temp.unlink(missing_ok=True)
        raise
    for temp, target in zip(temps, targets, strict=True):
        os.replace(temp, target)
    record = stats.to_json()
    record.update(
        elapsed_seconds=round(time.perf_counter() - started, 2),
        peak_rss_mb=peak_rss_mb(),
        sha256=entry["sha256"],
        fetched_at=entry["fetched_at"],
    )
    with paths.stats_file(base, source.id).open("w", encoding="utf-8") as handle:
        json.dump(record, handle, ensure_ascii=False, indent=2)
    return record


def normalize_failed(source: Source, base: Path, entry: dict[str, Any], error: Exception) -> None:
    """정리가 실패했다고 기록한다. 보고 표와 보내기가 지난번의 수를 그대로 쓰지 않게 하려는 것이다."""
    record = {"source_id": source.id, "failed": f"{type(error).__name__}: {error}", "sha256": entry.get("sha256"), "fetched_at": entry.get("fetched_at")}
    with paths.stats_file(base, source.id).open("w", encoding="utf-8") as handle:
        json.dump(record, handle, ensure_ascii=False, indent=2)


# 정리하다 만날 수 있는, 그 출처 하나의 실패. 하나가 실패해도 다음 출처로 넘어간다.
#  LayoutChanged·BrokenQuotes: 파일 꼴이 바뀌었거나 따옴표가 깨졌다.  UnreadableFile·UnicodeDecodeError: 인코딩.
#  csv.Error: 따옴표 꼴이 틀렸거나 칸 하나가 csv 모듈의 한도(131,072자)를 넘는다.  OSError: 파일을 열지 못함.
_SOURCE_FAILURES = (normalize.LayoutChanged, normalize.BrokenQuotes, UnreadableFile, UnicodeDecodeError, csv.Error, OSError)


def cmd_normalize(sources: list[Source], base: Path) -> int:
    log = fetch.read_log(base)
    paths.out_dir(base).mkdir(parents=True, exist_ok=True)
    failed = 0
    for source in sources:
        entry = log.get(source.id, {})
        if entry.get("status") not in _USABLE:
            print(f"{source.id}: 받은 파일이 없습니다. 먼저 fetch 를 돌리세요.", file=sys.stderr)
            failed += 1
            continue
        try:
            record = normalize_one(source, base, entry)
        except _SOURCE_FAILURES as error:
            print(f"{source.id}: 정리하지 못했습니다. {error}", file=sys.stderr)
            normalize_failed(source, base, entry, error)
            failed += 1
            continue
        _warn_swallowed_lines(source, record)
    print(report.build_report(sources, base))
    return 1 if failed else 0


def _warn_swallowed_lines(source: Source, record: dict[str, Any]) -> None:
    """파일의 줄 수가 읽은 줄 수보다 눈에 띄게 많으면 알린다. 따옴표 안의 줄바꿈이 줄들을 삼켰을 수 있다."""
    extra = record["file_lines"] - 1 - record["rows_in"]
    if extra > max(5, record["rows_in"] // 100):
        print(
            f"{source.id}: 파일은 {record['file_lines']:,}줄인데 읽은 자료 줄은 {record['rows_in']:,}줄입니다({extra:,}줄 차이). "
            "따옴표 안에 줄바꿈이 든 칸이 많거나 따옴표가 잘못 닫힌 것일 수 있습니다. 원본을 확인하세요.",
            file=sys.stderr,
        )


def push_source_info(source: Source, stats: dict[str, Any]) -> dict[str, str]:
    """서버에 보내는 출처의 꼴. 받은 시각은 정리할 때 적어 둔 것을 쓴다."""
    return {
        "id": source.id,
        "name": source.name,
        "url": source.download_url,
        "license": source.license,
        "fetchedAt": stats["fetched_at"],
    }


def push_one(source: Source, base: Path, args: argparse.Namespace, api_url: str, workspace: str | None) -> tuple[dict[str, Any] | None, str | None]:
    """출처 하나를 보낸다(또는 --dry-run 이면 세기만 한다). (기록할 결과, 작업 공간 번호)를 돌려준다."""
    stats = report.load_json(paths.stats_file(base, source.id))
    if not stats:
        return {"stopped": "정리한 줄이 없습니다. 먼저 normalize 를 돌리세요."}, workspace
    if stats.get("failed"):
        return {"stopped": f"지난 정리가 실패했습니다({stats['failed']}). 원본을 확인하고 normalize 를 다시 돌리세요."}, workspace
    rows_path = paths.rows_file(base, source.id)
    on_disk = push.count_rows(rows_path)
    if on_disk != stats["rows_out"]:
        # 기록과 파일이 어긋나면(정리 도중에 끊겼거나 파일을 손으로 고쳤으면) 무엇을 보내는지 알 수 없다.
        return {"stopped": f"정리 기록은 {stats['rows_out']:,}줄인데 결과 파일은 {on_disk:,}줄입니다. normalize 를 다시 돌리세요."}, workspace
    marks = push.read_marks(paths.marks_file(base, source.id))
    rows = push.select_rows(push.read_rows(rows_path), marks, set(args.skip_mark), args.limit)
    if args.dry_run:
        print(json.dumps(push.dry_run(source.id, rows), ensure_ascii=False))
        return None, workspace
    # 수집기가 스스로 뺀 줄 수. 서버는 세지 못하므로 그대로 알려 준다.
    # 줄을 골라 보낼 때(--limit, --skip-mark)는 싣지 않는다. 파일 전체에서 뺀 수라, 16줄을 받은 묶음이 2만 줄을 뺀 것처럼 읽히기 때문이다.
    picked = args.limit is not None or bool(args.skip_mark)
    collector = None if picked else {"unreadable": stats["unreadable_total"], "duplicates": stats["exact_duplicates"] + stats["key_duplicates"]}
    totals, workspace = push.push_source(api_url, push_source_info(source, stats), rows, collector, workspace, time.sleep)
    result = totals.to_json()
    result["collector_counts_sent"] = collector is not None
    return result, workspace


def cmd_push(sources: list[Source], base: Path, args: argparse.Namespace) -> int:
    api_url = args.server.rstrip("/") + "/api/imports"
    workspace: str | None = args.workspace
    log = report.load_json(paths.push_log_file(base)) or {}
    failed = 0
    for source in sources:
        result, workspace = push_one(source, base, args, api_url, workspace)
        if result is None:
            continue
        log[source.id] = result
        if result.get("stopped"):
            print(f"{source.id}: {result['stopped']}", file=sys.stderr)
            failed += 1
    if not args.dry_run:
        paths.out_dir(base).mkdir(parents=True, exist_ok=True)
        with paths.push_log_file(base).open("w", encoding="utf-8") as handle:
            json.dump(log, handle, ensure_ascii=False, indent=2)
        print(f"작업 공간: {workspace}")
        print(report.push_table({source.id: log[source.id] for source in sources if source.id in log}))
    return 1 if failed else 0


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        sources = pick_sources(load_sources(paths.SOURCES_FILE), args.only)
    except SourceError as error:
        print(str(error), file=sys.stderr)
        return 2
    base = paths.data_dir(args.data_dir)
    if args.command == "sources":
        return cmd_sources(sources)
    if args.command == "fetch":
        return cmd_fetch(sources, base, args)
    if args.command == "normalize":
        return cmd_normalize(sources, base)
    if args.command == "push":
        return cmd_push(sources, base, args)
    print(report.build_report(sources, base))
    return 0


if __name__ == "__main__":
    sys.exit(main())
