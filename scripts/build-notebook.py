"""Regenerate the teaching notebook with stable cell IDs and empty outputs."""
from pathlib import Path
from textwrap import dedent

import nbformat as nbf
from nbconvert import MarkdownExporter

root = Path(__file__).resolve().parents[1]
cells = []


def markdown(source):
    cells.append(nbf.v4.new_markdown_cell(dedent(source).strip(), id=f"lab-{len(cells):02d}"))


def code(source):
    cells.append(nbf.v4.new_code_cell(dedent(source).strip(), id=f"lab-{len(cells):02d}"))


markdown("""
# SAP AI Core 견적 Tool 실습

모델·단가 조회부터 견적 비교, SAP Gen AI Hub의 **실제 function calling**까지 순서대로 실습합니다.
Python 노트북은 기존 Node.js Tool을 호출하므로 계산식과 가격표를 복제하지 않습니다.

| 단계 | 실습 | .env / 외부 LLM |
| --- | --- | --- |
| 1 | 모델·단가 확인, Standard/Batch 비교 | 불필요 |
| 2 | 사용량, 부가 서비스, Compute, 통화 환산 | 불필요 |
| 3 | 스크립트 기반 Tool Calling 흐름 관찰 | 불필요 |
| 4 | 자연어 요청 → Gen AI Hub → Tool → 답변 | 필요 |

처음에는 **Run All**로 로컬 실습을 완료하고, 마지막 단계의 `USE_LIVE_LLM`을 켜서 실제 모델을 연결합니다.

GitHub 미리보기에 오류가 나면 [일반 Markdown 버전](https://github.com/KyoungsupShin/ai_core_tool/blob/main/notebooks/01_ai_core_tool_lab.md)에서 내용을 확인할 수 있습니다.
""")
markdown("""
## 준비

저장소 루트에서 Node.js 20+와 Python 3.10+를 준비합니다.

```bash
npm ci
python -m venv .venv
```

macOS/Linux:

```bash
.venv/bin/python -m pip install -r requirements-notebook.txt
.venv/bin/python -m ipykernel install --user --name ai-core-tool --display-name "AI Core Tool Lab"
.venv/bin/python -m jupyterlab
```

Windows PowerShell에서는 `.venv/bin/python`을 `.\\.venv\\Scripts\\python.exe`로 바꿉니다.
Jupyter에서 **AI Core Tool Lab** 커널을 선택하고 이 노트북을 엽니다.
""")
code("""
import json
import sys
from copy import deepcopy
from decimal import Decimal
from pathlib import Path
from IPython.display import JSON, display

ROOT = next((p for p in (Path.cwd(), *Path.cwd().parents)
             if (p / "src/cli.mjs").is_file() and (p / "data/catalog.json").is_file()), None)
if ROOT is None:
    raise RuntimeError("ai_core_tool 저장소 또는 notebooks 폴더에서 노트북을 실행하세요.")
support_path = str(ROOT / "notebooks")
if support_path not in sys.path:
    sys.path.insert(0, support_path)

from lab_support import (
    DEMO_REQUEST, NodeTools, ToolCallError, chat_completion,
    load_settings, make_demo_completion, run_agent,
)

tools = NodeTools(ROOT)
display(tools.check_runtime())
""")
markdown("""
## 1. 모델과 단가 조회

모델명 검색 결과에서 **modelId와 원래 버전명**을 확인합니다. 요청을 처리할 LLM과 견적 대상 모델은 서로 다릅니다.
`LLM_MODEL`은 마지막 단계에서 요청을 해석하는 모델이고, 아래 `modelId`는 사용 비용을 산출할 대상입니다.
""")
code("""
display([{"name": item["function"]["name"], "description": item["function"]["description"]}
         for item in tools.definitions])

models = tools.call("list_models", {"query": "gpt-4.1"})
display(JSON(models["models"]))
""")
code("""
MODEL_ID = "gpt4.1mini"
MODEL_VERSION = "2025-04-14"

pricing = tools.call("get_model_pricing", {"modelId": MODEL_ID, "version": MODEL_VERSION})
display(JSON({key: pricing[key] for key in (
    "modelId", "version", "pricingModes", "prices", "cuMultiplier", "usageByMode"
)}))
""")
markdown("""
이 예제는 앞서 확인한 웹 계산값을 재현하기 위해 과거 카탈로그의 모델 버전을 사용합니다.
은퇴일이 지난 항목도 가격표에 남아 있을 수 있습니다. 결과의 `warnings`를 확인하고 실제 배포 가능 여부와 구분하세요.
다른 모델을 실습할 때는 `get_model_pricing`의 `usageByMode`에서 필수 입력과 지원 모드를 먼저 확인합니다.
""")
markdown("""
## 2. 직접 견적 계산

다음 셀의 사용량을 바꾸어 실행하세요. 토큰은 **요청당**, 요청 수는 **월간** 값입니다.
`monthlyCUExact`는 십진 문자열이며 큰 수의 정확한 비교에도 사용할 수 있습니다.
""")
code("""
estimate_input = {
    "foundationModels": [{
        "modelId": MODEL_ID,
        "version": MODEL_VERSION,
        "pricingMode": "Standard",
        "usage": {
            "inputTokensPerRequest": 2000,
            "outputTokensPerRequest": 500,
            "requestsPerMonth": 10000,
        },
    }],
}

standard = tools.call("estimate_ai_core_cost", estimate_input)
display(JSON({key: standard[key] for key in (
    "monthlyCUExact", "breakdown", "currency", "warnings", "pricingVersion", "policyVersion"
)}))
""")
markdown("""
### Standard와 Batch 비교

원본 입력은 유지하고 요금 모드만 바꿉니다. 지원하지 않는 모델의 Batch 모드는 오류가 됩니다.
기본 예제의 기대값은 Standard `19.3240775`, Batch `9.66203875` CU/월입니다.
""")
code("""
batch_input = deepcopy(estimate_input)
batch_input["foundationModels"][0]["pricingMode"] = "Batch"
batch = tools.call("estimate_ai_core_cost", batch_input)

display([
    {"mode": "Standard", "CU/month": standard["monthlyCUExact"]},
    {"mode": "Batch", "CU/month": batch["monthlyCUExact"]},
    {"mode": "Difference", "CU/month": str(Decimal(standard["monthlyCUExact"]) - Decimal(batch["monthlyCUExact"]))},
])
""")
markdown("""
### 월 요청 수 변경

`REQUEST_COUNTS`를 바꾸고 호출 수에 따른 비용 변화를 비교합니다. 각 금액은 실제 Tool에서 다시 계산합니다.
""")
code("""
REQUEST_COUNTS = [1000, 10000, 100000]
scenarios = []
for requests in REQUEST_COUNTS:
    scenario = deepcopy(estimate_input)
    scenario["foundationModels"][0]["usage"]["requestsPerMonth"] = requests
    quote = tools.call("estimate_ai_core_cost", scenario)
    scenarios.append({"requests/month": requests, "CU/month": quote["monthlyCUExact"]})
display(scenarios)
""")
markdown("""
### 부가 서비스와 Compute 추가

오케스트레이션의 Content Filter, Evaluation, SAP Starter 인스턴스와 저장소를 명시적으로 활성화합니다.
사용하지 않을 항목은 `enabled=False`로 바꾸세요. Compute baseline이 언제 붙는지 `lineItems`에서 확인합니다.
""")
code("""
with_services = deepcopy(estimate_input)
with_services.update({
    "orchestration": {"enabled": True, "contentFilter": {"enabled": True, "blocksPerMonth": 10000}},
    "evaluation": {"enabled": True, "nodeHoursPerMonth": 30},
    "compute": {
        "enabled": True,
        "instances": [{"instanceKey": "SAP:Starter", "hoursPerMonth": 730, "replicas": 1}],
        "objectStorage": {"enabled": True, "storageGB": 10},
    },
})
service_quote = tools.call("estimate_ai_core_cost", with_services)
display(JSON({"totalCU": service_quote["monthlyCUExact"], "breakdown": service_quote["breakdown"], "lineItems": service_quote["lineItems"]}))
""")
markdown("""
### 계약 환산율 적용

아래 `1500`은 실습용으로 사용자가 지정한 값입니다. SAP 공식 요율이나 시장 환율이 아닙니다.
실제 계약의 CU당 금액을 입력해야 고객 금액으로 환산할 수 있습니다.
""")
code("""
currency_input = deepcopy(estimate_input)
currency_input["currency"] = {"code": "KRW", "ratePerCU": 1500}
display(tools.call("estimate_ai_core_cost", currency_input)["currency"])
""")
markdown("""
### 잘못된 입력 처리

음수 토큰, 필수 필드 누락, 없는 버전은 오류입니다. Tool 오류도 구조화된 JSON이므로 LLM에 다시 전달해 수정하게 할 수 있습니다.
""")
code("""
invalid = deepcopy(estimate_input)
invalid["foundationModels"][0]["usage"]["inputTokensPerRequest"] = -1
try:
    tools.call("estimate_ai_core_cost", invalid)
except ToolCallError as error:
    display(JSON(error.error))
""")
markdown("""
## 3. Tool Calling 루프 관찰: 로컬 시뮬레이션

**이 단계는 LLM 추론이 아닙니다.** 고정된 요청에 대한 모델 메시지를 스크립트로 제공하며, Tool 실행은 실제 Node 계산 엔진을 사용합니다.
`list_models → get_model_pricing → Standard/Batch 견적 → 결과 응답`의 연결과 `tool_call_id`를 관찰합니다.
실제 LLM 단계에서도 같은 `run_agent` 함수를 사용합니다.
""")
code("""
print(DEMO_REQUEST)
demo = run_agent(DEMO_REQUEST, completion=make_demo_completion(), node_tools=tools)
assert demo["status"] == "completed"
display(demo["events"])
print(demo["answer"])
""")
code("""
display([
    {"role": message["role"], "tool_call_id": message.get("tool_call_id"),
     "declared_tool_call_ids": [call["id"] for call in message.get("tool_calls", [])]}
    for message in demo["messages"]
])
""")
markdown("""
## 4. 실제 SAP Gen AI Hub 연결

[devday2026의 agent_client.py](https://github.com/KyoungsupShin/devday2026/blob/feature/ks_shin/4_agent_patterns/src/agent_to_agent_advanced/agent_client.py)와 동일하게
`gen_ai_hub.proxy.native.openai.chat.completions.create(model_name=..., tools=...)`를 사용합니다.

저장소 루트의 `.env`에 본인의 설정을 넣으세요. 참고 저장소의 `.env`와 동일한 변수명을 사용합니다.

```dotenv
AICORE_AUTH_URL=...
AICORE_BASE_URL=...
AICORE_CLIENT_ID=...
AICORE_CLIENT_SECRET=...
AICORE_RESOURCE_GROUP=default
LLM_MODEL=...
LLM_SEED=20261018
AICORE_LLM_DEPLOYMENT_ID=
```

`LLM_MODEL`은 해당 리소스 그룹에 배포되어 있으며 function calling을 지원해야 합니다.
deployment ID는 선택 사항입니다. 노트북은 `.env`를 생성·수정하지 않고 셸 환경변수를 우선합니다.
다음 셀은 비밀값 대신 설정 유무만 표시하며 외부 요청을 보내지 않습니다.
""")
code("""
settings = load_settings(ROOT / ".env")
display(settings.readiness())
""")
markdown("""
### 자연어로 견적 요청

본인의 `.env`를 넣은 뒤 `USE_LIVE_LLM=True`로 바꾸고 이 셀부터 실행하세요.
활성화하면 실제 모델 호출과 비용이 발생합니다. 최대 8개 모델 턴, 20개 Tool 호출로 제한합니다.
`LIVE_REQUEST`를 바꾸어 다른 모델, 사용량, Compute 조건도 실습할 수 있습니다.
""")
code("""
USE_LIVE_LLM = False
LIVE_REQUEST = DEMO_REQUEST
live = None

if USE_LIVE_LLM:
    settings = load_settings(ROOT / ".env")
    settings.require_ai_core()
    live = run_agent(
        LIVE_REQUEST,
        completion=lambda **kwargs: chat_completion(settings, **kwargs),
        node_tools=tools,
        max_rounds=8,
        max_tool_calls=20,
    )
    print(live["status"])
    print(live["answer"])
else:
    print("실제 LLM 호출은 꺼져 있습니다. .env 준비 후 USE_LIVE_LLM=True로 실행하세요.")
""")
markdown("""
### 답변의 계산 근거 확인

LLM의 최종 문장과 실제 Tool 반환값을 구분해서 확인합니다. 아래 표는 추정 텍스트가 아니라 실행된 Tool 결과입니다.
실제 LLM을 실행하지 않았다면 시뮬레이션의 Tool 결과를 표시합니다.
""")
code("""
active_run = live if live is not None else demo
verified_quotes = []
for observation in active_run["observations"]:
    result = observation["result"]
    if observation["name"] == "estimate_ai_core_cost" and "error" not in result:
        verified_quotes.append({
            "input": observation["arguments"],
            "CU/month": result["monthlyCUExact"],
            "warnings": result["warnings"],
            "pricingVersion": result["pricingVersion"],
            "policyVersion": result["policyVersion"],
        })
display(JSON(verified_quotes))
""")
markdown("""
## 연습 과제

1. 월 요청 수를 5만 회로 바꾸고 Standard/Batch의 비용을 비교하세요.
2. `list_compute_instances`로 AWS 인스턴스를 찾아 2 replicas × 월 200시간을 계산하세요.
3. `get_model_pricing`으로 Cached 모드가 있는 모델을 찾아 비캐시 입력·캐시 읽기·캐시 쓰기를 따로 넣으세요.
4. 실제 LLM에 필수 사용량이 빠진 요청을 보내고 어떤 추가 질문을 하는지 확인하세요.
5. 결과의 `pricingVersion`, `catalogHash`, `policyVersion`, `policyHash`가 재현성에 어떤 역할을 하는지 확인하세요.

가격표 갱신과 계산 정책 관리는 루트 `README.md`를 참고하세요. `.env`와 실행한 노트북의 출력은 공개 Git에 올리지 마세요.
""")

notebook = nbf.v4.new_notebook(cells=cells, metadata={
    "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
    "language_info": {"name": "python", "version": "3.10"},
})
nbf.validate(notebook)
nbf.write(notebook, root / "notebooks" / "01_ai_core_tool_lab.ipynb")
body, _ = MarkdownExporter().from_notebook_node(notebook)
banner = """> 이 문서는 실습 노트북에서 자동 생성한 정적 미리보기입니다.
> [Jupyter Notebook 열기](https://github.com/KyoungsupShin/ai_core_tool/blob/main/notebooks/01_ai_core_tool_lab.ipynb) · [원본 .ipynb 다운로드](https://github.com/KyoungsupShin/ai_core_tool/raw/refs/heads/main/notebooks/01_ai_core_tool_lab.ipynb)
>
> GitHub에서 `Unable to render code block`가 나오면 이 문서로 내용을 확인하고, 실행은 로컬 Jupyter에서 진행하세요.

"""
(root / "notebooks" / "01_ai_core_tool_lab.md").write_text(banner + body, encoding="utf-8")
print(f"Generated {len(cells)} cells with no execution outputs, plus a Markdown preview.")
