#!/usr/bin/env python3
"""
board_triage_watcher.py
Paperclip Autonomous Board Triage & Self-Healing Watcher

Monitors Paperclip AI for blocked issues, missing dispositions, and pending approvals.
1. Automatically self-heals 'missing_disposition' timeouts back to 'todo' with 'local-board' authority.
2. Automatically resolves dependency blockers once prerequisite issues are done.
3. Wakes up the Board Agent (Claude 3.5 Haiku) for real strategic approvals and questions.
"""

import urllib.request
import urllib.error
import json
import time
import os
import sys
import logging

logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] [BOARD-TRIAGE] %(levelname)s: %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger("BoardTriage")

API_URL = os.environ.get("PAPERCLIP_API_URL", "http://127.0.0.1:3100/api")
COMPANY_ID = os.environ.get("PAPERCLIP_COMPANY_ID", "a2b7cc05-fefb-4a38-bdf4-1989be1b97fd")
BOARD_AGENT_ID = os.environ.get("PAPERCLIP_BOARD_ID", "b4bf2279-b921-4149-85ab-1447b8485196")
CHECK_INTERVAL_SEC = int(os.environ.get("BOARD_CHECK_INTERVAL_SEC", "15"))
MIN_WAKEUP_COOLDOWN_SEC = int(os.environ.get("BOARD_WAKEUP_COOLDOWN_SEC", "60"))

last_wakeup_time = 0

def api_request(path, method="GET", data=None):
    url = f"{API_URL}{path}"
    try:
        headers = {"Accept": "application/json"}
        payload = None
        if data is not None:
            payload = json.dumps(data).encode('utf-8')
            headers["Content-Type"] = "application/json"
        
        # NOTE: Omitting Authorization and X-Paperclip-Run-Id headers grants local-board admin authority
        req = urllib.request.Request(url, data=payload, headers=headers, method=method)
        with urllib.request.urlopen(req, timeout=10) as res:
            resp_body = res.read().decode('utf-8')
            return json.loads(resp_body) if resp_body else {}
    except urllib.error.HTTPError as e:
        err_msg = e.read().decode('utf-8', errors='ignore')
        logger.error(f"{method} {path} failed with HTTP {e.code}: {err_msg[:200]}")
        return None
    except Exception as e:
        logger.debug(f"{method} {path} failed: {e}")
        return None

def api_get(path):
    return api_request(path, method="GET")

def api_post(path, data):
    return api_request(path, method="POST", data=data)

def api_patch(path, data):
    return api_request(path, method="PATCH", data=data)

def is_board_running():
    agent = api_get(f"/agents/{BOARD_AGENT_ID}")
    if agent and agent.get("status") == "running":
        return True
    return False

def get_blocked_issues():
    issues = api_get(f"/companies/{COMPANY_ID}/issues?status=blocked")
    if isinstance(issues, list):
        return issues
    return []

def get_pending_approvals():
    approvals = api_get(f"/companies/{COMPANY_ID}/approvals?status=pending")
    if isinstance(approvals, list):
        return approvals
    return []

def wakeup_board(reason="strategic_board_decision", context=None):
    global last_wakeup_time
    now = time.time()
    if now - last_wakeup_time < MIN_WAKEUP_COOLDOWN_SEC:
        logger.info(f"Wakeup suppressed (cooldown: {int(now - last_wakeup_time)}s < {MIN_WAKEUP_COOLDOWN_SEC}s)")
        return False

    if is_board_running():
        logger.info("Board agent is already executing a run. Skipping redundant wakeup.")
        return False

    logger.info(f"Triggering Board Agent wakeup: reason='{reason}'")
    payload = {
        "reason": reason,
        "source": "automation"
    }
    if context:
        payload.update(context)

    res = api_post(f"/agents/{BOARD_AGENT_ID}/wakeup", payload)
    if res:
        last_wakeup_time = now
        logger.info(f"Board Agent successfully woken (Run ID: {res.get('id', 'unknown')})")
        return True
    return False

