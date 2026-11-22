"""CertTrack drop flow against a SCRATCH database, inside a tenant backend container.

Runs the REAL router (app.routers.certtrack) and the real support-signal handlers
in-process, as an administrator of a scratch shelf, on a throwaway SQLite file. Nothing
is written to the tenant's own database and no ticket leaves the process: the ticket
filer is replaced by a recorder so the test can read what WOULD be sent.

Input: SYNTHETIC people only (the __DATA__ blob, from prismml-demo/gen_certs.py output).
Output: one JSON object on the last line. Counts and header names only.
"""
import asyncio
import csv
import io
import json
import os
import shutil
import sys
import tempfile
import types

SCRATCH = tempfile.mkdtemp(prefix="validate-scratch-")
os.environ["GARGBOT_DB_PATH"] = os.path.join(SCRATCH, "scratch.db")
os.environ["TENANT_ID"] = "tnt_validate_scratch"
sys.path.insert(0, "/app/backend")

DATA = json.loads(r'''__DATA__''')


def xlsx(rows, title="Sheet1"):
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = title
    for r in rows:
        ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def csv_bytes(rows):
    buf = io.StringIO()
    csv.writer(buf).writerows(rows)
    return buf.getvalue().encode("utf-8")


def build_files():
    emp = DATA["employees"]
    files = DATA["files"]
    lic_kinds = {"RN", "MD", "DEA", "CPT"}
    # Odd header names on purpose: nothing says "name", "certification" or "expires".
    clean = os.environ.get("VARIANT") == "clean"
    if clean:   # one row per person + certification: no renewals, no planted duplicates
        seen, kept = set(), []
        for f in files:
            key = (f["employee"], f["cert"])
            if key in seen or not f["number"] or not f["expires"]:
                continue
            seen.add(key)
            kept.append(f)
        numbers = set()
        files = [f for f in kept if not (f["number"] in numbers or numbers.add(f["number"]))]
    head = ["Employee Name", "Title", "Office"] if clean else [
        "Staff Member (Last, First)", "Job Code", "Where They Sit"]
    roster = [head] + [[e["name"], e["role"], e["site"]] for e in emp]
    certs = [["Who", "Credential Held", "Ref #", "Good Thru"]] + [
        [f["employee"], f["cert"], f["number"], f["expires"] or ""]
        for f in files if f["kind"] not in lic_kinds]
    lics = [["Licensee", "Board / Licence", "Lic. No.", "Renewal Due"]] + [
        [f["employee"], f["cert"], f["number"], f["expires"] or ""]
        for f in files if f["kind"] in lic_kinds]
    return {
        "staff-list-nov.xlsx": xlsx(roster, "People"),
        "credentials tracker.csv": csv_bytes(certs),
        "state-licences.xlsx": xlsx(lics, "Licences"),
    }, {"roster_rows": len(roster) - 1, "cert_rows": len(certs) - 1, "licence_rows": len(lics) - 1}


def sheet_facts(body):
    from openpyxl import load_workbook
    wb = load_workbook(io.BytesIO(body), read_only=True)
    out = []
    for ws in wb.worksheets:
        rows = list(ws.iter_rows(values_only=True))
        out.append({"sheet": ws.title, "rows": max(0, len(rows) - 1),
                    "headers": [str(c) for c in (rows[0] if rows else []) if c is not None]})
    return out


