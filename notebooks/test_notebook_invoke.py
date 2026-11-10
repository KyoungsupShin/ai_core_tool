"""Exercise the actual invoke-level functions defined in the notebook cells."""
import ast
import json
import unittest
from pathlib import Path

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.runnables import RunnableLambda
from langchain_core.tools import StructuredTool

from lab_support import NodeTools, SYSTEM_PROMPT, ToolCallError


class NotebookInvokeTests(unittest.TestCase):
    def setUp(self):
        root = Path(__file__).resolve().parents[1]
        notebook = json.loads((root / 'notebooks/01_ai_core_tool_lab.ipynb').read_text(encoding='utf-8'))
        namespace = dict(json=json, tools=NodeTools(), SYSTEM_PROMPT=SYSTEM_PROMPT,
                         AIMessage=AIMessage, HumanMessage=HumanMessage, SystemMessage=SystemMessage,
                         ToolMessage=ToolMessage, ToolCallError=ToolCallError, StructuredTool=StructuredTool)
        functions = []
        for cell in notebook['cells']:
            if cell['cell_type'] != 'code':
                continue
            tree = ast.parse(''.join(cell['source']))
            functions.extend(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in {'make_langchain_tool', 'react_invoke'})
        self.assertEqual(len(functions), 2)
        exec(compile(ast.Module(body=functions, type_ignores=[]), '<notebook-functions>', 'exec'), namespace)
        namespace['tool_map'] = {t.name: t for t in map(namespace['make_langchain_tool'], namespace['tools'].definitions)}
        self.run_react = namespace['react_invoke']
        self.example = json.loads((root / 'examples/estimate.json').read_text())

    def test_actual_invoke_loop_repairs_tool_errors_and_observes_results(self):
        answers = iter([
            AIMessage(content='', tool_calls=[{'name': 'estimate_ai_core_cost', 'args': {'unexpected': True}, 'id': 'invalid'}, {'name': 'missing_tool', 'args': {}, 'id': 'unknown'}]),
            AIMessage(content='', tool_calls=[{'name': 'estimate_ai_core_cost', 'args': self.example, 'id': 'fixed'}]),
            AIMessage(content='19.3240775 CU/월입니다.'),
        ])
        seen = []
        def invoke(messages):
            seen.append(list(messages))
            return next(answers)
        result = self.run_react(RunnableLambda(invoke), '견적 계산')
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(result['observations'][0]['result']['error']['code'], 'INVALID_ARGUMENT')
        self.assertEqual(result['observations'][1]['result']['error']['code'], 'UNKNOWN_TOOL')
        self.assertEqual(result['observations'][2]['result']['monthlyCUExact'], '19.3240775')
        self.assertIsInstance(seen[1][-1], ToolMessage)
        self.assertEqual(seen[1][-1].tool_call_id, 'unknown')
        self.assertEqual(json.loads(seen[2][-1].content)['monthlyCUExact'], '19.3240775')

    def test_actual_invoke_loop_respects_budgets_and_clarifications(self):
        model = RunnableLambda(lambda _: AIMessage(content='', tool_calls=[{'name': 'list_models', 'args': {}, 'id': 'first'}, {'name': 'list_models', 'args': {}, 'id': 'second'}]))
        result = self.run_react(model, 'quote', max_tool_calls=1)
        self.assertEqual(result['status'], 'limit_reached')
        self.assertEqual(result['observations'], [])
        model = RunnableLambda(lambda _: AIMessage(content='월 사용량을 알려주세요.'))
        result = self.run_react(model, 'quote')
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(result['observations'], [])

    def test_actual_invoke_loop_handles_malformed_json_calls(self):
        answers = iter([AIMessage(content='', invalid_tool_calls=[{'name': 'list_models', 'args': '{', 'id': 'bad'}]), AIMessage(content='입력을 확인하세요.')])
        result = self.run_react(RunnableLambda(lambda _: next(answers)), 'quote')
        self.assertEqual(result['observations'][0]['result']['error']['code'], 'INVALID_ARGUMENT')


if __name__ == '__main__':
    unittest.main()
