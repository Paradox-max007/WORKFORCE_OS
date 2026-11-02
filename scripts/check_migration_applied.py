#!/usr/bin/env python3
"""Verify the 20261102b_jsonb_payload_tolerance migration is applied to the live Supabase DB,
by checking the RPC bodies for the double-encoded-string unwrap logic."""
import os, sys, json, urllib.request

# Load env from .env.local
env = {}
with open("/home/z/my-project/.env.local") as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()

url = env["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/")
key = env["SUPABASE_SERVICE_ROLE_KEY"]

def rpc(fn, payload=None):
    body = json.dumps(payload or {}).encode()
    req = urllib.request.Request(
        f"{url}/rest/v1/rpc/{fn}",
        data=body,
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read().decode() or "null")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:500]

# 1. Verify a jsonb payload sent as a STRING (the old double-encoded form) is now tolerated.
#    The app used to send {"p_employee": "{\"full_name\": null}"} (value pre-stringified).
#    If migration applied -> clear "full_name required" error; if not -> not-null violation.
status, body = rpc("create_employee", {"p_employee": json.dumps({"full_name": None, "code": "TEST-MIG-CHECK"})})
print("create_employee(null name via string payload):", status, str(body)[:400])

low = str(body).lower()
if "full_name" in low and ("required" in low or "cannot be empty" in low or "blank" in low):
    print("RESULT: MIGRATION APPLIED (clear validation error instead of not-null violation)")
elif "23502" in str(body) or "not-null" in low:
    print("RESULT: MIGRATION NOT APPLIED (still the raw not-null constraint error)")
elif status == 200:
    print("RESULT: UNEXPECTED SUCCESS — employee was created, check and clean up")
else:
    print("RESULT: UNCERTAIN — check output above")
