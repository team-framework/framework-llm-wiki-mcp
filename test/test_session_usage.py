import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'report-session-usage.py'
spec = importlib.util.spec_from_file_location('session_usage', SCRIPT)
usage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(usage)


def event(total_input=1000, cached=900, output=100, reasoning=40, last_input=1000):
    return {'type': 'event_msg', 'timestamp': '2026-09-29T12:00:00Z', 'payload': {
        'type': 'token_count', 'info': {'total_token_usage': {
            'input_tokens': total_input, 'cached_input_tokens': cached, 'cache_write_input_tokens': 0,
            'output_tokens': output, 'reasoning_output_tokens': reasoning, 'total_tokens': total_input + output},
            'last_token_usage': {'input_tokens': last_input}}}}


def write_rollout(filename, identity, parent=None, model='gpt-6-astra', events=None, copied_meta=False):
    lines = [{'type': 'session_meta', 'payload': {'id': identity, 'parent_thread_id': parent}},
             {'type': 'turn_context', 'payload': {'model': model}},
             {'type': 'response_item', 'payload': {'content': 'PRIVATE_QUERY_DO_NOT_EXPORT'}}]
    if copied_meta:
        lines.append({'type': 'session_meta', 'payload': {'id': parent}})
    lines.extend(events if events is not None else [event(), event(), event()])
    filename.write_text(''.join(json.dumps(line) + '\n' for line in lines))


class SessionUsageTests(unittest.TestCase):
    def test_cumulative_once_reasoning_subset_and_descendant_selection(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root, child, unrelated = (base / name for name in ['private-root.jsonl', 'private-child.jsonl', 'unrelated.jsonl'])
            write_rollout(root, 'PRIVATE_ROOT_ID')
            write_rollout(child, 'PRIVATE_CHILD_ID', 'PRIVATE_ROOT_ID', 'gpt-6-sol',
                          [event(500, 400, 50, 20, 500)] * 2, copied_meta=True)
            write_rollout(unrelated, 'PRIVATE_UNRELATED_ID')
            selected, root = usage.select_files(base, None, root)
            self.assertEqual(len(selected), 2)
            report = usage.build_report(selected, root, 'first_metadata_descendant_graph')
            self.assertEqual(report['usage']['total_tokens'], 1650)
            self.assertEqual(report['usage']['uncached_input_plus_output_tokens'], 350)
            self.assertEqual(report['usage']['reasoning_output_tokens'], 60)
            self.assertEqual(report['observations']['distinct_cumulative_updates'], 2)
            self.assertAlmostEqual(report['api_equivalent_estimate']['standard_usd'], .00768)
            self.assertAlmostEqual(report['api_equivalent_estimate']['fast_usd'], .01536)
            public = json.dumps(report)
            self.assertNotIn('PRIVATE_', public)
            self.assertNotIn(str(base), public)

    def test_explicit_duplicate_paths_are_not_counted_twice(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'root.jsonl'
            write_rollout(root, 'PRIVATE_ROOT_ID')
            link = Path(directory) / 'linked.jsonl'
            link.symlink_to(root)
            selected, _ = usage.select_files(None, [root, root, link], root)
            self.assertEqual(selected, [root.resolve()])

    def test_incomplete_tail_is_visible_and_long_context_is_not_short_priced(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'root.jsonl'
            write_rollout(root, 'PRIVATE_ROOT_ID', events=[event(last_input=272001)])
            with root.open('ab') as file:
                file.write(b'{"PRIVATE_PARTIAL_INPUT":')
            report = usage.build_report([root], root, 'explicit_files')
            self.assertEqual(report['observations']['incomplete_tail_lines'], 1)
            self.assertFalse(report['observations']['all_observed_requests_within_short_context'])
            self.assertIsNone(report['api_equivalent_estimate']['standard_usd'])

    def test_cli_refuses_unsupported_model_without_leaking_private_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'PRIVATE_FILENAME.jsonl'
            output = Path(directory) / 'report.json'
            write_rollout(root, 'PRIVATE_ROOT_ID', model='PRIVATE_MODEL_NAME')
            result = subprocess.run([sys.executable, str(SCRIPT), '--files', str(root), '--root-file', str(root),
                                     '--output', str(output)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn('PRIVATE_', result.stdout + result.stderr)
            self.assertFalse(output.exists())

    def test_cli_never_overwrites_a_source_hardlink(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'root.jsonl'
            output = Path(directory) / 'report.json'
            write_rollout(root, 'PRIVATE_ROOT_ID')
            original = root.read_bytes()
            os.link(root, output)
            result = subprocess.run([sys.executable, str(SCRIPT), '--files', str(root), '--root-file', str(root),
                                     '--output', str(output)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(root.read_bytes(), original)

    def test_malformed_structure_reports_no_private_traceback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'PRIVATE_FILENAME.jsonl'
            output = Path(directory) / 'report.json'
            root.write_text('["PRIVATE_MESSAGE"]\n')
            result = subprocess.run([sys.executable, str(SCRIPT), '--files', str(root), '--root-file', str(root),
                                     '--output', str(output)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn('PRIVATE_', result.stdout + result.stderr)
            self.assertNotIn('Traceback', result.stderr)
            self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
