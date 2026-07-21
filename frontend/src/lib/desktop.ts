// Typed access to the Electron bridge (preload.js exposes window.jobpilot). In a normal
// browser this is all undefined/no-ops, so calling code can stay unconditional and the
// desktop-only UI (the terminal) simply doesn't render.

export interface WorkerStatus { running: boolean }

interface JobPilotBridge {
  isDesktop: true;
  platform: string;
  backendUrl: string;
  startWorker: (token?: string) => Promise<WorkerStatus>;
  stopWorker: () => Promise<WorkerStatus>;
  getWorkerStatus: () => Promise<WorkerStatus>;
  getSavedToken: () => Promise<string>;
  onWorkerLog: (cb: (line: string) => void) => () => void;
  onWorkerStatus: (cb: (s: WorkerStatus) => void) => () => void;
}

export function desktop(): JobPilotBridge | null {
  return (typeof window !== 'undefined' && (window as any).jobpilot) || null;
}

/** True when running inside the JobPilot desktop app (vs. a plain browser tab). */
export function isDesktopApp(): boolean {
  return !!desktop();
}
