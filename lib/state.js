// ============================================================
// 状態管理: 前回の空き状況を state.json に保存し、差分(新しい空き)を検出する
// ============================================================
const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, '..', 'state.json');

// 枠を一意に識別するキー
const slotKey = (s) => `${s.facility}|${s.date}|${s.time}`;

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { slots: [] }; // 初回実行時など
  }
}

// 前回に無く、今回ある枠 = 「新しく出た空き」
function diffNewSlots(prevState, currentSlots) {
  const prevKeys = new Set((prevState.slots || []).map(slotKey));
  return currentSlots.filter((s) => !prevKeys.has(slotKey(s)));
}

function saveState(currentSlots) {
  const state = {
    updatedAt: new Date().toISOString(),
    slots: currentSlots,
  };
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

module.exports = { loadState, diffNewSlots, saveState, slotKey };
