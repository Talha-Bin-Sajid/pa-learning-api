import type { EvidenceVerificationService } from '../../application/use-cases/evidence-verification.service.js';
import type { Logger } from '../../shared/utils/logger.js';

/**
 * Background worker for evidence checks (no queue dependency - the
 * evidence_checks table is the queue). Polls every few seconds and works
 * through due jobs one at a time, so uploads never wait on the AI.
 */
export class VerificationWorker {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private readonly verification: EvidenceVerificationService,
    private readonly logger: Logger,
    private readonly intervalMs = 5_000,
    /** Jobs per tick at most, so one tick never runs for too long. */
    private readonly batchSize = 10,
  ) {}

  start(): void {
    if (this.timer || !this.verification.enabled) return;
    void this.verification
      .recoverStale()
      .then((n) => n > 0 && this.logger.info('re-queued interrupted evidence checks', { count: n }))
      .catch((err: unknown) => this.logger.error('could not recover evidence checks', { err }));
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
    this.logger.info('evidence verification worker started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Exposed for tests: processes due jobs; returns how many ran. */
  async tick(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    let done = 0;
    try {
      while (done < this.batchSize && (await this.verification.processNext())) done++;
    } catch (err) {
      this.logger.error('evidence worker tick failed', { err });
    } finally {
      this.busy = false;
    }
    return done;
  }
}
