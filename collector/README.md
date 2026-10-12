# 수집기

공공기관이 낸 광고 매체 현황 CSV 를 받아 한 꼴로 정리하고, 본체의 `POST /api/imports` 로 넘기는 명령 줄 도구다.
설명과 실제로 잰 수는 [docs/COLLECTOR.md](../docs/COLLECTOR.md), 서버와 주고받는 꼴은 [docs/IMPORT-FORMAT.md](../docs/IMPORT-FORMAT.md)에 있다.

저장소 맨 위 폴더에서 돌린다. 자료 폴더는 환경 변수 `CHAEUM_DATA_DIR` 로 정한다(없으면 `collector/.cache`).

```sh
python3.12 -m venv collector/.venv && collector/.venv/bin/pip install -r collector/requirements.txt   # 처음 한 번
collector/.venv/bin/python -m collector sources                    # 출처 목록(기관·이용 조건·기준일)
collector/.venv/bin/python -m collector fetch --offline            # 받아 둔 파일 확인(--offline 을 빼면 내려받는다)
collector/.venv/bin/python -m collector normalize                  # 한 꼴로 정리해 <자료 폴더>/out/ 에 쓴다
collector/.venv/bin/python -m collector push --dry-run             # 보내지 않고 수만 센다(보낼 때는 --server, --workspace)
collector/.venv/bin/python -m collector report                     # 출처별 수를 표로
```

- 모든 명령에 `--only <출처 id>` 를 붙여 출처를 고를 수 있다(여러 번 쓸 수 있다).
- 시험: `collector/.venv/bin/python -m pytest collector`
- 실행에는 표준 라이브러리만 쓴다. `requirements.txt` 의 pytest 는 시험에만 필요하다.
- 원자료와 정리 결과는 저장소에 넣지 않는다.
