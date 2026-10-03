"""Tests for PR previews: scripts/preview-url.sh, scripts/delete-preview.sh,
the [previews] block in wrangler.toml and the two workflows that use them.
Run: python3 -m unittest discover -s scripts"""

import re
import subprocess
import tempfile
import tomllib
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEPLOY = ROOT / ".github/workflows/deploy.yml"
CLEANUP = ROOT / ".github/workflows/pr-preview-cleanup.yml"


def run(args, env=None):
    return subprocess.run(args, cwd=ROOT, env=env, capture_output=True, text=True)


def steps(path):
    """(name, text) of each step in a workflow: from its `- ` line to the next
    step or the end of its job."""
    found, current = [], None
    for line in path.read_text().splitlines():
        if re.match(r"^ {6}- ", line):
            current = [line]
            found.append(current)
        elif current is not None and line.strip() and not line.startswith(" " * 8):
            current = None
        elif current is not None:
            current.append(line)
    named = []
    for lines in found:
        text = "\n".join(lines)
        name = re.search(r"^ {6}[- ] name: (.+)$", text, re.M)
        named.append((name.group(1) if name else "", text))
    return named


# What `wrangler preview --json` prints: asset-upload progress, then the JSON.
PREVIEW_OUTPUT = """\U0001f300 Building list of assets...
✨ Read 52 files from the assets directory /home/runner/work/xyz/xyz/dist
\U0001f300 Starting asset upload...
No updated asset files to upload. Proceeding with deployment...
{
  "preview": {
    "id": "6af3c6b70bae4da09af62508998cab4e",
    "name": "pr-7",
    "urls": [
      "https://pr-7-xyz.akan72.workers.dev"
    ]
  },
  "deployment": {
    "id": "e7999ec3-8f16-4d76-99cb-4c9d69c10c4b",
    "urls": [
      "https://e7999ec3-xyz.akan72.workers.dev"
    ]
  }
}
"""


class PreviewUrlTests(unittest.TestCase):
    def preview_url(self, output):
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / "preview.log"
            log.write_text(output)
            return run(["sh", "scripts/preview-url.sh", str(log)])

    def test_reads_the_preview_url_after_the_progress_lines(self):
        result = self.preview_url(PREVIEW_OUTPUT)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "https://pr-7-xyz.akan72.workers.dev\n")
        self.assertEqual(result.stderr, "")

    def test_fails_on_stderr_when_there_is_no_preview_url(self):
        # stderr, because the workflow captures stdout as the URL
        result = self.preview_url("✘ [ERROR] Authentication error [code: 10000]\n")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertIn("didn't report a preview URL", result.stderr)
        self.assertIn("Authentication error", result.stderr)

    def test_says_preview_urls_are_off_when_the_preview_has_no_url(self):
        no_urls = '{\n  "preview": { "name": "pr-7", "urls": [] },\n  "deployment": { "urls": [] }\n}\n'
        result = self.preview_url(no_urls)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertIn("Preview URLs are off", result.stderr)

    def test_never_shows_an_email_address(self):
        # The deployment record names the email of the account that owns the token
        leaky = '✘ [ERROR] something broke\n{ "deployment": { "author_email": "some.one+tag@example.co.uk" } }\n'
        result = self.preview_url(leaky)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn("example.co.uk", result.stderr)
        self.assertIn('"author_email": "<email hidden>"', result.stderr)
        self.assertIn("something broke", result.stderr)


DELETED = 'echo "Preview \\"pr-7\\" deleted successfully."; exit 0'
MISSING = 'echo "The Preview \\"pr-7\\" was not found."; exit 1'
AUTH_ERROR = 'echo "Authentication error [code: 10000]"; exit 1'


class DeletePreviewTests(unittest.TestCase):
    def delete_preview(self, answer, pr="7"):
        """Runs scripts/delete-preview.sh against a stand-in wrangler that
        prints its arguments, then runs `answer`."""
        with tempfile.TemporaryDirectory() as tmp:
            wrangler = Path(tmp) / "wrangler"
            wrangler.write_text(f'echo "args: $*"\n{answer}\n')
            outputs = Path(tmp) / "github-output"
            outputs.write_text("")
            env = {"PATH": "/usr/bin:/bin", "WRANGLER": f"sh {wrangler}", "GITHUB_OUTPUT": str(outputs)}
            result = run(["sh", "scripts/delete-preview.sh", pr], env=env)
            return result, outputs.read_text()

    def test_deletes_the_worker_preview_without_asking_and_runs_nothing_else(self):
        result, outputs = self.delete_preview(DELETED)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("deleted=true", outputs)
        calls = re.findall(r"^args: .*$", result.stdout, re.M)
        self.assertEqual(calls, ["args: preview delete --name pr-7 --skip-confirmation"])

    def test_treats_a_preview_that_never_existed_as_nothing_to_delete(self):
        result, outputs = self.delete_preview(MISSING)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("deleted=false", outputs)

    def test_fails_loudly_on_any_other_error_so_a_live_preview_never_reads_as_gone(self):
        result, outputs = self.delete_preview(AUTH_ERROR)
        self.assertEqual(result.returncode, 1)
        self.assertIn("may still be live", result.stdout + result.stderr)
        self.assertNotIn("deleted=", outputs)

    def test_refuses_anything_but_a_pr_number(self):
        # Without --name, `wrangler preview delete` picks the git branch's Preview
        for pr in ["", "7 --name main", "../7"]:
            result, outputs = self.delete_preview(DELETED, pr=pr)
            self.assertEqual(result.returncode, 1)
            self.assertNotIn("args:", result.stdout)
            self.assertEqual(outputs, "")


