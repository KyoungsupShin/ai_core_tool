"""Python bridge and Gen AI Hub tool loop for the notebook lab."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from copy import deepcopy
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

PROJECT_ROOT = Path(__file__).resolve().parents[1]


class ToolCallError(RuntimeError):
    def __init__(self, error: dict[str, Any]):
        self.error = error
        super().__init__(f"{error.get('code', 'TOOL_ERROR')}: {error.get('message', 'Tool failed')}")


class NodeTools:
    """Call the existing Node engine, without reimplementing pricing in Python."""

    def __init__(self, project_root: Path = PROJECT_ROOT):
        self.root = Path(project_root).resolve()
        self.node = shutil.which("node")
        if not self.node:
            raise RuntimeError("Node.js 20+ is required. Install Node.js, then run npm ci at the repository root.")

    def check_runtime(self) -> dict[str, str]:
        version = subprocess.run([self.node, "--version"], capture_output=True, text=True, check=True, timeout=10).stdout.strip()
        if int(version.lstrip("v").split(".")[0]) < 20:
            raise RuntimeError("Node.js 20+ is required.")
        if not (self.root / "node_modules" / "decimal.js").exists() or not (self.root / "node_modules" / "ajv").exists():
            raise RuntimeError("Run npm ci at the repository root before starting this notebook.")
        return {"node": version, "engine": "src/cli.mjs", "pricing": "data/catalog.json"}

    @property
    def definitions(self) -> list[dict[str, Any]]:
        return json.loads((self.root / "tool-definitions.json").read_text(encoding="utf-8"))

    def call(self, name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
        if not isinstance(name, str) or arguments is not None and not isinstance(arguments, dict):
            raise ValueError("Expected a tool name and an arguments object.")
        try:
            result = subprocess.run(
                [self.node, str(self.root / "src" / "cli.mjs"), "--call"],
                input=json.dumps({"name": name, "arguments": {} if arguments is None else arguments}, allow_nan=False),
                capture_output=True, text=True, encoding="utf-8", cwd=self.root, timeout=30,
            )
        except subprocess.TimeoutExpired:
            raise ToolCallError({"code": "TOOL_TIMEOUT", "message": "Local tool exceeded 30 seconds."}) from None
        if result.returncode:
            try:
                error = json.loads(result.stderr)["error"]
            except (ValueError, KeyError, TypeError):
                error = {"code": "TOOL_RUNTIME_ERROR", "message": "Node tool failed. Check npm ci and the Node.js version."}
            raise ToolCallError(error)
        return json.loads(result.stdout)


@dataclass(frozen=True)
class Settings:
    auth_url: str = field(default="", repr=False)
    base_url: str = field(default="", repr=False)
    client_id: str = field(default="", repr=False)
    client_secret: str = field(default="", repr=False)
    resource_group: str = "default"
    llm_model: str = ""
    llm_seed: int = 20261018
    deployment_id: str = field(default="", repr=False)

    def readiness(self) -> dict[str, bool]:
        return {name: bool(value.strip()) for name, value in {
            "AICORE_AUTH_URL": self.auth_url,
            "AICORE_BASE_URL": self.base_url,
            "AICORE_CLIENT_ID": self.client_id,
            "AICORE_CLIENT_SECRET": self.client_secret,
            "LLM_MODEL": self.llm_model,
        }.items()}

    def require_ai_core(self) -> None:
        missing = [name for name, present in self.readiness().items() if not present]
        if missing:
            raise RuntimeError("Missing .env settings: " + ", ".join(missing))


def load_settings(env_file: Path | None = None) -> Settings:
    from dotenv import load_dotenv

    load_dotenv(env_file or PROJECT_ROOT / ".env", override=False)
    try:
        seed = int(os.getenv("LLM_SEED", "20261018"))
    except ValueError:
        raise ValueError("LLM_SEED must be an integer.") from None
    return Settings(
        auth_url=os.getenv("AICORE_AUTH_URL", "").strip().rstrip("/"),
        base_url=os.getenv("AICORE_BASE_URL", "").strip().rstrip("/"),
        client_id=os.getenv("AICORE_CLIENT_ID", "").strip(),
        client_secret=os.getenv("AICORE_CLIENT_SECRET", "").strip(),
        resource_group=os.getenv("AICORE_RESOURCE_GROUP", "default").strip() or "default",
        llm_model=os.getenv("LLM_MODEL", "").strip(), llm_seed=seed,
        deployment_id=os.getenv("AICORE_LLM_DEPLOYMENT_ID", "").strip(),
    )


def chat_completion(settings: Settings, *, messages: list[dict[str, Any]], tools: list[dict[str, Any]], tool_choice: str = "auto") -> Any:
    """Use the same native SAP SDK call as devday2026's agent_client.py."""
    settings.require_ai_core()
    for key, value in {
        "AICORE_AUTH_URL": settings.auth_url, "AICORE_BASE_URL": settings.base_url,
        "AICORE_CLIENT_ID": settings.client_id, "AICORE_CLIENT_SECRET": settings.client_secret,
        "AICORE_RESOURCE_GROUP": settings.resource_group,
    }.items():
        os.environ.setdefault(key, value)
    request = {"model_name": settings.llm_model, "messages": messages, "tools": tools,
               "tool_choice": tool_choice, "seed": settings.llm_seed, "timeout": 90}
    if settings.deployment_id:
        request["deployment_id"] = settings.deployment_id
    try:
        from gen_ai_hub.proxy.native.openai import chat
        return chat.completions.create(**request)
    except ImportError:
        raise RuntimeError("Install requirements-notebook.txt in the notebook's Python environment.") from None
    except Exception as error:
        # SDK errors can contain HTTP request details. Keep credentials out of notebook outputs.
        raise RuntimeError(f"Gen AI Hub call failed ({type(error).__name__}). Check credentials, model/deployment and tool-calling support.") from None


