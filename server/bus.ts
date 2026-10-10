import { EventEmitter } from 'node:events';

export type BusEvent = { type: string; [k: string]: unknown };

const emitter = new EventEmitter();
emitter.setMaxListeners(100);

export function publish(event: BusEvent) {
  emitter.emit('event', event);
}

export function subscribe(fn: (event: BusEvent) => void): () => void {
  emitter.on('event', fn);
  return () => emitter.off('event', fn);
}
