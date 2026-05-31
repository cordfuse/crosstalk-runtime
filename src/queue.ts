// Job queue for v3 coordinator dispatch.
// One queue shared across all actors; drain() returns only jobs for the
// requested actor and respects the in-flight concurrency limit.

export interface Job {
  actor: string;
  tier: string;        // tier name from host file (e.g. "haiku", "flash")
  cli: string;         // CLI command for this tier
  channelGuid: string;
  messageRelPath: string;
}

export class JobQueue {
  private readonly pending: Job[] = [];
  private readonly inFlight = new Map<string, number>(); // actorName → active count

  // Enqueue a job. Silently drops duplicates (same actor + relPath).
  enqueue(job: Job): boolean {
    const dup = this.pending.some(
      j => j.actor === job.actor && j.messageRelPath === job.messageRelPath,
    );
    if (dup) return false;
    this.pending.push(job);
    return true;
  }

  // Return up to (maxConcurrent − inFlight) jobs for the given actor,
  // removing them from the pending list.
  drain(actorName: string, maxConcurrent: number): Job[] {
    const active = this.inFlight.get(actorName) ?? 0;
    const available = maxConcurrent - active;
    if (available <= 0) return [];

    const out: Job[] = [];
    let remaining = available;
    for (let i = this.pending.length - 1; i >= 0 && remaining > 0; i--) {
      if (this.pending[i].actor === actorName) {
        out.push(this.pending.splice(i, 1)[0]);
        remaining--;
      }
    }
    // Reverse so oldest jobs run first (splice reverses order from the back)
    out.reverse();

    if (out.length > 0) {
      this.inFlight.set(actorName, active + out.length);
    }
    return out;
  }

  // Signal that one dispatch for actorName has completed.
  complete(actorName: string): void {
    const active = this.inFlight.get(actorName) ?? 1;
    this.inFlight.set(actorName, Math.max(0, active - 1));
  }

  pendingCount(actorName?: string): number {
    return actorName
      ? this.pending.filter(j => j.actor === actorName).length
      : this.pending.length;
  }

  inFlightCount(actorName?: string): number {
    if (actorName) return this.inFlight.get(actorName) ?? 0;
    let total = 0;
    for (const v of this.inFlight.values()) total += v;
    return total;
  }
}
