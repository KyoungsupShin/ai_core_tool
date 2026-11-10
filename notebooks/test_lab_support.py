"""Credential-free integration checks for the Python/Node bridge and tool loop."""
import json
import os
import subprocess
import sys
import tempfile
import types
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import Mock, patch

from lab_support import (
    DEMO_REQUEST, PROJECT_ROOT, NodeTools, Settings, ToolCallError,
    chat_completion, load_settings, make_demo_completion, run_agent,
)


def response(*calls, content=None):
    return {"choices": [{"message": {"content": content, "tool_calls": list(calls)}}]}


def tool_call(call_id, name, arguments):
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": arguments}}


class NotebookToolTests(unittest.TestCase):
    def setUp(self):
        self.tools = NodeTools()
        self.example = json.loads((PROJECT_ROOT / "examples/estimate.json").read_text())

    def test_python_bridge_uses_original_engine(self):
        self.assertTrue(self.tools.check_runtime()["node"].startswith("v"))
        result = self.tools.call("estimate_ai_core_cost", self.example)
        self.assertEqual(result["monthlyCUExact"], "19.3240775")
        invalid = deepcopy(self.example)
        invalid["foundationModels"][0]["usage"]["requestsPerMonth"] = -1
        with self.assertRaises(ToolCallError) as error:
            self.tools.call("estimate_ai_core_cost", invalid)
        self.assertEqual(error.exception.error["code"], "INVALID_ARGUMENT")

    def test_tool_definitions_match_runtime(self):
        current = json.loads(subprocess.run([self.tools.node, "src/cli.mjs", "--definitions"], cwd=PROJECT_ROOT, capture_output=True, text=True, check=True).stdout)
        self.assertEqual(self.tools.definitions, current)

    def test_demo_executes_real_tools_and_preserves_protocol(self):
        outcome = run_agent(DEMO_REQUEST, completion=make_demo_completion(), node_tools=self.tools)
        self.assertEqual(outcome["status"], "completed")
        estimates = [o["result"]["monthlyCUExact"] for o in outcome["observations"] if o["name"] == "estimate_ai_core_cost"]
        self.assertEqual(estimates, ["19.3240775", "9.66203875"])
        self.assertIn(estimates[0], outcome["answer"])
        pending = []
        for message in outcome["messages"]:
            if message.get("tool_calls"):
                self.assertEqual(pending, [])
                pending = [c["id"] for c in message["tool_calls"]]
            elif message["role"] == "tool":
                self.assertEqual(message["tool_call_id"], pending.pop(0))
            else:
                self.assertEqual(pending, [])
        self.assertEqual(pending, [])

    def test_bad_json_and_unknown_tools_are_returned_for_repair(self):
        replies = iter([
            response(tool_call("bad-json", "list_models", '{"bad":'), tool_call("bad-name", "execute_shell", "{}")),
            response(tool_call("fixed", "estimate_ai_core_cost", json.dumps(self.example))),
            response(content="계산이 완료되었습니다."),
        ])
        received = []
        def completion(**kwargs):
            received.append(kwargs["messages"])
            return next(replies)
        outcome = run_agent("Calculate a quote", completion=completion, node_tools=self.tools)
        self.assertEqual(outcome["status"], "completed")
        self.assertEqual(outcome["observations"][0]["result"]["error"]["code"], "INVALID_ARGUMENT")
        self.assertEqual(outcome["observations"][1]["result"]["error"]["code"], "UNKNOWN_TOOL")
        self.assertEqual(outcome["observations"][2]["result"]["monthlyCUExact"], "19.3240775")
        self.assertEqual(received[1][-2]["tool_call_id"], "bad-json")
        self.assertEqual(received[1][-1]["tool_call_id"], "bad-name")

    def test_node_schema_error_is_an_observation(self):
        replies = iter([response(tool_call("invalid", "estimate_ai_core_cost", '{"unexpected":true}')), response(content="입력을 확인하세요.")])
        result = run_agent("quote", completion=lambda **_: next(replies), node_tools=self.tools)
        self.assertEqual(result["observations"][0]["result"]["error"]["code"], "INVALID_ARGUMENT")

    def test_limits_stop_without_extra_inference(self):
        completion = Mock(return_value=response(tool_call("loop", "list_models", '{"query":"gpt-4.1"}')))
        result = run_agent("quote", completion=completion, node_tools=self.tools, max_rounds=1)
        self.assertEqual(result["status"], "limit_reached")
        self.assertEqual(completion.call_count, 1)
        self.assertEqual(len(result["observations"]), 1)
        excessive = Mock(return_value=response(tool_call("a", "list_models", "{}"), tool_call("b", "list_models", "{}")))
        result = run_agent("quote", completion=excessive, node_tools=self.tools, max_tool_calls=1)
        self.assertEqual(result["observations"], [])
        self.assertEqual(result["status"], "limit_reached")

    def test_clarification_without_tools(self):
        result = run_agent("견적 내줘", completion=lambda **_: response(content="모델과 월 요청 수를 알려주세요."), node_tools=self.tools)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["observations"], [])

    def test_invalid_json_numbers_and_duplicate_call_ids(self):
        replies = iter([response(tool_call("nonfinite", "list_models", '{"value":NaN}')), response(content="확인이 필요합니다.")])
        result = run_agent("quote", completion=lambda **_: next(replies), node_tools=self.tools)
        self.assertEqual(result["observations"][0]["result"]["error"]["code"], "INVALID_ARGUMENT")
        with self.assertRaisesRegex(RuntimeError, "invalid tool-call"):
            run_agent("quote", completion=lambda **_: response(tool_call("dup", "list_models", "{}"), tool_call("dup", "list_models", "{}")), node_tools=self.tools)


