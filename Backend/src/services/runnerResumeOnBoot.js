'use strict';

const paperTrader = require('./paperTradeRunner');
const crossPaper = require('./crossPaperService');
const {
  getSolPaperResume,
  getCrossPaperResume,
} = require('./runnerResumeStore');

/**
 * After process restart, restart paper engines if the user last left them running
 * (saved on successful POST start; cleared on POST stop).
 */
async function resumePaperRunnersOnBoot() {
  const solBody = await getSolPaperResume();
  if (solBody && !paperTrader.isRunning()) {
    try {
      await paperTrader.start(solBody);
      console.log('[Boot] Resumed SOL paper (runner_resume_preferences)');
    } catch (e) {
      console.error('[Boot] SOL paper resume failed:', e.message);
    }
  }

  const crossBody = await getCrossPaperResume();
  if (crossBody && !crossPaper.isPaperRunning()) {
    const r = crossPaper.startPaperMulti(crossBody);
    if (!r.ok) {
      console.error('[Boot] Cross-paper resume failed:', r.reason || JSON.stringify(r));
    } else {
      console.log('[Boot] Resumed cross-paper pairs:', (r.pairKeys || []).join(','));
    }
  }

  return { solAttempted: !!solBody, crossAttempted: !!crossBody };
}

module.exports = { resumePaperRunnersOnBoot };
