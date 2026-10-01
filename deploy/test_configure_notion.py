import importlib.util
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

spec = importlib.util.spec_from_file_location('configure_notion', Path(__file__).with_name('configure-notion.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ConfigureTests(unittest.TestCase):
    def test_preserves_existing_settings_and_replaces_token_with_private_permissions(self):
        with TemporaryDirectory() as tmp:
            target = Path(tmp) / '.env'
            target.write_text('# existing\nEXISTING=keep\nNOTION_TOKEN=old\n NOTION_TOKEN=duplicate\n')
            token = 'synthetic_' + 'x' * 30
            module.configure(target, token, 'a' * 32)
            contents = target.read_text()
            self.assertIn('# existing\nEXISTING=keep\n', contents)
            self.assertEqual(contents.count('NOTION_TOKEN='), 1)
            self.assertIn('NOTION_ROOT_PAGE_IDS=' + 'a' * 32, contents)
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            self.assertFalse(target.with_name('.env.notion-tmp').exists())

    def test_rejects_invalid_input_and_symlink_without_modifying_target(self):
        with TemporaryDirectory() as tmp:
            target = Path(tmp) / '.env'; target.write_text('EXISTING=keep\n')
            link = Path(tmp) / 'linked'; link.symlink_to(target)
            for path, token, root in [(target, 'short', 'a' * 32), (target, 'x' * 30, 'bad-root'), (link, 'x' * 30, 'a' * 32)]:
                with self.assertRaises(ValueError): module.configure(path, token, root)
            self.assertEqual(target.read_text(), 'EXISTING=keep\n')


if __name__ == '__main__':
    unittest.main()