async def main():
    from fastapi import FastAPI
    import httpx
    from app import auth, database, support_signal
    from app.routers import certtrack, device_reports as dr

    await database.init_db()
    tickets = []

    async def fake_ticket(ticket, tenant_id, user_id):
        tickets.append({"tenant": tenant_id, "ticket": ticket})
        return "TCK-VALIDATE-1", "", True

    dr.file_support_ticket = fake_ticket
    for name in ("raise_owner_card", "notify_signature_seen"):
        if hasattr(dr, name):
            async def _quiet(*a, **k):
                return ("", "") if name == "raise_owner_card" else ""
            setattr(dr, name, _quiet)

    app = FastAPI()
    admin = types.SimpleNamespace(user_id="validate-admin", role="admin",
                                  display_name="Validation run", home_tenant_id="")

    @app.middleware("http")
    async def as_admin(request, call_next):
        request.state.user = admin
        return await call_next(request)

    app.include_router(certtrack.router)
    support_signal.install(app)
    out = {"tenant": auth._APP_TENANT, "db": "scratch sqlite", "steps": {}}
    files, sizes = build_files()
    out["input"] = sizes
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://scratch") as c:
        r = await c.get("/api/certtrack/drop")
        out["steps"]["status_before"] = {"http": r.status_code,
                                         "keys": sorted(r.json().keys()) if r.status_code == 200 else []}

        def parts(d):
            return [("files", (n, b, "application/octet-stream")) for n, b in d.items()]

        r = await c.post("/api/certtrack/drop", files=parts(files))
        body = r.json() if r.status_code == 200 else {}
        got = body.get("files", [])
        out["steps"]["three_file_drop"] = {
            "http": r.status_code,
            "files": [{"file": f.get("file"), "kind": f.get("kind"), "text": f.get("text"),
                       "ask": (f.get("ask") or {}).get("type")} for f in got]}
        # Answer any confirm the drop asked for (an employee list that changes who is listed).
        confirm = {f["file"]: f["ask"]["digest"] for f in got
                   if (f.get("ask") or {}).get("type") == "confirm"}
        if confirm:
            r = await c.post("/api/certtrack/drop", files=parts({n: files[n] for n in confirm}),
                             data={"confirm": json.dumps(confirm)})
            out["steps"]["three_file_drop_confirmed"] = {
                "http": r.status_code,
                "files": [{"file": f.get("file"), "kind": f.get("kind"), "text": f.get("text"),
                           "ask": (f.get("ask") or {}).get("type")} for f in r.json().get("files", [])]}

        r = await c.get("/api/certtrack/audit-sheet.xlsx")
        export = r.content
        out["steps"]["download_audit"] = {
            "http": r.status_code, "bytes": len(export),
            "content_type": r.headers.get("content-type"),
            "disposition": r.headers.get("content-disposition"),
            "sheets": sheet_facts(export) if r.status_code == 200 else []}
        r = await c.get("/api/certtrack/audit-sheet.csv")
        out["steps"]["download_csv"] = {"http": r.status_code,
                                        "lines": len(r.content.decode("utf-8-sig").splitlines())}

        # The export, edited by nobody, dropped back: one confirm question, then accepted.
        again = {"audit-export-redropped.xlsx": export}
        r = await c.post("/api/certtrack/drop", files=parts(again))
        f0 = (r.json().get("files") or [{}])[0] if r.status_code == 200 else {}
        ask = f0.get("ask") or {}
        out["steps"]["redrop_export"] = {"http": r.status_code, "kind": f0.get("kind"),
                                         "text": f0.get("text"), "ask": ask.get("type"),
                                         "question": ask.get("question")}
        if ask.get("type") == "confirm":
            r = await c.post("/api/certtrack/drop", files=parts(again),
                             data={"confirm": json.dumps({"audit-export-redropped.xlsx": ask["digest"]})})
            f1 = (r.json().get("files") or [{}])[0] if r.status_code == 200 else {}
            out["steps"]["redrop_export_confirmed"] = {
                "http": r.status_code, "kind": f1.get("kind"), "text": f1.get("text"),
                "ask": (f1.get("ask") or {}).get("type")}

        # A deliberately bad upload: no column names a person. Twice, to prove ONE ticket.
        # Realistic and still wrong: certification columns, dates under them, no name column.
        bad = xlsx([["Certification", "Issuer", "Expiry Date"],
                    ["teal widget licence", "amber board", "2027-03-01"],
                    ["Tuesday permit", "Friday council", "2026-12-15"],
                    ["teal widget licence", "amber board", "2028-01-31"]])
        seen = []
        for _ in range(2):
            r = await c.post("/api/certtrack/import",
                             files={"file": ("not-a-tracker.xlsx", bad, "application/octet-stream")})
            seen.append({"http": r.status_code,
                         "detail": (r.json().get("detail") if r.headers.get("content-type", "").startswith("application/json") else "")})
        await asyncio.sleep(1.0)
        payload = json.dumps(tickets)
        out["steps"]["bad_upload"] = {
            "responses": seen, "tickets_filed": len(tickets),
            "ticket_tenant": tickets[0]["tenant"] if tickets else "",
            "ticket_text": (tickets[0]["ticket"] if tickets else None),
            "has_header_row": all(h in payload for h in ("Certification", "Issuer", "Expiry Date")),
            "leaks_a_data_cell": any(v in payload for v in ("teal", "amber", "Tuesday", "Friday", "2027-03-01")),
        }
    print("RESULT " + json.dumps(out, default=str))


try:
    asyncio.run(main())
finally:
    shutil.rmtree(SCRATCH, ignore_errors=True)
