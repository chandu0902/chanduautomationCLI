'use strict';

const { RunnerResumePreference } = require('../models');

const ROW_ID = 1;

async function _row() {
  const [r] = await RunnerResumePreference.findOrCreate({
    where: { id: ROW_ID },
    defaults: { id: ROW_ID },
  });
  return r;
}

function _parse(json) {
  if (json == null || json === '') return null;
  try {
    const o = JSON.parse(json);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch (_) {
    return null;
  }
}

/** Drop keys that must never be replayed on boot (fresh session / truncate). */
function persistableSolPaperBody(body) {
  const o = body && typeof body === 'object' && !Array.isArray(body) ? { ...body } : {};
  delete o.fresh;
  delete o.clearPaperDb;
  return o;
}

async function setSolPaperResume(body) {
  const row = await _row();
  const payload = persistableSolPaperBody(body);
  await row.update({ solPaperStartJson: JSON.stringify(payload) });
}

async function clearSolPaperResume() {
  const row = await _row();
  await row.update({ solPaperStartJson: null });
}

async function getSolPaperResume() {
  const row = await _row();
  return _parse(row.solPaperStartJson);
}

async function setCrossPaperResume(body) {
  const row = await _row();
  const o = body && typeof body === 'object' && !Array.isArray(body) ? { ...body } : {};
  await row.update({ crossPaperStartJson: JSON.stringify(o) });
}

async function clearCrossPaperResume() {
  const row = await _row();
  await row.update({ crossPaperStartJson: null });
}

async function getCrossPaperResume() {
  const row = await _row();
  return _parse(row.crossPaperStartJson);
}

module.exports = {
  persistableSolPaperBody,
  setSolPaperResume,
  clearSolPaperResume,
  getSolPaperResume,
  setCrossPaperResume,
  clearCrossPaperResume,
  getCrossPaperResume,
};
