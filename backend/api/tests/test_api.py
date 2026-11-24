import json
from unittest.mock import patch

from django.test import TestCase


class ApiTests(TestCase):
    @patch('api.views.call_tool', return_value={'models': []})
    def test_models_forwards_filters(self, call_tool):
        response = self.client.get('/api/models/?query=gpt')
        self.assertEqual(response.status_code, 200)
        call_tool.assert_called_once_with('list_models', {'query': 'gpt'})

    @patch('api.views.call_tool', return_value={'monthlyCUExact': '1.25'})
    def test_estimate_forwards_json(self, call_tool):
        response = self.client.post('/api/estimates/', data=json.dumps({'foundationModels': []}), content_type='application/json')
        self.assertEqual(response.json()['monthlyCUExact'], '1.25')
        call_tool.assert_called_once_with('estimate_ai_core_cost', {'foundationModels': []})
