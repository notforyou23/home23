import type { ScheduledChannelTurn } from '../coordination/app/scheduled-turns.js';
import type { JobExecutionContext, JobResult } from './cron.js';

/** Persist resolved input before the first network request. A lost response is
 * pending, never permission to execute the editorial instruction again locally. */
export async function runScheduledChannelTurn(input: ScheduledChannelTurn, execution: JobExecutionContext,
  submit: (input: ScheduledChannelTurn) => Promise<unknown>,
  delay: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 2000)),
): Promise<JobResult> {
  const start = Date.now();
  try {
    if (!execution.persistCanonicalTurn) throw new Error('Durable scheduler admission unavailable');
    execution.persistCanonicalTurn(input);
    for (;;) {
      const result = await submit(input) as { state?: string; text?: string; error?: string };
      if (result.state === 'succeeded') return {status:'ok',response:result.text??'',durationMs:Date.now()-start,semanticStatus:'unknown',outcomeLayers:{task:{status:'unknown',reason:'Canonical conversational Work completed; task accomplishment is not independently verified'},intent:{status:'unknown',reason:'A delivered reply alone is not evidence that the scheduled objective was fulfilled'}}};
      if (result.state === 'failed'||result.state==='cancelled') return {status:'error',error:result.error??`Scheduled Work ${result.state}`,durationMs:Date.now()-start,semanticStatus:'failed'};
      if(result.state!=='running') throw new Error('Unrecognized scheduled channel status');
      await delay();
    }
  } catch(error) {
    return {status:'error',error:`Scheduled channel run awaits reconciliation: ${error instanceof Error?error.message:String(error)}`,
      canonicalRunPending:true,durationMs:Date.now()-start,semanticStatus:'unknown'};
  }
}
