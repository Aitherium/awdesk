# Validate a tenant app on the desk

Run this before a customer is told that a change to their workspace is live. Tests and
`curl` probes do not show what the owner or the customer sees; this drives the running
desk over its bridge and leaves a numbered screenshot per step.

```powershell
node scripts/validate_tenant_app_on_desk.cjs --tenant garg --out $env:TEMP\desk-validate `
  --live-container aitheros-gargbot `
  --container aitheros-vibe-api --synthetic <dir with roster.json + ground_truth.json>
```

| flag | meaning |
|---|---|
| `--tenant` | workspace name as `workspace.switch` knows it (`garg`) |
| `--out` | folder for the JPEGs and `results.json` |
| `--home` | workspace to return to (default `aitherium`) |
| `--live-container` | the tenant's backend container. Read only: counts and header names of the audit workbook |
| `--container` + `--synthetic` | a TEST tenant's backend container and a folder of synthetic people. The drop flow and a bad upload run there on a scratch SQLite file; the ticket is captured, never sent |
| `--keep-open` | stay in the tenant workspace at the end |

## What it checks

| step | how | verdict |
|---|---|---|
| a1-a4 | `workspace.switch` in, an unknown name, and back; every answer must start "You are in" | pass / fail |
| b1, b2 | opens the tenant app window, captures it and the overlay with `PrintWindow` | **look** |
| fairy | `fairy.counts`: badge, "N more waiting" and companion badges agree | pass / fail |
| d, e | the workbook behind "Download audit" opens; what the tenant holds | pass / fail |
| f | three files with odd headers are told apart by content; the app's own export dropped back asks one confirm | pass / fail |
| h | a bad upload sent twice makes one ticket with the header row and no data cell | pass / fail |

`look` means the machine took the picture and somebody must read it. Open the JPEG and
check: the tenant's brand and apps, nothing sitting on the taskbar, the tenant's
companion. A run with unread `look` steps is not finished.

Exit code: 0 no step failed, 1 a step failed, 2 the desk bridge did not answer.

## Rules it keeps

- Bridge commands only. No key is pressed, the pointer is not moved, the windows are
  captured without being focused.
- Synthetic files never go into a customer tenant. `--synthetic` data must carry
  `"synthetic": true`, and the drop flow runs on a throwaway database.
- The live tenant is read only, and only counts and column names are printed.

## What it cannot do

Clicks inside the signed-in tenant window (the CertTrack tabs, a GargBot chat turn) are
not reachable from the bridge. Do those in an Aither Browser agent tab after the owner
signs in there (`browser_hand_to_owner`), or have the owner look.
