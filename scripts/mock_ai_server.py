#!/usr/bin/env python3
"""Mock OpenAI-compatible /chat/completions server for verifying the
Site Settings 'Test connection' flow (responds with a fixed 'pong')."""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length)
        try:
            parsed = json.loads(body)
        except Exception:
            parsed = {}
        auth = self.headers.get('Authorization', '')
        if auth != 'Bearer sk-test-1234':
            resp = {'error': {'message': 'Incorrect API key provided'}}
            self._send(401, resp)
            return
        reply = 'pong'
        if parsed.get('messages') and 'AI BOT' in str(parsed['messages']):
            reply = 'The mock bot is fully aware of your workforce data.'
        self._send(200, {
            'id': 'chatcmpl-mock',
            'object': 'chat.completion',
            'model': parsed.get('model', 'mock-model'),
            'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': reply}, 'finish_reason': 'stop'}],
            'usage': {'prompt_tokens': 10, 'completion_tokens': 1, 'total_tokens': 11},
        })

    def _send(self, code, obj):
        payload = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


if __name__ == '__main__':
    HTTPServer(('127.0.0.1', 3456), Handler).serve_forever()