# Binding types a Worker Preview doesn't inherit from production
BINDING_KEYS = [
    "ai", "analytics_engine_datasets", "browser", "d1_databases", "durable_objects", "hyperdrive",
    "images", "kv_namespaces", "queues", "r2_buckets", "ratelimits", "secrets_store_secrets",
    "send_email", "services", "vars", "vectorize", "version_metadata", "workflows",
]


class WranglerConfigTests(unittest.TestCase):
    config = tomllib.loads((ROOT / "wrangler.toml").read_text())

    def test_names_the_one_worker_that_previews_belong_to(self):
        self.assertEqual(self.config["name"], "xyz")

    def test_turns_on_preview_urls_but_not_production_on_workers_dev(self):
        # A Worker Preview only gets a URL when the Worker has Preview URLs on;
        # with custom domains, both default to off
        self.assertIs(self.config["preview_urls"], True)
        self.assertIs(self.config["workers_dev"], False)

    def test_declares_every_binding_again_for_previews(self):
        previews = self.config.get("previews", {})
        self.assertEqual(previews.get("r2_buckets"), self.config["r2_buckets"])
        for key in BINDING_KEYS:
            if key in self.config:
                self.assertEqual(previews.get(key), self.config[key], f"[previews] is missing {key}")


class WorkflowTests(unittest.TestCase):
    def test_give_the_cloudflare_secrets_only_to_the_deploy_and_delete_steps(self):
        for path, allowed in [(DEPLOY, ["Deploy to production", "Deploy PR preview"]), (CLEANUP, ["Delete preview"])]:
            with_secrets = [name for name, text in steps(path) if "secrets." in text]
            self.assertEqual(with_secrets, allowed, path.name)
            self.assertEqual(path.read_text().count("secrets."), sum(t.count("secrets.") for _, t in steps(path)))

    def test_pr_previews_never_run_wrangler_deploy_or_print_the_preview_json(self):
        preview = dict(steps(DEPLOY))["Deploy PR preview"]
        self.assertIn("preview --name \"pr-${PR_NUMBER}\" --json >/tmp/preview.log", preview)
        self.assertNotRegex(preview, r"\bdeploy\b")
        # The JSON names the email of the account that owns the token; only
        # scripts/preview-url.sh reads it, and it hides every email address
        self.assertIn("sh scripts/preview-url.sh /tmp/preview.log", preview)
        script = preview.split("run: |", 1)[1]
        self.assertNotRegex(script, r"\b(cat|tee|jq|less|head|tail)\b")

    def test_only_the_production_step_runs_wrangler_deploy(self):
        deploys = [name for name, text in steps(DEPLOY) if re.search(r"wrangler\S*\s+deploy\b(?! --dry-run)", text)]
        self.assertEqual(deploys, ["Deploy to production"])
        production = dict(steps(DEPLOY))["Deploy to production"]
        self.assertIn("if: github.event_name == 'push'", production)

    def test_cleanup_deletes_through_the_script(self):
        self.assertIn('sh scripts/delete-preview.sh "${PR_NUMBER}"', dict(steps(CLEANUP))["Delete preview"])

    def test_pin_the_same_wrangler_version(self):
        versions = [re.search(r'WRANGLER_VERSION: "([^"]+)"', p.read_text()).group(1) for p in (DEPLOY, CLEANUP)]
        self.assertEqual(versions, ["4.143.1", "4.143.1"])

    def test_dont_leave_the_github_token_in_git_config(self):
        for path in (DEPLOY, CLEANUP):
            for name, text in steps(path):
                if "actions/checkout@" in text:
                    self.assertIn("persist-credentials: false", text, f"{path.name}: {name or text.splitlines()[0]}")

    def test_give_every_top_level_block_a_value(self):
        # GitHub rejects a workflow with an empty top-level block (say, `env:`
        # after its last variable is removed) and runs none of its jobs
        for path in (DEPLOY, CLEANUP):
            lines = path.read_text().splitlines()
            for i, line in enumerate(lines):
                if re.match(r"^[\w-]+:\s*$", line):
                    rest = [l for l in lines[i + 1 :] if l.strip() and not l.lstrip().startswith("#")]
                    self.assertTrue(rest and rest[0].startswith(" "), f"{path.name}: {line} is empty")


if __name__ == "__main__":
    unittest.main()
