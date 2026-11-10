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
Follow ReAct: assess the request and prior observations, choose a tool action when evidence is needed,
observe the tool result, and reassess until you can answer or ask for missing input.
Tool order is your decision; no fixed lookup or estimation sequence is required.
Before an action you may provide one short public decision summary, never private chain-of-thought.
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


def build_react_agent(
    *, completion: Callable[..., Any], node_tools: NodeTools | None = None,
    max_rounds: int = 8, max_tool_calls: int = 20,
) -> Any:
    """Compile Reason -> ToolNode -> Observe -> Reason with LangGraph."""
    from langchain_core.messages import AIMessage
    from langchain_core.tools import StructuredTool
    from langgraph.graph import END, START, MessagesState, StateGraph
    from langgraph.prebuilt import ToolNode

    if not 1 <= max_rounds <= 20 or not 1 <= max_tool_calls <= 100:
        raise ValueError("Use 1..20 rounds and 1..100 tool calls.")
    node_tools = node_tools or NodeTools()
    definitions = node_tools.definitions
    names = {item["function"]["name"] for item in definitions}

    class ReActState(MessagesState):
        wire_messages: list[dict[str, Any]]
        events: list[dict[str, Any]]
        observations: list[dict[str, Any]]
        pending: list[dict[str, Any]]
        round_number: int
        call_count: int
        status: str
        answer: str

    def make_tool(definition):
        function = definition["function"]
        def dispatch(**arguments):
            result = node_tools.call(function["name"], arguments)
            return json.dumps(result, ensure_ascii=False), result
        return StructuredTool.from_function(
            func=dispatch, name=function["name"], description=function["description"],
            args_schema=function["parameters"], response_format="content_and_artifact",
        )

    def rejected_arguments(error):
        result = {"error": error}
        return json.dumps(result), result

    error_tool = StructuredTool.from_function(
        func=rejected_arguments, name="_tool_error", description="Internal malformed-call observation.",
        args_schema={"type": "object", "properties": {"error": {"type": "object"}}, "required": ["error"]},
        response_format="content_and_artifact",
    )

    def tool_error(error: Exception) -> str:
        detail = error.error if isinstance(error, ToolCallError) else {"code": "TOOL_EXECUTION_ERROR", "message": "Local tool execution failed."}
        return json.dumps({"error": detail}, ensure_ascii=False)

    def reason(state):
        round_number = state["round_number"] + 1
        response = completion(messages=deepcopy(state["wire_messages"]), tools=deepcopy(definitions), tool_choice="auto")
        choices = _field(response, "choices", [])
        if not choices:
            raise RuntimeError("LLM response has no choices.")
        message = _field(choices[0], "message")
        calls = _field(message, "tool_calls", []) or []
        content = _field(message, "content") or ""
        event = {"event": "reason", "round": round_number, "selected_tools": [_field(_field(c, "function"), "name") for c in calls]}
        if calls and content:
            event["decision_summary"] = content
        events = [*state["events"], event]
        if not calls:
            if not isinstance(content, str) or not content.strip():
                raise RuntimeError("LLM response contains neither text nor tool calls.")
            events.append({"event": "final_answer", "round": round_number})
            return {"messages": [AIMessage(content=content)], "wire_messages": [*state["wire_messages"], {"role": "assistant", "content": content}],
                    "status": "completed", "answer": content, "round_number": round_number, "events": events}
        if state["call_count"] + len(calls) > max_tool_calls:
            return {"status": "limit_reached", "round_number": round_number, "events": events}
        normalized, graph_calls, pending = [], [], []
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
            arguments: Any = None
            try:
                arguments = json.loads(raw, parse_constant=_reject_nonfinite)
                if not isinstance(arguments, dict):
                    raise ValueError("Tool arguments must be an object.")
                if name not in names:
                    raise ToolCallError({"code": "UNKNOWN_TOOL", "message": "Select a tool from the supplied definitions."})
                graph_calls.append({"name": name, "args": arguments, "id": call_id, "type": "tool_call"})
            except (ValueError, TypeError):
                graph_calls.append({"name": "_tool_error", "args": {"error": {"code": "INVALID_ARGUMENT", "message": "Tool arguments must be a valid JSON object."}}, "id": call_id, "type": "tool_call"})
            except ToolCallError as error:
                graph_calls.append({"name": "_tool_error", "args": {"error": error.error}, "id": call_id, "type": "tool_call"})
            pending.append({"id": call_id, "name": name, "arguments": arguments})
        return {"messages": [AIMessage(content=content, tool_calls=graph_calls)], "pending": pending,
                "wire_messages": [*state["wire_messages"], {"role": "assistant", "content": content, "tool_calls": normalized}],
                "round_number": round_number, "events": events}

    def observe(state):
        results = {message.tool_call_id: message for message in state["messages"][-len(state["pending"]):]}
        events, observations, wire = list(state["events"]), list(state["observations"]), list(state["wire_messages"])
        for call in state["pending"]:
            message = results[call["id"]]
            result = message.artifact if message.artifact is not None else json.loads(message.content)
            events.append({"event": "act", "round": state["round_number"], "name": call["name"], "arguments": call["arguments"]})
            summary = {"error": result["error"]["code"]} if "error" in result else {key: result[key] for key in ("monthlyCUExact", "pricingModes") if key in result}
            if "models" in result:
                summary["modelsFound"] = len(result["models"])
            events.append({"event": "observe", "round": state["round_number"], "name": call["name"], "ok": "error" not in result, "summary": summary})
            observations.append({"name": call["name"], "arguments": call["arguments"], "result": result})
            wire.append({"role": "tool", "tool_call_id": call["id"], "content": json.dumps(result, ensure_ascii=False)})
        return {"events": events, "observations": observations, "wire_messages": wire, "call_count": state["call_count"] + len(state["pending"]), "pending": []}

    def limit(state):
        return {"status": "limit_reached", "answer": "호출 횟수 제한에 도달했습니다. 관찰된 Tool 결과를 확인하고 요청을 좁혀 다시 실행하세요.",
                "events": [*state["events"], {"event": "limit_reached", "toolCalls": state["call_count"]}]}

    graph = StateGraph(ReActState)
    graph.add_node("reason", reason)
    graph.add_node("act", ToolNode([*(make_tool(d) for d in definitions), error_tool], name="act", handle_tool_errors=tool_error))
    graph.add_node("observe", observe)
    graph.add_node("limit", limit)
    graph.add_edge(START, "reason")
    graph.add_conditional_edges("reason", lambda s: "done" if s["status"] == "completed" else "limit" if s["status"] == "limit_reached" else "act", {"done": END, "limit": "limit", "act": "act"})
    graph.add_edge("act", "observe")
    graph.add_conditional_edges("observe", lambda s: "limit" if s["round_number"] >= max_rounds else "reason", {"limit": "limit", "reason": "reason"})
    graph.add_edge("limit", END)
    return graph.compile(name="ai_core_react_agent")


def run_react_agent(
    request: str, *, completion: Callable[..., Any], node_tools: NodeTools | None = None,
    max_rounds: int = 8, max_tool_calls: int = 20,
) -> dict[str, Any]:
    if not isinstance(request, str) or not request.strip():
        raise ValueError("Enter a non-empty request.")
    graph = build_react_agent(completion=completion, node_tools=node_tools, max_rounds=max_rounds, max_tool_calls=max_tool_calls)
    wire = [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": request.strip()}]
    state = graph.invoke({"messages": wire, "wire_messages": wire, "events": [], "observations": [], "pending": [],
                          "round_number": 0, "call_count": 0, "status": "running", "answer": ""},
                         config={"recursion_limit": max_rounds * 3 + 3, "max_concurrency": 1})
    return {"architecture": "langgraph-react", "status": state["status"], "answer": state["answer"],
            "events": state["events"], "observations": state["observations"], "messages": state["wire_messages"]}


run_agent = run_react_agent


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
