#!/usr/bin/env python3
"""Distinguish old vs NEW update_employee on the live Supabase project DB.

Probe: p_employee = a jsonb STRING whose text is NOT valid JSON ("not-json-at-all").
- NEW body: the DECLARE-section unwrap casts it to jsonb -> json parse error (22P02)
            BEFORE the body's access check.
- OLD body: no declare-time unwrap -> body runs -> access check first -> 'Access denied'.

So: json parse error => migration live; 'Access denied' => migration NOT live."""
import json, urllib.request, sys

env = {}
with open("/home/z/my-project/.env.local") as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()

url = env["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/")
key = env["SUPABASE_SERVICE_ROLE_KEY"]

def rpc(fn, payload):
    req = urllib.request.Request(
        f"{url}/rest/v1/rpc/{fn}",
        data=json.dumps(payload).encode(),
        headers={"apikey": key, "Authorization": f"Bearer {key}",
                 "Content-Type": "application/json"},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, r.read().decode()[:300]
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]

# zero-uuid: even if somehow the body ran, the employee lookup would not match anything real
status, resp = rpc("update_employee", {
    "p_id": "00000000-0000-0000-0000-000000000000",
    "p_employee": "not-json-at-all"})
print("probe update_employee(invalid json string):", status, resp)

low = resp.lower()
if "invalid input syntax" in low and "json" in low:
    print("VERDICT: NEW function body is LIVE on the project DB — migration applied ✔")
elif "access denied" in low:
    print("VERDICT: OLD function body still on the project DB — migration NOT applied ✘")
    sys.exit(2)
else:
    print("VERDICT: UNCERTAIN")
    sys.exit(3)
