# 가격 갱신 파이프라인

```text
SAP Calculator HTML → 현재 module script URL → JavaScript 다운로드
    → Acorn AST 데이터 추출 → 카탈로그·단가·견적 검증
    → 기존 데이터와 비교 → 후보 + 보고서 + 원본 보관
    → 검토 후 활성화 / GitHub draft PR → 검토 후 병합
```

## 수동 실행

```bash
npm ci
npm run pricing:refresh
```

매번 새로운 `work/pricing-refresh/run-*` 폴더를 생성합니다. 실행 결과의 `run` 경로를 확인하세요. 경로를 지정할 때는 아직 없는 디렉터리를 사용합니다.

```bash
npm run pricing:refresh -- --output work/pricing-review-001
```

폴더 내용:

| 파일 | 용도 |
| --- | --- |
| source.html | 실제 내려받은 진입 HTML |
| source.js | 실제 내려받은 애플리케이션 번들 |
| candidate.json | 추출하고 검증한 새 가격표 |
| report.json | SHA, 데이터 해시, 변경 전·후 값, 검증 결과 |
| report.md | 검토할 변경 요약 |
| failure.json | 실패한 경우의 원인 |

HTTP 실패, 다른 출처로 이동하는 리다이렉트, 과도한 다운로드 크기, 데이터 구조 변경, 음수·누락 단가, 중복 ID를 검사합니다. 모델·버전·지원 모드별로 실제 견적 엔진을 호출해 결과가 유효한지도 검사합니다. 현재 초기 스냅샷에서는 159개 조합을 확인합니다.

다운로드한 JavaScript는 실행하지 않습니다. HTML은 parse5, JavaScript는 Acorn으로 파싱합니다. 프록시와 인증서 설정은 실행 환경의 설정을 사용하며 인증서 검증을 끄지 않습니다. AI Core 자격 증명이나 `.env`가 필요하지 않습니다.

## 변경 분류

- `dataChanged`: 모델, 단가, 가용성, Compute/저장소 또는 추출된 계수에 변경이 있음.
- `sourceChanged`: 애플리케이션 번들의 SHA-256이 달라짐.
- `sourceOnlyChanged`: 추출한 가격 데이터는 같지만 번들이 달라짐. UI 또는 계산 규칙 변경일 수 있음.
- `policyReviewRequired`: 소스가 달라져 계산 규칙을 검토해야 함.

규칙을 임의로 추론하거나 rules.json을 원격 코드에 맞춰 자동 수정하지 않습니다. Batch 할인, 보조 서비스 공식 같은 규칙이 바뀌면 원본 소스와 비교하여 별도 반영합니다. 추출 대상 구조가 크게 바뀌면 실패하므로 추출기를 수정한 뒤 다시 실행해야 합니다.

## 활성화

`report.md`와 원본 계산식을 검토한 뒤 보고서의 `candidateVersion`을 명시합니다.

```bash
npm run pricing:activate -- --run work/pricing-review-001 --expected-sha REVIEWED_SHA256
```

활성화 시 원본 JS의 SHA, 후보의 데이터 해시, rules.json의 해시, 현재 활성 가격표의 해시를 다시 확인합니다. 원본에서 재추출한 결과와 후보가 같은지도 확인합니다. 검증 후 `previous-active.json`으로 백업하고 임시 파일을 rename하여 활성 가격표를 교체합니다. 잠금 파일로 동시 활성화를 막습니다. 새 가격표는 다음 Tool 호출부터 적용됩니다.

잘못된 SHA, 검증 후 후보·규칙 변경, 다른 실행이 먼저 가격표를 바꾼 경우에는 중단하고 다시 수집해야 합니다. 이미 활성화한 같은 후보를 다시 지정하면 교체하지 않습니다. 이전 버전은 실행 폴더의 백업 또는 Git 이력으로 보존됩니다.

## GitHub 자동 실행

워크플로: `.github/workflows/refresh-pricing.yml`.

1. 매일 00:17 UTC, 즉 한국 시간 09:17에 확인합니다. GitHub 스케줄은 지연될 수 있습니다.
2. Actions에서 **Refresh SAP AI Core pricing → Run workflow**로 수동 실행할 수 있습니다.
3. 변경 시 `automation/pricing-refresh` 브랜치에 후보 가격표를 올리고 draft PR을 생성합니다.
4. main의 데이터는 PR 검토·병합 전까지 바뀌지 않습니다.
5. Actions artifact에 원본과 보고서를 30일 보관합니다.

기본 `GITHUB_TOKEN`을 사용하며 별도 AI Core 키는 필요하지 않습니다. 저장소 설정에서 GitHub Actions의 PR 생성이 제한되어 있다면 **Settings → Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull requests**를 활성화해야 draft PR을 만들 수 있습니다. 조직 정책에 의해 제한되면 artifact를 내려받아 수동 검토·활성화할 수 있습니다. 이 워크플로에는 PR 승인이나 자동 병합 단계가 없습니다.

과거 브라우저 관측값을 검증하는 회귀 테스트는 가격 갱신 후 실패할 수 있습니다. PR에서 원본 계산과 다시 대조하고 예제·fixture를 함께 갱신한 뒤 `npm test`를 통과시켜 병합하세요. pipeline의 smoke 검증만으로 계산 규칙이 불변이라고 판단하지 않습니다.

## 검증

```bash
npm run test:pricing
npm test
```

파이프라인 테스트는 가짜 HTTP 응답과 임시 파일을 사용합니다. 네트워크 실패, 구조 변경, 변경 탐지, 기존 데이터 보존, 후보 변조, 오래된 보고서, 명시적 활성화와 백업을 확인합니다.
