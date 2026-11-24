"""Adapter for the proven pricing engine kept at the repository root."""
import json
import shutil
import subprocess
from pathlib import Path

from django.conf import settings

PROJECT_ROOT = settings.BASE_DIR.parent
CLI = PROJECT_ROOT / 'src' / 'cli.mjs'


class EngineError(Exception):
    def __init__(self, status, payload):
        self.status = status
        self.payload = payload
        super().__init__(payload.get('message', 'Pricing engine failed.'))


def call_tool(name, arguments=None):
    node = shutil.which('node')
    if not node:
        raise EngineError(503, {'code': 'NODE_UNAVAILABLE', 'message': 'Node.js 20+ is required by the pricing engine.'})
    request = json.dumps({'name': name, 'arguments': arguments or {}}, ensure_ascii=False)
    try:
        result = subprocess.run(
            [node, str(CLI), '--call'], input=request, text=True, encoding='utf-8',
            capture_output=True, cwd=PROJECT_ROOT, timeout=30, check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise EngineError(504, {'code': 'ENGINE_TIMEOUT', 'message': 'The pricing calculation timed out.'}) from error
    if result.returncode:
        try:
            payload = json.loads(result.stderr).get('error', {})
        except json.JSONDecodeError:
            payload = {}
        raise EngineError(400, {
            'code': payload.get('code', 'ENGINE_ERROR'),
            'message': payload.get('message', 'The pricing engine rejected this request.'),
            **({'details': payload['details']} if 'details' in payload else {}),
        })
    return json.loads(result.stdout)
