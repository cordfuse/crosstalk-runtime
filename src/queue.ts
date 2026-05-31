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

function jobKey(job: Job): string {
  return `${job.actor}:${job.channelGuid}:${job.messageRelPath}`;
}

export class JobQueue {
  private readonly pending: Job[] = [];
  private readonly inFlight = new Map<string, number>(); // actorName → active count
  private readonly inFlightKeys = new Set<string>();     // deduplicate across pending + in-flight

  // Enqueue a job. Returns false and drops silently if the job is already
  // pending or in-flight (same actor + channelGuid + relPath).
  enqueue(job: Job): boolean {
    const key = jobKey(job);
    if (this.inFlightKeys.has(key) || this.pending.some(j => jobKey(j) === key)) return false;
    this.pending.push(job);
    return true;
  }

  // Return up to (maxConcurrent − inFlight) jobs for the given actor,
  // removing them from the pending list and marking them in-flight.
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
      for (const job of out) this.inFlightKeys.add(jobKey(job));
    }
    return out;
  }

  // Signal that a dispatch has completed. Pass the job to release its dedup key.
  complete(job: Job): void {
    const active = this.inFlight.get(job.actor) ?? 1;
    this.inFlight.set(job.actor, Math.max(0, active - 1));
    this.inFlightKeys.delete(jobKey(job));
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
