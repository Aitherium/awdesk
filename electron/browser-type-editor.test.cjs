// browser_type into a rich editor (contenteditable) goes in as REAL input (2026-11-09).
// Setting textContent showed the words in Discord's composer while its Slate model
// stayed empty, so three Enters sent nothing. The page script now only selects the
// editor; the main process inserts via webContents.insertText and reads it back.
const test = require("node:test");
const assert = require("node:assert/strict");
const { scriptFor, editorKept } = require("./browser-window.cjs");

test("the type script never writes an editor's textContent", () => {
  const js = scriptFor("type", { target: { ref: "e1" }, text: "hello" });
  assert.ok(!js.includes("el.textContent = text"), "textContent bypasses the editor's model");
  assert.ok(js.includes("selectNodeContents"), "the editor's contents are selected for insertText");
  assert.ok(js.includes("editable: true"), "the main process is told to insert");
});

test("readback is a valid page script", () => {
  const js = scriptFor("readback", { target: { ref: "e1" } });
  assert.doesNotThrow(() => new Function(`return ${js}`));
});

test("editorKept tolerates a trailing newline and NBSP runs, nothing else", () => {
  const NBSP = String.fromCharCode(160);
  const LF = String.fromCharCode(10);
  assert.equal(editorKept("hi there" + LF, "hi there"), true);
  assert.equal(editorKept("a" + NBSP + " b", "a  b"), true);
  assert.equal(editorKept("", "hi"), false);
  assert.equal(editorKept("hi", "hi!"), false);
});
