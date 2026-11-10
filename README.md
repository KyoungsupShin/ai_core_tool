# SAP AI Core Estimate Tool

SAP AI Core Calculator의 가격표와 계산식을 분리한 로컬 Tool입니다. Node.js 20 이상에서 CLI 또는 JavaScript 함수로 호출합니다. MCP 서버나 LLM API 연결은 필요하지 않습니다.

## Jupyter 실습

[실습 노트북](notebooks/01_ai_core_tool_lab.ipynb)은 Python에서 기존 Node Tool을 호출합니다. 모델·단가 조회, Standard/Batch 비교, 부가 서비스·Compute, 계약 환산율, 오류 처리, ReAct Agent의 Tool Calling을 순서대로 실습합니다.

GitHub 미리보기에서 `Unable to render code block`가 나오면 [일반 Markdown 미리보기](notebooks/01_ai_core_tool_lab.md)를 이용하세요. [원본 .ipynb 다운로드](https://github.com/KyoungsupShin/ai_core_tool/raw/refs/heads/main/notebooks/01_ai_core_tool_lab.ipynb)도 가능하며 실행은 로컬 Jupyter에서 진행합니다.

```bash
npm ci
python -m venv .venv
.venv/bin/python -m pip install -r requirements-notebook.txt
.venv/bin/python -m ipykernel install --user --name ai-core-tool --display-name "AI Core Tool Lab"
.venv/bin/python -m jupyterlab
```

Windows PowerShell에서는 `.venv/bin/python` 대신 `.\.venv\Scripts\python.exe`를 사용합니다. Jupyter에서 **AI Core Tool Lab** 커널을 선택합니다.

기본 Run All은 실제 LLM을 호출하지 않습니다. 스크립트 기반 모델 응답과 실제 로컬 Tool로 전체 흐름을 확인합니다. 실제 자연어 LLM 실습은 루트 `.env`를 직접 준비한 뒤 노트북의 `USE_LIVE_LLM=True`로 켭니다. `.env.example`에는 비어 있는 설정 항목만 있으며 `.env`는 Git에서 제외합니다.

노트북에는 `ChatOpenAI.bind_tools()`, `llm.invoke(messages)`, `AIMessage.tool_calls`, `tool.invoke(tool_call)`, `ToolMessage` 피드백 코드를 직접 펼쳐 두었습니다. ReAct 순환을 제어하는 `react_invoke` 함수도 셀 안에 있어 수정하며 실습할 수 있습니다. 모델이 도구와 순서를 선택하고 관찰값이나 오류를 근거로 다시 판단합니다. 최대 모델 턴·Tool 호출 수를 넘으면 중단합니다. 별도의 LangGraph 구현은 `notebooks/lab_support.py`에 참고용으로 유지합니다.

LLM 연결은 [devday2026](https://github.com/KyoungsupShin/devday2026)의 SAP AI SDK 설정을 참고했습니다. 같은 `AICORE_*`, `LLM_MODEL`, `LLM_SEED`, 선택적 `AICORE_LLM_DEPLOYMENT_ID`를 사용하며 `gen_ai_hub.proxy.langchain.openai.ChatOpenAI`로 연결합니다. `LLM_MODEL`은 요청을 해석할 모델이며 견적 대상의 `modelId`와는 별개입니다.

노트북·Python 연결 검증:

```bash
.venv/bin/python -m unittest discover -s notebooks -p 'test_*.py'
.venv/bin/python scripts/check-notebook.py
```

노트북은 실행 출력 없이 커밋합니다. `scripts/build-notebook.py`로 노트북과 Markdown 미리보기를 함께 재생성할 수 있습니다. 실제 Gen AI Hub 연결은 본인의 자격 증명과 function calling 지원 배포가 필요합니다.

## 실행

```bash
npm ci
node src/cli.mjs estimate_ai_core_cost @examples/estimate.json
npm test
```

예제는 Standard `19.3240775 CU/month`를 반환합니다. 예제 모델 버전의 은퇴일이 지났으므로 경고도 함께 반환합니다.

## 구성

```text
data/catalog.json             모델, 버전, 단가, CU 계수, Compute 가격
data/rules.json               할인율, 상한, 보조 서비스 요율, 내부 환산 정책
src/engine.mjs                Decimal 계산, 항목 합산, 모델별 입력 검사
src/schemas.mjs               Tool 입력 JSON Schema 및 function definitions
src/tools.mjs                 callTool 함수와 검증된 도구 디스패치
src/cli.mjs                   JSON CLI
scripts/import-snapshot.mjs   원본 번들에서 안전하게 가격표 후보 추출
scripts/diff-snapshot.mjs     활성 가격표와 후보 비교
test/                         계산·검증·원본 브라우저 결과 회귀 테스트
```

카탈로그에는 원본 모델 99개와 Compute 인스턴스·리소스 플랜 44개가 있습니다. external/internal 가용성에 따라 조회 결과가 달라집니다. 계산에는 웹 접속이 필요하지 않습니다.

## 도구 목록

| Tool | 입력 | 결과 |
| --- | --- | --- |
| list_models | query, provider, mode 선택 | 모델 ID, 타입, 원래 버전명, 은퇴일 |
| get_model_pricing | modelId, version 필수 | 단가, 지원 모드, 필수·선택 사용량 필드 |
| list_compute_instances | query, mode 선택 | instanceKey, 시간당 CU |
| estimate_ai_core_cost | 명시적 서비스 구성 | 월 CU, 항목별 비용, 단가, 버전, 경고 |

```bash
node src/cli.mjs list_models '{"query":"gpt-4.1"}'
node src/cli.mjs get_model_pricing '{"modelId":"gpt4.1mini","version":"2025-04-14"}'
node src/cli.mjs list_compute_instances '{"query":"Starter"}'
node src/cli.mjs --definitions
```

`--definitions`는 function calling에 사용하는 JSON Schema 정의를 출력합니다. 입력 키 오타, 음수, 소수 토큰 수, 없는 모델·버전, 지원하지 않는 Batch/캐시 모드는 오류이며 CLI 종료 코드는 1입니다. 서비스가 enabled이면 필요한 사용량을 명시해야 합니다.

## 함수 호출

```js
import {createTools} from './src/tools.mjs';

const {callTool, definitions} = createTools();
const result = callTool('estimate_ai_core_cost', {
  foundationModels: [{
    modelId: 'gpt4.1mini',
    version: '2025-04-14',
    pricingMode: 'Standard',
    usage: {
      inputTokensPerRequest: 2000,
      outputTokensPerRequest: 500,
      requestsPerMonth: 10000
    }
  }]
});
console.log(result.monthlyCUExact); // '19.3240775'
```

`definitions`를 에이전트의 tools에 전달하고, 반환된 함수 이름과 JSON arguments를 `callTool`에 넘기면 됩니다. API 키나 특정 LLM SDK를 코드에 넣지 않았습니다. `examples/function-call.mjs`도 바로 실행할 수 있습니다.

CLI도 같은 호출 형식을 받습니다.

```bash
node src/cli.mjs --call '{"name":"list_models","arguments":{"query":"embedding"}}'
```

## 추가 서비스

견적 입력에 다음 객체들을 선택적으로 추가합니다. 생략한 서비스와 enabled=false인 서비스는 비용 0입니다. 상위 서비스가 꺼져 있으면 하위 설정도 비용에 반영하지 않습니다.

```json
{
  "orchestration": {
    "enabled": true,
    "contentFilter": {"enabled": true, "blocksPerMonth": 10000},
    "grounding": {"enabled": true, "queriesPerMonth": 10000, "storageGBDay": 1}
  },
  "promptOptimization": {"enabled": true, "promptsPerMonth": 30},
  "evaluation": {"enabled": true, "nodeHoursPerMonth": 30},
  "compute": {
    "enabled": true,
    "instances": [{"instanceKey": "SAP:Starter", "hoursPerMonth": 730, "replicas": 1}],
    "objectStorage": {"enabled": true, "storageGB": 10}
  }
}
```

Translation, dataMasking, inferenceObservability도 `{enabled, requestsPerMonth}`로 구성합니다. Cached 모드에서는 readCachedInputTokensPerRequest, writeCachedInputTokensPerRequest를 따로 입력하며 inputTokensPerRequest는 비캐시 입력입니다. 모든 모델 타입의 필드는 get_model_pricing의 usageByMode 또는 전체 Tool Schema로 확인합니다.

## 반환값과 계산 정책

- monthlyCUExact, breakdown, lineItems의 비용은 정확한 십진 문자열입니다. monthlyCU는 표시용 숫자이며 큰 금액은 문자열 값을 사용합니다.
- pricingVersion은 원본 번들의 SHA-256이고 catalogHash, policyVersion, policyHash, calculatorVersion도 함께 반환합니다. JSON을 수동 수정한 경우에도 데이터 해시가 달라집니다.
- 기본 모드는 external이며 currency=null입니다. `{currency: {code: 'KRW', ratePerCU: 1500}}`처럼 계약 환산율을 명시하면 금액도 계산합니다.
- internal 모드의 금액은 원본 사이트의 SAP 내부 요율입니다. 사용자가 currency를 명시하면 그 계약 환산율이 우선합니다.
- 사이트 UI의 복수 모델 자동 추천은 적용하지 않습니다. 오케스트레이션과 Prompt Optimization은 명시적으로 활성화해야 합니다.
- 원본은 동일 가격 버전을 합치지만 이 Tool은 버전을 보존하고 명시된 버전의 가격을 사용합니다. 모델의 실제 이용 가능 여부는 외부 서비스에서 확인해야 합니다.
- 금액은 Decimal 60자리 정밀도로 합산한 후 기본 소수점 10자리까지 반올림합니다. 실제 청구액 또는 SAP의 공식 견적이 아닙니다.
- Grounding storageGBDay는 원본 계산식의 필드명이며 일수를 추가 곱하지 않습니다.

## 가격표 갱신

사이트 HTML에서 최신 module script URL을 자동으로 찾아 다운로드하고, 원격 JavaScript를 실행하지 않고 Acorn AST로 데이터 리터럴만 추출합니다.

```bash
npm run pricing:refresh
```

실행 결과의 `run` 폴더에 원본 HTML/JS, `candidate.json`, 변경 전·후 값을 담은 `report.json`, 검토용 `report.md`가 생성됩니다. 가격·버전·모델·가용성·Compute·저장소·CU 계수를 비교하며 현재 활성 데이터는 그대로 둡니다.

검토한 후보의 소스 SHA를 지정해 활성화합니다.

```bash
npm run pricing:activate -- --run work/pricing-refresh/run-XXXXXX --expected-sha REVIEWED_SHA256
```

후보 변조, 규칙 변경, 기존 가격표의 동시 변경을 검사하고 이전 데이터를 백업한 뒤 파일을 교체합니다. 계산 규칙과 기존 회귀 결과는 원본과 대조해 검토해야 합니다. 고정된 과거 가격을 검증하는 테스트가 새 가격에서 실패하면 기대값을 무조건 덮어쓰지 말고 원본 계산과 비교하여 fixture를 갱신합니다.

GitHub Actions는 매일 **한국 시간 09:17** 또는 수동 실행으로 최신 데이터를 확인합니다. 변경이 있으면 **draft PR**을 생성·갱신하며 자동 병합하지 않습니다. 다운로드·추출·검증 실패 시 활성 가격표를 교체하지 않습니다. 실행 자료는 Actions artifact로 30일 보관합니다. [파이프라인 상세](docs/pricing-pipeline.md)를 참고하세요.

이미 받은 번들에서 후보를 추출하는 기존 명령도 유지합니다.

```bash
SOURCE_BUNDLE_URL='https://example.com/observed-bundle.js' \
  npm run snapshot -- path/to/bundle.js candidate.json
npm run snapshot:diff -- data/catalog.json candidate.json
```

후보 파일은 새 경로에만 생성되며 기존 파일을 덮어쓰지 않습니다. 추출 구조가 바뀌면 실패하도록 구성했습니다. 번들 변경은 UI 변경일 수도 계산 규칙 변경일 수도 있으므로 diff만으로 규칙 불변을 가정하지 않습니다.

가격 차이와 원본 계산 함수 변경을 검토하고 필요하면 rules.json과 calculatorVersion을 갱신합니다. 새 카탈로그와 원본 계산을 대조한 후 회귀 테스트를 갱신합니다. 다운로드와 변경 탐지는 자동화되어 있으며, 본 서비스에 반영하는 경계는 검토 후 PR 병합 또는 명시적인 로컬 활성화입니다.

## 검증 범위

화면에서 확인한 Standard/Batch/Evaluation 결과와 수치 대조를 수행했습니다. 별도의 검증 브라우저에서는 원본 계산 함수를 변경 없이 노출하여 7가지 모델 타입, 버전, 요금 모드를 비교했고 그 결과를 test/fixtures/browser-parity.json에 보존했습니다. Orchestration, Compute baseline 상한, 저장소, 통화 환산, 비활성 서비스, 입력 오류는 별도 테스트로 검증합니다.

원본 웹사이트의 모델 선택 UI 전체 흐름 또는 실제 AI 추론·배포 API는 이 Tool의 검증 범위에 포함하지 않습니다.
