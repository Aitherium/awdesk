"""READ-ONLY CertTrack facts for the tenant this container serves. Counts and header
names only: no person, no certificate, no cell value is printed.

Builds the same workbook the "Download audit" button serves (cert_drop.audit_rows ->
cert_reconcile.to_xlsx) and opens it, without writing anything.
"""
import asyncio
import io
import json
import sys

sys.path.insert(0, "/app/backend")


async def main():
    from sqlalchemy import func, select
    from app import auth, database
    from app.models import CertEntryRecord, CertPersonRecord
    from app.services import cert_drop, cert_reconcile
    from openpyxl import load_workbook

    tenant = auth._APP_TENANT
    out = {"tenant": tenant}
    async with database.async_session() as db:
        status = await cert_drop.status(db, tenant)
        out["have"] = [{"kind": h.get("kind"), "text": h.get("text")} for h in status.get("have", [])]
        out["people_rows"] = (await db.execute(
            select(func.count()).select_from(CertPersonRecord)
            .where(CertPersonRecord.tenant_id == tenant))).scalar()
        out["entry_rows"] = (await db.execute(
            select(func.count()).select_from(CertEntryRecord)
            .where(CertEntryRecord.tenant_id == tenant))).scalar()
        rows = await cert_drop.audit_rows(db, tenant)
        body = await asyncio.to_thread(cert_reconcile.to_xlsx, rows)
        await db.rollback()
    wb = load_workbook(io.BytesIO(body), read_only=True)
    sheets = []
    for ws in wb.worksheets:
        data = list(ws.iter_rows(values_only=True))
        sheets.append({"sheet": ws.title, "rows": max(0, len(data) - 1),
                       "headers": [str(c) for c in (data[0] if data else []) if c is not None]})
    out["audit_xlsx"] = {"bytes": len(body), "zip_magic": body[:2] == b"PK", "sheets": sheets}
    print("RESULT " + json.dumps(out, default=str))


asyncio.run(main())
