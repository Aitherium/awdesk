"use strict";

// A sticky note. The text lives on the card (canvas-model `data.text`), saved as you type.
module.exports = {
  id: "note",
  label: "Sticky note",
  hint: "A note on the board; saved as you type",
  view: "note",
  size: { w: 240, h: 200 },
  refreshMs: 0,
};
