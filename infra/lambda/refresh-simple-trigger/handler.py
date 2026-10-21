"""
Lambda: dispatch the refresh-simple.yml GitHub Actions workflow.

EventBridge Scheduler invokes this every 10 minutes because GitHub's own
cron scheduler runs hours late for this repo (4-8 h late on the daily job,
measured 2026-10-21). The workflow itself still runs on GitHub Actions;
this function only replaces the trigger.

Environment:
  GITHUB_REPO       owner/name, e.g. nemac/landslides-ncgs
  WORKFLOW_FILE     e.g. refresh-simple.yml
  GIT_REF           branch to run on (default master)
  TOKEN_SECRET_ID   Secrets Manager secret holding a GitHub token with
                    Actions: read and write on the repo
"""

import json
import os
import urllib.error
import urllib.request

import boto3

_token_cache: str | None = None


def github_token() -> str:
    """Read the GitHub token from Secrets Manager once per container."""
    global _token_cache
    if _token_cache is None:
        client = boto3.client("secretsmanager")
        resp = client.get_secret_value(SecretId=os.environ["TOKEN_SECRET_ID"])
        _token_cache = resp["SecretString"].strip()
    return _token_cache


def dispatch_workflow(token: str, repo: str, workflow_file: str, ref: str) -> int:
    """POST a workflow_dispatch event. Returns the HTTP status (204 = queued)."""
    url = f"https://api.github.com/repos/{repo}/actions/workflows/{workflow_file}/dispatches"
    body = json.dumps({"ref": ref}).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "landslides-refresh-simple-trigger",
        "Content-Type": "application/json",
    })
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.status


def handler(event, context):
    repo = os.environ["GITHUB_REPO"]
    workflow_file = os.environ["WORKFLOW_FILE"]
    ref = os.environ.get("GIT_REF", "master")
    try:
        status = dispatch_workflow(github_token(), repo, workflow_file, ref)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        print(f"GitHub API error {e.code} dispatching {workflow_file}: {detail}")
        raise
    print(f"Dispatched {workflow_file} on {repo}@{ref}: HTTP {status}")
    return {"status": status, "workflow": workflow_file, "ref": ref}
