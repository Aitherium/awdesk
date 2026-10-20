"use strict";

/**
 * local-only -- a desk character that must never leave this machine.
 *
 * The owner's IMPORTED bodies (his own licensed Character Creator 5 / Virt-A-Mate / DAZ
 * content, converted to VRM by the Darkmatter import rung `tools/3d-import`, or put on the
 * desk by `awavatar publish-local`) are not licence-clean for redistribution. They live in
 * this desk's characters/ folder for the owner's own use, and NOTHING uploads them: not the
 * avatar library seed, not an agent assignment push, not any later caller of
 * market-client.uploadAvatar.
 *
 * Two independent marks, either one is enough (defence in depth -- a copied model.vrm
 * without its character.json is still caught):
 *   * the record: character.json `local_only: true` or `distribution: "local-only"`;
 *   * the bytes: the VRM's glTF JSON carries `asset.extras.dm_import` (the converter's stamp)
 *     with `local_only` or `not_for_distribution` set.
 */

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const MAX_JSON = 16 * 1024 * 1024;

/** The glTF JSON chunk of GLB bytes, parsed; null when it is not a GLB. */
function glbJson(bytes) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length < 20) return null;
    if (bytes.readUInt32LE(0) !== GLB_MAGIC || bytes.readUInt32LE(16) !== JSON_CHUNK) return null;
    const n = bytes.readUInt32LE(12);
    if (n <= 0 || n > MAX_JSON || 20 + n > bytes.length) return null;
    return JSON.parse(bytes.subarray(20, 20 + n).toString("utf8"));
  } catch {
    return null;
  }
}

/** True when these model bytes carry the import rung's local-only stamp. */
function isLocalOnlyModel(bytes) {
  const j = glbJson(bytes);
  const x = j && j.asset && j.asset.extras && j.asset.extras.dm_import;
  return Boolean(x && (x.local_only === true || x.not_for_distribution === true));
}

/** True when a character.json record marks the character local-only. */
function isLocalOnlyRecord(rec) {
  return Boolean(rec && (rec.local_only === true || rec.distribution === "local-only"));
}

const LOCAL_ONLY_REASON = "a local-only imported body (the owner's own licensed content) never leaves this machine";

module.exports = { glbJson, isLocalOnlyModel, isLocalOnlyRecord, LOCAL_ONLY_REASON };