class ConfigurationTests(unittest.TestCase):
    def test_env_does_not_override_shell_or_expose_secrets(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"LLM_MODEL": "shell-model"}, clear=True):
            path = Path(directory) / ".env"
            path.write_text("LLM_MODEL=file-model\nAICORE_CLIENT_ID=test-id\nAICORE_CLIENT_SECRET=test-secret\n", encoding="utf-8")
            settings = load_settings(path)
            self.assertEqual(settings.llm_model, "shell-model")
            self.assertTrue(settings.readiness()["AICORE_CLIENT_SECRET"])
            self.assertNotIn("test-secret", repr(settings))
            self.assertNotIn("test-id", repr(settings))
            self.assertNotIn("test-secret", json.dumps(settings.readiness()))

    def test_missing_settings_fail_before_network(self):
        with self.assertRaisesRegex(RuntimeError, "Missing .env settings"):
            chat_completion(Settings(), messages=[], tools=[])

    def test_sap_native_sdk_request_and_redacted_errors(self):
        sdk = types.ModuleType("gen_ai_hub.proxy.native.openai")
        create = Mock(return_value=response(content="ok"))
        sdk.chat = types.SimpleNamespace(completions=types.SimpleNamespace(create=create))
        modules = {"gen_ai_hub.proxy.native.openai": sdk}
        for name in ["gen_ai_hub", "gen_ai_hub.proxy", "gen_ai_hub.proxy.native"]:
            modules[name] = types.ModuleType(name)
        settings = Settings(auth_url="https://auth.invalid", base_url="https://api.invalid", client_id="test-id", client_secret="test-secret", llm_model="test-model", deployment_id="test-deployment", llm_seed=42)
        with patch.dict(sys.modules, modules), patch.dict(os.environ, {}, clear=True):
            chat_completion(settings, messages=[{"role":"user","content":"quote"}], tools=[])
            kwargs = create.call_args.kwargs
            self.assertEqual(kwargs["model_name"], "test-model")
            self.assertEqual(kwargs["deployment_id"], "test-deployment")
            self.assertEqual(kwargs["seed"], 42)
            self.assertEqual(os.environ["AICORE_RESOURCE_GROUP"], "default")
            create.side_effect = RuntimeError("test-secret should never be in a notebook output")
            with self.assertRaises(RuntimeError) as error:
                chat_completion(settings, messages=[], tools=[])
            self.assertNotIn("test-secret", str(error.exception))

    def test_sdk_initialization_errors_are_redacted(self):
        sdk = types.ModuleType("gen_ai_hub.proxy.native.openai")
        def fail_lookup(name):
            raise RuntimeError("test-secret in SDK initialization")
        sdk.__getattr__ = fail_lookup
        modules = {"gen_ai_hub.proxy.native.openai": sdk}
        for name in ["gen_ai_hub", "gen_ai_hub.proxy", "gen_ai_hub.proxy.native"]:
            modules[name] = types.ModuleType(name)
        settings = Settings(auth_url="https://auth.invalid", base_url="https://api.invalid", client_id="test-id", client_secret="test-secret", llm_model="test-model")
        with patch.dict(sys.modules, modules), patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(RuntimeError) as error:
                chat_completion(settings, messages=[], tools=[])
            self.assertNotIn("test-secret", str(error.exception))
            self.assertIn("Gen AI Hub call failed", str(error.exception))


if __name__ == "__main__":
    unittest.main()