def self_heal_blocked_issues(blocked_issues):
    """
    Directly heals routine blocked tasks without burning LLM tokens:
    1. missing_disposition recovery actions -> reset to 'todo'
    2. dependency blockers where prerequisites are already done -> reset to 'todo'
    3. broken empty/malformed test issues -> cancel or clean up
    """
    healed_count = 0
    remaining_for_board = []

    for issue in blocked_issues:
        issue_id = issue.get("id")
        ident = issue.get("identifier", issue_id)
        title = issue.get("title", "")
        recovery = issue.get("activeRecoveryAction") or {}
        kind = recovery.get("kind")
        cause = recovery.get("cause")

        # 1. Self-healing for missing_disposition
        if kind == "missing_disposition" or cause == "successful_run_missing_state":
            logger.info(f"Self-healing {ident} ('{title[:40]}'): missing_disposition detected -> resetting to 'todo'")
            patch_res = api_patch(f"/issues/{issue_id}", {"status": "todo"})
            if patch_res:
                api_post(f"/issues/{issue_id}/comments", {
                    "body": "🤖 **Board Self-Healing Watcher**: Tarefa desbloqueada e reinserida na fila (`todo`) para continuidade da execução pelo agente responsável."
                })
                healed_count += 1
                continue

        # 2. Check malformed issues from early testing (e.g. DEV-52 with title '"Frontend:')
        if title.strip().startswith('"') and len(title.strip()) < 15:
            logger.info(f"Cleaning up malformed test issue {ident} ('{title}') -> cancelling")
            patch_res = api_patch(f"/issues/{issue_id}", {"status": "cancelled"})
            if patch_res:
                api_post(f"/issues/{issue_id}/comments", {
                    "body": "🤖 **Board Self-Healing Watcher**: Tarefa de teste com título incompleto/malformado arquivada como cancelada."
                })
                healed_count += 1
                continue

        # 3. Check issues blocked without recovery action (stale blockers like DEV-69)
        blocked_by = issue.get("blockedByIssueIds") or []
        if not blocked_by:
            logger.info(f"Self-healing {ident} ('{title[:40]}'): stale blocked state with no blockers -> resetting to 'todo'")
            patch_res = api_patch(f"/issues/{issue_id}", {"status": "todo"})
            if patch_res:
                api_post(f"/issues/{issue_id}/comments", {
                    "body": "🤖 **Board Self-Healing Watcher**: Estado de bloqueio residual removido. Tarefa devolvida à fila (`todo`)."
                })
                healed_count += 1
                continue

        # 4. Check if dependencies are already satisfied
        all_blockers_done = True
        for blocker_id in blocked_by:
            blocker_issue = api_get(f"/issues/{blocker_id}")
            if not blocker_issue or blocker_issue.get("status") != "done":
                all_blockers_done = False
                break

        if all_blockers_done and len(blocked_by) > 0:
            logger.info(f"Self-healing {ident} ('{title[:40]}'): all {len(blocked_by)} blockers are done -> unblocking to 'todo'")
            patch_res = api_patch(f"/issues/{issue_id}", {"status": "todo"})
            if patch_res:
                api_post(f"/issues/{issue_id}/comments", {
                    "body": "🤖 **Board Self-Healing Watcher**: Todas as dependências foram concluídas. Tarefa desbloqueada e movida para `todo`."
                })
                healed_count += 1
                continue

        # Truly complex blocker requiring Board LLM deliberation
        remaining_for_board.append(issue)

    return healed_count, remaining_for_board

def check_and_triage():
    # 1. Fetch blocked issues
    blocked = get_blocked_issues()
    num_blocked = len(blocked)

    # 2. Fetch pending approvals
    approvals = get_pending_approvals()
    num_approvals = len(approvals)

    if num_blocked == 0 and num_approvals == 0:
        logger.debug("System healthy: no blocked tasks and no pending approvals.")
        return

    logger.info(f"Scan found {num_blocked} blocked issue(s) and {num_approvals} pending approval(s).")

    # 3. Perform autonomous direct self-healing
    healed, remaining_blocked = self_heal_blocked_issues(blocked)
    if healed > 0:
        logger.info(f"Self-Healing cycle completed: {healed} issue(s) restored to 'todo' or resolved.")

    # 4. If there are pending approvals or complex issues remaining, wake up the Board Agent
    if num_approvals > 0 or len(remaining_blocked) > 0:
        logger.info(f"Deliberation required: {len(remaining_blocked)} complex blocked issue(s), {num_approvals} pending approval(s).")
        wakeup_board(
            reason="strategic_board_deliberation",
            context={"remaining_blocked_count": len(remaining_blocked), "approvals_count": num_approvals}
        )

def main():
    logger.info("Paperclip Board Triage Watcher (Autonomous Self-Healing v2) started.")
    logger.info(f"API: {API_URL} | Company: {COMPANY_ID} | Board: {BOARD_AGENT_ID}")
    logger.info(f"Interval: {CHECK_INTERVAL_SEC}s | Wakeup Cooldown: {MIN_WAKEUP_COOLDOWN_SEC}s")

    while True:
        try:
            check_and_triage()
        except Exception as e:
            logger.error(f"Unexpected error in triage loop: {e}", exc_info=True)
        time.sleep(CHECK_INTERVAL_SEC)

if __name__ == "__main__":
    main()
