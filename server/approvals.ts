import { id } from './db.ts';
import { publish } from './bus.ts';
import { notify } from './notify.ts';
import { recordEvent } from './chat.ts';

/**
 * Human-in-the-loop prompts. Anything with side effects in the real world (sending email,
 * paying, submitting forms) waits here until you approve it in the UI.
 */

export interface Pending {
  id: string;
  kind: 'approval' | 'question' | 'code' | 'unlock';
  title: string;
  detail: string;
  conversationId?: string;
  handoffId?: string;
  createdAt: number;
}

const waiting = new Map<string, { pending: Pending; resolve: (answer: { approved: boolean; text?: string }) => void }>();

export function listPending(): Pending[] {
  return [...waiting.values()].map((w) => w.pending);
}

function ask(p: Omit<Pending, 'id' | 'createdAt'>, signal?: AbortSignal, onCreated?: (id: string) => void) {
  const pending: Pending = { ...p, id: id(), createdAt: Date.now() };
  onCreated?.(pending.id);
  return new Promise<{ approved: boolean; text?: string }>((resolve, reject) => {
    const cleanup = () => {
      waiting.delete(pending.id);
      publish({ type: 'pending.resolved', id: pending.id });
    };
    waiting.set(pending.id, {
      pending,
      resolve: (a) => {
        cleanup();
        resolve(a);
      },
    });
    signal?.addEventListener('abort', () => {
      if (waiting.has(pending.id)) {
        cleanup();
        reject(new Error('Cancelled'));
      }
    });
    publish({ type: 'pending.created', pending });
    const title =
      p.kind === 'approval'
        ? 'Errand needs your approval'
        : p.kind === 'code'
          ? 'Errand needs a verification code'
          : p.kind === 'unlock'
            ? 'Errand needs your vault unlocked'
            : 'Errand has a question';
    void notify({ title, body: 'Open Errand to respond.', urgent: true });
  });
}

export async function requestApproval(p: Omit<Pending, 'id' | 'createdAt' | 'kind'>, signal?: AbortSignal) {
  return (await ask({ ...p, kind: 'approval' }, signal)).approved;
}

export async function askUser(p: Omit<Pending, 'id' | 'createdAt' | 'kind'>, signal?: AbortSignal) {
  const a = await ask({ ...p, kind: 'question' }, signal);
  return a.approved ? (a.text ?? '') : '';
}

/** Ask the user to unlock the vault (answered by the UI after a successful unlock). */
export async function askUnlock(p: Omit<Pending, 'id' | 'createdAt' | 'kind'>, signal?: AbortSignal) {
  return (await ask({ ...p, kind: 'unlock' }, signal)).approved;
}

/** Ask for a one-time code (OTP / 2FA). Shown in chat as an "Enter your <site> code" pill. */
export async function askForCode(p: Omit<Pending, 'id' | 'createdAt' | 'kind'>, signal?: AbortSignal, onCreated?: (id: string) => void) {
  const a = await ask({ ...p, kind: 'code' }, signal, onCreated);
  return a.approved ? (a.text ?? '').trim() : '';
}

/** Pending items still waiting (used to auto-answer a code request once the email arrives). */
export const isPending = (pid: string) => waiting.has(pid);

export function resolvePending(pid: string, answer: { approved: boolean; text?: string }) {
  const w = waiting.get(pid);
  if (!w) return false;
  const p = w.pending;
  if (p.conversationId) {
    const what =
      p.kind === 'code'
        ? `${p.title.replace(/^Enter your /, '')} ${answer.approved ? 'submitted' : 'skipped'}`
        : p.kind === 'unlock'
          ? answer.approved
            ? 'Vault unlocked'
            : 'Vault left locked'
          : p.kind === 'approval'
            ? `${answer.approved ? 'You approved' : 'You declined'}: ${p.title === 'Go ahead with this?' && p.detail ? p.detail.slice(0, 140) : p.title.replace(/\?$/, '')}`
            : answer.approved
              ? `Answered: ${p.title}`
              : `Skipped: ${p.title}`;
    recordEvent(p.conversationId, what);
  }
  w.resolve(answer);
  return true;
}
