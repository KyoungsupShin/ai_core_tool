> 이 문서는 실습 노트북에서 자동 생성한 정적 미리보기입니다.
> [Jupyter Notebook 열기](https://github.com/KyoungsupShin/ai_core_tool/blob/main/notebooks/01_ai_core_tool_lab.ipynb) · [원본 .ipynb 다운로드](https://github.com/KyoungsupShin/ai_core_tool/raw/refs/heads/main/notebooks/01_ai_core_tool_lab.ipynb)
>
> GitHub에서 `Unable to render code block`가 나오면 이 문서로 내용을 확인하고, 실행은 로컬 Jupyter에서 진행하세요.

# SAP AI Core ReAct 견적 Agent 실습

모델·단가 조회부터 견적 비교, SAP Gen AI Hub에 연결한 **ReAct Agent의 Tool Calling**까지 순서대로 실습합니다.
Python 노트북은 기존 Node.js Tool을 호출하므로 계산식과 가격표를 복제하지 않습니다.

| 단계 | 실습 | .env / 외부 LLM |
| --- | --- | --- |
| 1 | 모델·단가 확인, Standard/Batch 비교 | 불필요 |
| 2 | 사용량, 부가 서비스, Compute, 통화 환산 | 불필요 |
| 3 | LangChain invoke와 ReAct 메시지 순환 | 불필요 |
| 4 | 자연어 요청 → ReAct Agent → Tool → 답변 | 필요 |

처음에는 **Run All**로 로컬 실습을 완료하고, 마지막 단계의 `USE_LIVE_LLM`을 켜서 실제 모델을 연결합니다.

GitHub 미리보기에 오류가 나면 [일반 Markdown 버전](https://github.com/KyoungsupShin/ai_core_tool/blob/main/notebooks/01_ai_core_tool_lab.md)에서 내용을 확인할 수 있습니다.

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

Windows PowerShell에서는 `.venv/bin/python`을 `.\.venv\Scripts\python.exe`로 바꿉니다.
Jupyter에서 **AI Core Tool Lab** 커널을 선택하고 이 노트북을 엽니다.


```python
import json
import sys
from copy import deepcopy
from decimal import Decimal
from pathlib import Path
from IPython.display import JSON, display
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.messages import convert_to_openai_messages
from langchain_core.runnables import RunnableLambda
from langchain_core.tools import StructuredTool

ROOT = next((p for p in (Path.cwd(), *Path.cwd().parents)
             if (p / "src/cli.mjs").is_file() and (p / "data/catalog.json").is_file()), None)
if ROOT is None:
    raise RuntimeError("ai_core_tool 저장소 또는 notebooks 폴더에서 노트북을 실행하세요.")
support_path = str(ROOT / "notebooks")
if support_path not in sys.path:
    sys.path.insert(0, support_path)

from lab_support import (
    DEMO_REQUEST, SYSTEM_PROMPT, NodeTools, ToolCallError,
    load_settings, make_demo_completion,
)

tools = NodeTools(ROOT)
display(tools.check_runtime())
```

## 1. 모델과 단가 조회

모델명 검색 결과에서 **modelId와 원래 버전명**을 확인합니다. 요청을 처리할 LLM과 견적 대상 모델은 서로 다릅니다.
`LLM_MODEL`은 마지막 단계에서 요청을 해석하는 모델이고, 아래 `modelId`는 사용 비용을 산출할 대상입니다.


```python
display([{"name": item["function"]["name"], "description": item["function"]["description"]}
         for item in tools.definitions])

models = tools.call("list_models", {"query": "gpt-4.1"})
display(JSON(models["models"]))
```


```python
MODEL_ID = "gpt4.1mini"
MODEL_VERSION = "2025-04-14"

pricing = tools.call("get_model_pricing", {"modelId": MODEL_ID, "version": MODEL_VERSION})
display(JSON({key: pricing[key] for key in (
    "modelId", "version", "pricingModes", "prices", "cuMultiplier", "usageByMode"
)}))
```

이 예제는 앞서 확인한 웹 계산값을 재현하기 위해 과거 카탈로그의 모델 버전을 사용합니다.
은퇴일이 지난 항목도 가격표에 남아 있을 수 있습니다. 결과의 `warnings`를 확인하고 실제 배포 가능 여부와 구분하세요.
다른 모델을 실습할 때는 `get_model_pricing`의 `usageByMode`에서 필수 입력과 지원 모드를 먼저 확인합니다.

## 2. 직접 견적 계산

다음 셀의 사용량을 바꾸어 실행하세요. 토큰은 **요청당**, 요청 수는 **월간** 값입니다.
`monthlyCUExact`는 십진 문자열이며 큰 수의 정확한 비교에도 사용할 수 있습니다.


```python
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
```

### Standard와 Batch 비교

원본 입력은 유지하고 요금 모드만 바꿉니다. 지원하지 않는 모델의 Batch 모드는 오류가 됩니다.
기본 예제의 기대값은 Standard `19.3240775`, Batch `9.66203875` CU/월입니다.


```python
batch_input = deepcopy(estimate_input)
batch_input["foundationModels"][0]["pricingMode"] = "Batch"
batch = tools.call("estimate_ai_core_cost", batch_input)

display([
    {"mode": "Standard", "CU/month": standard["monthlyCUExact"]},
    {"mode": "Batch", "CU/month": batch["monthlyCUExact"]},
    {"mode": "Difference", "CU/month": str(Decimal(standard["monthlyCUExact"]) - Decimal(batch["monthlyCUExact"]))},
])
```

### 월 요청 수 변경

`REQUEST_COUNTS`를 바꾸고 호출 수에 따른 비용 변화를 비교합니다. 각 금액은 실제 Tool에서 다시 계산합니다.


```python
REQUEST_COUNTS = [1000, 10000, 100000]
scenarios = []
for requests in REQUEST_COUNTS:
    scenario = deepcopy(estimate_input)
    scenario["foundationModels"][0]["usage"]["requestsPerMonth"] = requests
    quote = tools.call("estimate_ai_core_cost", scenario)
    scenarios.append({"requests/month": requests, "CU/month": quote["monthlyCUExact"]})
display(scenarios)
```

### 부가 서비스와 Compute 추가

오케스트레이션의 Content Filter, Evaluation, SAP Starter 인스턴스와 저장소를 명시적으로 활성화합니다.
사용하지 않을 항목은 `enabled=False`로 바꾸세요. Compute baseline이 언제 붙는지 `lineItems`에서 확인합니다.


```python
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
```

### 계약 환산율 적용

아래 `1500`은 실습용으로 사용자가 지정한 값입니다. SAP 공식 요율이나 시장 환율이 아닙니다.
실제 계약의 CU당 금액을 입력해야 고객 금액으로 환산할 수 있습니다.


```python
currency_input = deepcopy(estimate_input)
currency_input["currency"] = {"code": "KRW", "ratePerCU": 1500}
display(tools.call("estimate_ai_core_cost", currency_input)["currency"])
```

### 잘못된 입력 처리

음수 토큰, 필수 필드 누락, 없는 버전은 오류입니다. Tool 오류도 구조화된 JSON이므로 LLM에 다시 전달해 수정하게 할 수 있습니다.


```python
invalid = deepcopy(estimate_input)
invalid["foundationModels"][0]["usage"]["inputTokensPerRequest"] = -1
try:
    tools.call("estimate_ai_core_cost", invalid)
except ToolCallError as error:
    display(JSON(error.error))
```

## 3. ReAct Agent: Reason → Act → Observe

이 실습은 `llm.invoke(messages)`와 `tool.invoke(tool_call)`을 셀에서 직접 호출합니다.
`AIMessage.tool_calls`를 읽고, `ToolMessage`를 메시지 이력에 추가한 다음 모델을 다시 호출하는 코드가 ReAct 순환입니다.
조회·계산 도구의 실행 순서는 매 턴 모델이 선택합니다.

```text
사용자 요청 → Reason (llm.invoke) → Act (tool.invoke) → Observe (ToolMessage)
                 ↑                                  |
                 +----------------------------------+
                 |
                 +→ 최종 답변 / 추가 질문
```

**이 단계의 모델 응답은 스크립트 기반 시뮬레이션입니다.** Tool은 실제 계산 엔진을 사용합니다. 마지막 단계에서는 같은 invoke 루프에 Gen AI Hub의 ChatOpenAI를 연결합니다.
Trace에는 선택한 행동과 관찰된 결과를 기록합니다. 모델의 비공개 추론 과정은 수집하거나 표시하지 않습니다.


```python
def make_langchain_tool(definition):
    function = definition["function"]

    def execute(**arguments):
        result = tools.call(function["name"], arguments)
        return json.dumps(result, ensure_ascii=False)

    return StructuredTool.from_function(
        func=execute,
        name=function["name"],
        description=function["description"],
        args_schema=function["parameters"],
    )

langchain_tools = [make_langchain_tool(definition) for definition in tools.definitions]
tool_map = {tool.name: tool for tool in langchain_tools}
display(list(tool_map))
```

### Reason: invoke 응답에서 Tool 선택 읽기

로컬 데모용 Runnable은 준비된 모델 메시지를 `AIMessage`로 변환합니다. 실제 모델도 같은 메시지 타입을 반환합니다.


```python
def make_demo_llm():
    scripted_completion = make_demo_completion()

    def invoke_demo(messages):
        response = scripted_completion(
            messages=convert_to_openai_messages(messages),
            tools=tools.definitions,
            tool_choice="auto",
        )
        message = response["choices"][0]["message"]
        return AIMessage(
            content=message.get("content") or "",
            tool_calls=[{
                "name": call["function"]["name"],
                "args": json.loads(call["function"]["arguments"]),
                "id": call["id"],
                "type": "tool_call",
            } for call in message.get("tool_calls", [])],
        )

    return RunnableLambda(invoke_demo)

demo_llm = make_demo_llm()
messages = [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=DEMO_REQUEST)]
ai_message = demo_llm.invoke(messages)
display(ai_message.tool_calls)
```

### Act / Observe: 선택한 Tool 실행 후 이력에 추가

`tool.invoke()`에 전체 tool_call을 넘기면 같은 ID를 가진 `ToolMessage`가 반환됩니다.
assistant 메시지와 Tool 결과를 모두 이력에 추가해야 다음 모델 호출이 결과를 관찰할 수 있습니다.


```python
tool_call = ai_message.tool_calls[0]
selected_tool = tool_map[tool_call["name"]]
tool_message = selected_tool.invoke(tool_call)
assert isinstance(tool_message, ToolMessage)
assert tool_message.tool_call_id == tool_call["id"]
display(JSON(json.loads(tool_message.content)))

messages.append(ai_message)
messages.append(tool_message)
next_ai_message = demo_llm.invoke(messages)
display(next_ai_message.tool_calls)
```

### ReAct 순환 코드

아래 함수는 노트북 안에 정의되어 있습니다. 모델 호출, Tool 선택, 실행, 관찰, 종료 조건을 직접 바꾸어 실습하세요.
잘못된 입력이나 없는 Tool은 오류 관찰값으로 전달하고, 모델이 수정 또는 추가 질문을 선택하게 합니다.


```python
def react_invoke(llm_with_tools, user_prompt, max_rounds=8, max_tool_calls=20):
    if not user_prompt.strip() or not 1 <= max_rounds <= 20 or not 1 <= max_tool_calls <= 100:
        raise ValueError("요청과 호출 횟수 제한을 확인하세요.")
    messages = [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=user_prompt)]
    events, observations = [], []
    call_count = 0

    for turn in range(1, max_rounds + 1):
        # Reason: ask the model which action to take using prior observations.
        try:
            ai_message = llm_with_tools.invoke(messages)
        except Exception as error:
            raise RuntimeError(f"LLM invoke 실패 ({type(error).__name__}). 모델과 연결 설정을 확인하세요.") from None
        if not isinstance(ai_message, AIMessage):
            raise TypeError("모델 응답은 AIMessage여야 합니다.")
        calls = ai_message.tool_calls + ai_message.invalid_tool_calls
        events.append({"event": "reason", "round": turn, "selected_tools": [c["name"] for c in calls]})
        if not calls:
            if not ai_message.content:
                raise RuntimeError("답변과 Tool 호출이 모두 비어 있습니다.")
            messages.append(ai_message)
            return {"status": "completed", "answer": ai_message.content,
                    "events": events, "observations": observations, "messages": messages}
        if call_count + len(calls) > max_tool_calls:
            break
        call_ids = [call.get("id") for call in calls]
        if any(not call_id for call_id in call_ids) or len(set(call_ids)) != len(call_ids):
            raise RuntimeError("Tool 호출 ID가 없거나 중복되었습니다.")
        messages.append(ai_message)

        for call in calls:
            call_count += 1
            events.append({"event": "act", "round": turn, "name": call["name"], "arguments": call["args"]})
            # Act: invoke the selected LangChain tool; the Node engine validates its inputs.
            try:
                if call.get("type") == "invalid_tool_call":
                    raise ToolCallError({"code": "INVALID_ARGUMENT", "message": "유효한 JSON 객체로 다시 호출하세요."})
                if call["name"] not in tool_map:
                    raise ToolCallError({"code": "UNKNOWN_TOOL", "message": "등록된 Tool을 선택하세요."})
                tool_message = tool_map[call["name"]].invoke(call)
            except ToolCallError as error:
                tool_message = ToolMessage(content=json.dumps({"error": error.error}, ensure_ascii=False), tool_call_id=call["id"], name=call["name"], status="error")
            except (ValueError, TypeError):
                tool_message = ToolMessage(content=json.dumps({"error": {"code": "INVALID_ARGUMENT", "message": "Tool 입력 형식을 확인하세요."}}), tool_call_id=call["id"], name=call["name"], status="error")

            # Observe: attach the matching ToolMessage before invoking the model again.
            messages.append(tool_message)
            result = json.loads(tool_message.content)
            observations.append({"name": call["name"], "arguments": call["args"], "result": result})
            summary = result.get("monthlyCUExact", result.get("error", "조회 결과 수신"))
            events.append({"event": "observe", "round": turn, "name": call["name"], "summary": summary})

    return {"status": "limit_reached", "answer": "호출 제한에 도달했습니다. 관찰값을 확인하세요.",
            "events": events, "observations": observations, "messages": messages}
```


```python
print(DEMO_REQUEST)
demo = react_invoke(make_demo_llm(), DEMO_REQUEST)
assert demo["status"] == "completed"
demo_quotes = [o["result"] for o in demo["observations"] if o["name"] == "estimate_ai_core_cost"]
assert {quote["lineItems"][0]["pricingMode"] for quote in demo_quotes} == {"Standard", "Batch"}
display(demo["events"])
print(demo["answer"])
```


```python
display([
    {"role": message.type, "tool_call_id": getattr(message, "tool_call_id", None),
     "declared_tool_call_ids": [call["id"] for call in getattr(message, "tool_calls", [])]}
    for message in demo["messages"]
])
```

## 4. ReAct Agent에 실제 SAP Gen AI Hub 연결

[devday2026](https://github.com/KyoungsupShin/devday2026)의 SAP AI SDK 및 환경변수 설정을 사용합니다.
이 실습에서는 SDK의 LangChain 어댑터인 `gen_ai_hub.proxy.langchain.openai.ChatOpenAI`를 직접 생성하고 `bind_tools()`로 Tool을 연결합니다.

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


```python
settings = load_settings(ROOT / ".env")
display(settings.readiness())
```

### 자연어로 견적 요청

본인의 `.env`를 넣은 뒤 `USE_LIVE_LLM=True`로 바꾸고 이 셀부터 실행하세요.
활성화하면 실제 모델 호출과 비용이 발생합니다. 최대 8개 모델 턴, 20개 Tool 호출로 제한합니다.
`LIVE_REQUEST`를 바꾸어 다른 모델, 사용량, Compute 조건도 실습할 수 있습니다.


```python
USE_LIVE_LLM = False
LIVE_REQUEST = DEMO_REQUEST
live = None

if USE_LIVE_LLM:
    settings = load_settings(ROOT / ".env")
    settings.require_ai_core()
    from gen_ai_hub.proxy.langchain.openai import ChatOpenAI

    model_options = {
        "proxy_model_name": settings.llm_model,
        "seed": settings.llm_seed,
        "timeout": 90,
        "max_retries": 0,
    }
    if settings.deployment_id:
        model_options["deployment_id"] = settings.deployment_id
    try:
        llm = ChatOpenAI(**model_options)
        llm_with_tools = llm.bind_tools(langchain_tools)
    except Exception as error:
        raise RuntimeError(f"모델 초기화 실패 ({type(error).__name__}). .env와 모델 배포를 확인하세요.") from None

    live = react_invoke(llm_with_tools, LIVE_REQUEST, max_rounds=8, max_tool_calls=20)
    print(live["status"])
    print(live["answer"])
else:
    print("실제 LLM 호출은 꺼져 있습니다. .env 준비 후 USE_LIVE_LLM=True로 실행하세요.")
```

### 답변의 계산 근거 확인

LLM의 최종 문장과 실제 Tool 반환값을 구분해서 확인합니다. 아래 표는 추정 텍스트가 아니라 실행된 Tool 결과입니다.
실제 LLM을 실행하지 않았다면 시뮬레이션의 Tool 결과를 표시합니다.


```python
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
```

## 연습 과제

1. 월 요청 수를 5만 회로 바꾸고 Standard/Batch의 비용을 비교하세요.
2. `list_compute_instances`로 AWS 인스턴스를 찾아 2 replicas × 월 200시간을 계산하세요.
3. `get_model_pricing`으로 Cached 모드가 있는 모델을 찾아 비캐시 입력·캐시 읽기·캐시 쓰기를 따로 넣으세요.
4. 실제 LLM에 필수 사용량이 빠진 요청을 보내고 어떤 추가 질문을 하는지 확인하세요.
5. 결과의 `pricingVersion`, `catalogHash`, `policyVersion`, `policyHash`가 재현성에 어떤 역할을 하는지 확인하세요.
6. ReAct Trace에서 Observe 다음에 어떤 Tool을 선택했는지 확인하고, 잘못된 입력을 고쳐 다시 호출하는 흐름을 관찰하세요.

가격표 갱신과 계산 정책 관리는 루트 `README.md`를 참고하세요. `.env`와 실행한 노트북의 출력은 공개 Git에 올리지 마세요.
