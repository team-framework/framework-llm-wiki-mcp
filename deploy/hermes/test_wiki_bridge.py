"""Verify the Claude OAuth request's model, reasoning and recorded usage offline."""
import importlib.util
import os
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace as NS
import unittest
from unittest.mock import patch

class BridgeTests(unittest.TestCase):
    def test_max_default_explicit_reasoning_and_oauth_route(self):
        calls = []
        response = NS(stop_reason='end_turn', content=[NS(type='thinking'), NS(type='text', text='answer')], model='claude-opus-5-5',
                      usage=NS(service_tier='standard', model_dump=lambda: {'input_tokens': 3, 'output_tokens': 2}))
        class Client:
            def close(self): pass
        def build_kwargs(model, messages, tools, max_tokens, reasoning, **kwargs):
            calls.append({'model': model, 'messages': messages, 'tools': tools, 'reasoning': reasoning, **kwargs})
            return {}
        bootstrap = ModuleType('hermes_bootstrap')
        env_loader = ModuleType('hermes_cli.env_loader'); env_loader.load_hermes_dotenv = lambda: None
        adapter = ModuleType('agent.anthropic_adapter')
        adapter.build_anthropic_client = lambda *_args, **_kwargs: Client()
        adapter.build_anthropic_kwargs = build_kwargs
        adapter.create_anthropic_message = lambda *_args: response
        credentials = ModuleType('agent.anthropic_credentials')
        credentials.resolve_anthropic_token = lambda **_: 'fake'
        credentials.anthropic_route_is_oauth = lambda *_args, **_kwargs: True
        modules = {'hermes_bootstrap': bootstrap, 'hermes_cli.env_loader': env_loader,
                   'agent.anthropic_adapter': adapter, 'agent.anthropic_credentials': credentials}
        with patch.dict(sys.modules, modules), patch.dict(os.environ, {'HERMES_WIKI_KEY': 'x' * 40}):
            spec = importlib.util.spec_from_file_location('tested_wiki_bridge', Path(__file__).with_name('wiki_bridge.py'))
            module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
            with patch('builtins.print'):
                result = module.answer({'instructions': 'test', 'input': 'test'})
                module.answer({'instructions': 'test', 'input': 'test', 'reasoning': 'none'})
        self.assertEqual(calls[0]['model'], 'claude-opus-5-5')
        self.assertEqual(calls[0]['messages'][0], {'role': 'system', 'content': 'test'})
        self.assertIsNone(calls[0]['tools'])
        self.assertEqual(calls[0]['reasoning'], {'effort': 'max'})
        self.assertTrue(calls[0]['is_oauth'])
        self.assertEqual(calls[1]['reasoning'], {'enabled': False})
        self.assertEqual(result['answer'], 'answer')
        self.assertEqual(result['model'], 'claude-opus-5-5')
        self.assertEqual(result['service_tier'], 'standard')
        self.assertEqual(result['usage']['input_tokens'], 3)

if __name__ == '__main__': unittest.main()
