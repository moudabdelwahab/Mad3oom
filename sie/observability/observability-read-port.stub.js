/**
 * observability-read-port.stub.js
 * ------------------------------------------------------------
 * The concrete read port actually wired up right now: every lookup
 * reports "not found", always — deliberately, since this module must
 * stay fully isolated from live Supabase data until an explicit future
 * integration task. Replay/Shadow Run simply have nothing to replay
 * until then; they degrade to an empty result rather than erroring.
 *
 * Swapping this for a real implementation later is a one-file change:
 * point replay-engine.js / shadow-run-engine.js's default at
 * observability-read-port.supabase.js instead.
 */
import { createObservabilityReadPort } from './observability-read-port.js';

export const observabilityReadPortStub = createObservabilityReadPort(async () => null);
