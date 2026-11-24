import json

from django.http import JsonResponse
from django.views.decorators.http import require_GET, require_POST

from .services import EngineError, call_tool


def error_response(error):
    return JsonResponse({'error': error.payload}, status=error.status)


def read_json(request):
    try:
        data = json.loads(request.body or '{}')
    except json.JSONDecodeError as error:
        raise EngineError(400, {'code': 'INVALID_JSON', 'message': 'Request body must be valid JSON.'}) from error
    if not isinstance(data, dict):
        raise EngineError(400, {'code': 'INVALID_ARGUMENT', 'message': 'Request body must be a JSON object.'})
    return data


@require_GET
def health(request):
    return JsonResponse({'status': 'ok'})


@require_GET
def models(request):
    arguments = {key: request.GET[key] for key in ('query', 'provider', 'mode') if key in request.GET}
    try:
        return JsonResponse(call_tool('list_models', arguments))
    except EngineError as error:
        return error_response(error)


@require_POST
def pricing(request):
    try:
        return JsonResponse(call_tool('get_model_pricing', read_json(request)))
    except EngineError as error:
        return error_response(error)


@require_GET
def compute_instances(request):
    arguments = {key: request.GET[key] for key in ('query', 'mode') if key in request.GET}
    try:
        return JsonResponse(call_tool('list_compute_instances', arguments))
    except EngineError as error:
        return error_response(error)


@require_POST
def estimate(request):
    try:
        return JsonResponse(call_tool('estimate_ai_core_cost', read_json(request)))
    except EngineError as error:
        return error_response(error)
