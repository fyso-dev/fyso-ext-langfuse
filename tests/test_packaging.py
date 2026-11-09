"""Run the real Copier consumer: owned slots only, no questions and tag-to-tag upgrades."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
COPIER = ['uvx', '--from', 'copier==9.19.1', 'copier']
SLOTS = [
    '.copier-answers.ext-langfuse.yml',
    '.config/mise/conf.d/ext-langfuse.toml',
    'extensions/langfuse/app.yaml',
    'extensions/langfuse/doctor.sh',
    'extensions/langfuse/langfuse.cjs',
    'extensions/langfuse/secrets.yaml',
    'project/workflows/ext-langfuse-sync.yaml',
]


def run(args, cwd=None):
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=120)


class Packaging(unittest.TestCase):
    def setUp(self):
        if not shutil.which('uvx'):
            self.skipTest('uvx is required for the pinned Copier consumer')

    def test_installs_only_owned_slots_and_preserves_project_files(self):
        with tempfile.TemporaryDirectory(prefix='langfuse-install-') as temporary:
            project = Path(temporary)
            (project / 'README.md').write_text('Project-owned documentation\n')
            result = run(COPIER + ['copy', '--trust', '--defaults', str(ROOT), str(project)])
            self.assertEqual(result.returncode, 0, result.stderr)
            files = sorted(str(p.relative_to(project)) for p in project.rglob('*') if p.is_file())
            self.assertEqual(files, sorted(SLOTS + ['README.md']))
            self.assertEqual((project / 'README.md').read_text(), 'Project-owned documentation\n')
            conf = (project / '.config/mise/conf.d/ext-langfuse.toml').read_text()
            self.assertNotIn('[env]', conf, 'configuration lives in secrets, not in the slot')
            secrets = (project / 'extensions/langfuse/secrets.yaml').read_text()
            for name in ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_BASE_URL']:
                self.assertIn(f'name: {name}', secrets)

    def test_asks_no_questions(self):
        with tempfile.TemporaryDirectory(prefix='langfuse-questions-') as temporary:
            # Without --defaults, any question would fail on the closed stdin.
            result = subprocess.run(COPIER + ['copy', '--trust', str(ROOT), temporary], stdin=subprocess.DEVNULL,
                                    capture_output=True, text=True, timeout=120)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_native_tagged_upgrade(self):
        with tempfile.TemporaryDirectory(prefix='langfuse-upgrade-') as temporary:
            base = Path(temporary)
            source, project = base / 'source', base / 'project'
            shutil.copytree(ROOT, source, ignore=shutil.ignore_patterns('.git', '.data', '__pycache__', 'node_modules'))

            def ok(args, cwd):
                result = run(args, cwd)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

            def commit(directory):
                ok(['git', 'add', '.'], directory)
                ok(['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], directory)

            ok(['git', 'init', '-q'], source)
            commit(source)
            ok(['git', 'tag', 'v0.1.0'], source)
            ok(COPIER + ['copy', '--trust', '--defaults', '--vcs-ref', 'v0.1.0', str(source), str(project)], base)
            ok(['git', 'init', '-q'], project)
            commit(project)
            workflow = source / 'project/workflows/ext-langfuse-sync.yaml'
            updated = workflow.read_text().replace('*/5 * * * *', '*/10 * * * *')
            workflow.write_text(updated)
            commit(source)
            ok(['git', 'tag', 'v0.1.1'], source)
            ok(COPIER + ['update', '--trust', '--defaults', '--answers-file', '.copier-answers.ext-langfuse.yml', '--vcs-ref', 'v0.1.1'], project)
            self.assertEqual((project / 'project/workflows/ext-langfuse-sync.yaml').read_text(), updated)
            self.assertIn('_commit: v0.1.1', (project / '.copier-answers.ext-langfuse.yml').read_text())


if __name__ == '__main__':
    unittest.main()
