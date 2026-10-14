// One at a time (F41, F52). A read, change and write of something in storage, such as the queue or the device key, runs
// under a named lock, so two changes never overwrite each other. Web Locks are shared by every page and worker of the
// extension's origin, so the options page and the background wait for each other too; where a browser has none, the
// lock holds within this page or worker only.
const chains = new Map<string, Promise<unknown>>();

type Locks = { request<T>(name: string, work: () => Promise<T>): Promise<T> };

export function exclusive<T>(name: string, work: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as { locks?: Locks } | undefined)?.locks;
  if (locks) return locks.request(`kefli-${name}`, work);
  const run = (chains.get(name) ?? Promise.resolve()).then(work);
  chains.set(name, run.catch(() => undefined));
  return run;
}

/**
 * A save's run. The type is named, and run reads its chain on a line of its own, since lizard, which the code gate uses,
 * misreads a function type in a method's signature and a call on a bracketed expression, and then scores nothing after.
 */
type Work<T> = () => Promise<T>;

/**
 * One at a time for each save, within the background: its delivery and Undo never overlap, so Undo waits for a send
 * already under way and then knows whether it went (F40). busy says whether one is running, so a flush can leave it be.
 */
export class PerSave {
  private runs = new Map<string, Promise<unknown>>();

  busy(id: string): boolean {
    return this.runs.has(id);
  }

  run<T>(id: string, work: Work<T>): Promise<T> {
    const before = this.runs.get(id) ?? Promise.resolve();
    const run = before.then(work);
    const tail = run.catch(() => undefined);
    this.runs.set(id, tail);
    void tail.then(() => this.runs.get(id) === tail && this.runs.delete(id));
    return run;
  }

  /**
   * A save given a new id while a run under its old one goes on, as when its request is wrapped again (v1.12): the new id
   * is busy, and runs under it wait, until that run has ended, so a flush can't send the new wrap beside it.
   */
  follow(was: string, to: string): void {
    const tail = this.runs.get(was);
    if (!tail) return;
    this.runs.set(to, tail);
    void tail.then(() => this.runs.get(to) === tail && this.runs.delete(to));
  }
}
