// ─────────────────────────────────────────────
// Sentinel SDK — Main entry point
// Unified API for browser integration
// ─────────────────────────────────────────────

import { Reporter } from './reporter.js';
import { Recorder } from './recorder.js';
import { Annotator } from './annotator.js';

export { Reporter, Recorder, Annotator };

/**
 * Initialize Sentinel in one call.
 *
 * @example
 *   import { init } from '@nuptech/sentinel/sdk';
 *
 *   const sentinel = await init({
 *     serverUrl: 'http://localhost:3900',
 *     projectId: 'my-app',
 *     userId: 'tester@company.com',
 *   });
 *
 *   // When done:
 *   await sentinel.stop();
 */
export async function init({
  serverUrl,
  projectId,
  userId,
  metadata,
  captureDOM = true,
  captureNetwork = true,
  captureConsole = true,
  captureErrors = true,
  annotator = true,
  annotatorPosition = 'bottom-right',
  batchSize,
  flushInterval,
} = {}) {
  if (!serverUrl) throw new Error('Sentinel: serverUrl is required');
  if (!projectId) throw new Error('Sentinel: projectId is required');

  const reporter = new Reporter({ serverUrl, projectId, batchSize, flushInterval });
  const session = await reporter.startSession({ userId, metadata });

  const recorder = new Recorder({
    reporter,
    captureDOM,
    captureNetwork,
    captureConsole,
    captureErrors,
  });
  await recorder.start();

  let annotatorInstance = null;
  if (annotator) {
    annotatorInstance = new Annotator({ reporter, position: annotatorPosition });
    annotatorInstance.mount();
  }

  // Cleanup on page unload
  const onBeforeUnload = () => reporter.destroy();
  window.addEventListener('beforeunload', onBeforeUnload);

  return {
    session,
    reporter,
    recorder,
    annotator: annotatorInstance,

    /** Report a finding programmatically */
    report: (finding) => reporter.reportFinding(finding),

    /** Stop recording, flush events, end session */
    async stop() {
      recorder.stop();
      if (annotatorInstance) annotatorInstance.unmount();
      window.removeEventListener('beforeunload', onBeforeUnload);
      await reporter.endSession();
    },
  };
}
