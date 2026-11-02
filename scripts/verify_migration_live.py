#!/usr/bin/env python3
"""Verify the 20261102b migration is live by calling create_employee as a REAL
admin user (super@pulse.dev), sending the double-encoded string payload that
used to trigger the not-null violation. Expect the clear 'Full name is required'
error (migration applied) vs raw 23502 not-null violation (not applied)."""
import json, urllib.request

env = {}
with open("/home/z/my-project/.env.local") as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()

url = env["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/")
anon = env["NEXT_PUBLIC_SUPABASE_ANON_KEY"]

# 1. Sign in as super admin
body = json.dumps({
    "email": "super@pulse.dev",
    "password": "pulse-super-2026",
    "gotrue_meta_security": {"hub": ""},
}).encode()
req = urllib.request.Request(
    f"{url}/auth/v1/token?grant_type=password",
    data=body, headers={"apikey": anon, "Content-Type": "application/json"}, method="POST")
with urllib.request.urlopen(req, timeout=15) as r:
    session = json.loads(r.read().decode())
token = session["access_token"]
print("signed in as:", session["user"]["email"])

def rpc(fn, payload):
    req = urllib.request.Request(
        f"{url}/rest/v1/rpc/{fn}",
        data=json.dumps(payload).encode(),
        headers={"apikey": anon, "Authorization": f"Bearer {token}",
                 "Content-Type": "application/json"},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read().decode() or "null")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:400]

# 2. Double-encoded string payload with missing full_name (the exact old-bug shape)
status, resp = rpc("create_employee", {"p_employee": json.dumps({"employee_code": "MIG-CHECK"})})
print("double-encoded, no full_name ->", status, resp)

low = str(resp).lower()
if "full name is required" in low:
    print("PASS: new function body is LIVE (unwrap + clear validation)")
elif "not-null" in low or "23502" in str(resp):
    print("FAIL: migration NOT applied to live DB")
else:
    print("UNCERTAIN:", resp)

# 3. Sanity: valid double-encoded payload with a name should ALSO work (unwrap path)
#    — use a throwaway ID; delete right after via delete RPC if created.
status2, resp2 = rpc("create_employee", {"p_employee": json.dumps({
    "employee_code": "MIG-CHECK-TEMP", "full_name": "Migration Check Temp",
    "position": "tester", "current_site_id": ""})})
print("double-encoded, valid ->", status2, str(resp2)[:200])
if status2 == 200 and isinstance(resp2, dict):
    emp_id = resp2.get("id")
    ds, dr = rpc("delete_employee", {"p_id": emp_id})
    print("cleanup delete_employee ->", ds, str(dr)[:120])
