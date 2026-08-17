'use strict';

/**
 * Cosmo research Launch contract.
 *
 * Launch starts a research RUN. Watch is the run. Query asks the Brain later.
 * Interactive is a CHAT ADD-ON on the desk. It is not Cosmo research.
 * Launch and Continue never route into Interactive.
 */

const RESEARCH_PRODUCT_LOOP = 'research';
const RESEARCH_LAUNCH_VIEW = 'watch';
const INTERACTIVE_PRODUCT_LOOP = 'interactive';

function launchDestination() {
  return RESEARCH_LAUNCH_VIEW;
}

function resolveProductLoop(requested) {
  if (requested === INTERACTIVE_PRODUCT_LOOP) {
    return RESEARCH_PRODUCT_LOOP;
  }
  return RESEARCH_PRODUCT_LOOP;
}

function isInteractiveProductLoop() {
  return false;
}

function isResearchLaunchView(viewName) {
  return viewName === RESEARCH_LAUNCH_VIEW;
}

module.exports = {
  RESEARCH_PRODUCT_LOOP,
  RESEARCH_LAUNCH_VIEW,
  INTERACTIVE_PRODUCT_LOOP,
  launchDestination,
  resolveProductLoop,
  isInteractiveProductLoop,
  isResearchLaunchView
};