SYSTEM_PROMPT = """You help estimate SAP AI Core costs. Answer in Korean.
Use list_models and get_model_pricing to verify model IDs, original versions and supported pricing modes.
Use estimate_ai_core_cost for every cost figure; never invent prices or calculate a quote yourself.
Token quantities are per request; requests are monthly. Optional services stay disabled unless explicitly requested.
If required usage/model/version is missing, ask the user for it rather than guessing.
Report the mode, monthly CU, assumptions, source version and retirement/deprecation warnings from tool results.
External CU conversion requires the user's explicit contract rate. Internal rates are not customer prices.
A pricing catalog entry does not guarantee that the model is currently deployable.
Tool errors are observations: repair the arguments if possible or ask for clarification.
Do not request credentials or call tools other than those supplied. Provide concise answers and no private reasoning.
""".strip()


def _field(value: Any, key: str, default: Any = None) -> Any:
    return value.get(key, default) if isinstance(value, dict) else getattr(value, key, default)


def _reject_nonfinite(value: str) -> None:
    raise ValueError(f"Non-finite JSON number: {value}")


def run_agent(
    request: str, *, completion: Callable[..., Any], node_tools: NodeTools | None = None,
    max_rounds: int = 8, max_tool_calls: int = 20,
) -> dict[str, Any]:
    """Bounded native function-calling loop; the same protocol serves demo and live mode."""
    if not isinstance(request, str) or not request.strip():
        raise ValueError("Enter a non-empty request.")
    if not 1 <= max_rounds <= 20 or not 1 <= max_tool_calls <= 100:
        raise ValueError("Use 1..20 rounds and 1..100 tool calls.")
    node_tools = node_tools or NodeTools()
    definitions = node_tools.definitions
    names = {item["function"]["name"] for item in definitions}
    messages: list[dict[str, Any]] = [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": request.strip()}]
    events: list[dict[str, Any]] = []
    observations: list[dict[str, Any]] = []
    call_count = 0
    for round_number in range(1, max_rounds + 1):
        events.append({"event": "llm_request", "round": round_number})
        response = completion(messages=deepcopy(messages), tools=deepcopy(definitions), tool_choice="auto")
        choices = _field(response, "choices", [])
        if not choices:
            raise RuntimeError("LLM response has no choices.")
        message = _field(choices[0], "message")
        calls = _field(message, "tool_calls", []) or []
        content = _field(message, "content") or ""
        if not calls:
            if not isinstance(content, str) or not content.strip():
                raise RuntimeError("LLM response contains neither text nor tool calls.")
            messages.append({"role": "assistant", "content": content})
            events.append({"event": "final_answer", "round": round_number})
            return {"status": "completed", "answer": content, "events": events, "observations": observations, "messages": messages}
        if call_count + len(calls) > max_tool_calls:
            break
        normalized = []
        ids: set[str] = set()
        for call in calls:
            function = _field(call, "function")
            call_id = _field(call, "id")
            name = _field(function, "name")
            raw = _field(function, "arguments", "{}")
            if not isinstance(call_id, str) or not call_id or call_id in ids or not isinstance(name, str) or not isinstance(raw, str):
                raise RuntimeError("LLM returned an invalid tool-call contract.")
            ids.add(call_id)
            normalized.append({"id": call_id, "type": "function", "function": {"name": name, "arguments": raw}})
        messages.append({"role": "assistant", "content": content, "tool_calls": normalized})
        for call in normalized:
            call_count += 1
            name = call["function"]["name"]
            arguments: Any = None
            try:
                arguments = json.loads(call["function"]["arguments"], parse_constant=_reject_nonfinite)
                if not isinstance(arguments, dict):
                    raise ValueError("Tool arguments must be an object.")
                if name not in names:
                    raise ToolCallError({"code": "UNKNOWN_TOOL", "message": "Select a tool from the supplied definitions."})
                result = node_tools.call(name, arguments)
            except (ValueError, TypeError):
                result = {"error": {"code": "INVALID_ARGUMENT", "message": "Tool arguments must be a valid JSON object."}}
            except ToolCallError as error:
                result = {"error": error.error}
            events.append({"event": "tool_result", "round": round_number, "name": name, "arguments": arguments, "ok": "error" not in result})
            observations.append({"name": name, "arguments": arguments, "result": result})
            messages.append({"role": "tool", "tool_call_id": call["id"], "content": json.dumps(result, ensure_ascii=False)})
    events.append({"event": "limit_reached", "toolCalls": call_count})
    return {"status": "limit_reached", "answer": "호출 횟수 제한에 도달했습니다. 관찰된 Tool 결과를 확인하고 요청을 좁혀 다시 실행하세요.", "events": events, "observations": observations, "messages": messages}


DEMO_REQUEST = "GPT-4.1 mini의 2025-04-14 버전으로 요청당 입력 2,000토큰, 출력 500토큰, 월 10,000회를 사용합니다. Standard와 Batch의 월 CU를 비교하세요. 추가 서비스는 사용하지 않으며 과거 카탈로그의 계산 재현이 목적입니다."


def make_demo_completion() -> Callable[..., dict[str, Any]]:
    """Scripted model messages for one fixed exercise; no LLM/network inference."""
    step = 0

    def reply(*, messages: list[dict[str, Any]], **_: Any) -> dict[str, Any]:
        nonlocal step
        def tool(call_id: str, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
            return {"id": call_id, "type": "function", "function": {"name": name, "arguments": json.dumps(arguments)}}
        item = {"modelId": "gpt4.1mini", "version": "2025-04-14", "pricingMode": "Standard", "usage": {"inputTokensPerRequest": 2000, "outputTokensPerRequest": 500, "requestsPerMonth": 10000}}
        if step == 0:
            message = {"tool_calls": [tool("demo-models", "list_models", {"query": "gpt-4.1-mini"})]}
        elif step == 1:
            message = {"tool_calls": [tool("demo-price", "get_model_pricing", {"modelId": item["modelId"], "version": item["version"]})]}
        elif step == 2:
            batch = deepcopy(item)
            batch["pricingMode"] = "Batch"
            message = {"tool_calls": [tool("demo-standard", "estimate_ai_core_cost", {"foundationModels": [item]}), tool("demo-batch", "estimate_ai_core_cost", {"foundationModels": [batch]})]}
        else:
            estimates = [json.loads(m["content"]) for m in messages if m["role"] == "tool" and "monthlyCUExact" in json.loads(m["content"])]
            message = {"content": f"스크립트 기반 데모: Standard {estimates[0]['monthlyCUExact']} CU/월, Batch {estimates[1]['monthlyCUExact']} CU/월입니다. 외부 서비스는 추가하지 않았고 통화 환산은 적용하지 않았습니다. 해당 버전의 은퇴일 경고를 확인하세요."}
        step += 1
        return {"choices": [{"message": message}]}

    return reply
