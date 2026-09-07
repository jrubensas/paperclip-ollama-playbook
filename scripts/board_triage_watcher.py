#!/usr/bin/env python3
"""
board_triage_watcher.py
Paperclip Autonomous Board Triage & Self-Healing Watcher

Monitors Paperclip AI for blocked issues and pending interactions,
triggering the Board Agent (Claude 3.5 Haiku) to automatically resolve
blockers, guide agents, and unblock tasks.
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

def api_get(path):
    url = f"{API_URL}{path}"
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as res:
            return json.loads(res.read().decode('utf-8'))
    except Exception as e:
        logger.debug(f"GET {path} failed: {e}")
        return None

def api_post(path, data):
    url = f"{API_URL}{path}"
    try:
        payload = json.dumps(data).encode('utf-8')
        req = urllib.request.Request(
            url,
            data=payload,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=10) as res:
            return json.loads(res.read().decode('utf-8'))
    except Exception as e:
        logger.error(f"POST {path} failed: {e}")
        return None

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

def wakeup_board(reason="blocked_issue_triage", context=None):
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

def check_and_triage():
    # 1. Check blocked issues
    blocked = get_blocked_issues()
    num_blocked = len(blocked)
    
    # 2. Check pending approvals
    approvals = get_pending_approvals()
    num_approvals = len(approvals)

    if num_blocked > 0 or num_approvals > 0:
        logger.info(f"Found {num_blocked} blocked issue(s) and {num_approvals} pending approval(s).")
        identifiers = [i.get("identifier") for i in blocked[:5]]
        logger.info(f"Sample blocked tasks: {', '.join(identifiers)}")
        wakeup_board(
            reason="autonomous_triage_and_unblock",
            context={"blocked_count": num_blocked, "approvals_count": num_approvals}
        )
    else:
        logger.debug("No blocked tasks or pending approvals found.")

def main():
    logger.info(f"Paperclip Board Triage Watcher started.")
    logger.info(f"API: {API_URL} | Company: {COMPANY_ID} | Board: {BOARD_AGENT_ID}")
    logger.info(f"Interval: {CHECK_INTERVAL_SEC}s | Cooldown: {MIN_WAKEUP_COOLDOWN_SEC}s")

    while True:
        try:
            check_and_triage()
        except Exception as e:
            logger.error(f"Unexpected error in triage loop: {e}", exc_info=True)
        time.sleep(CHECK_INTERVAL_SEC)

if __name__ == "__main__":
    main()
