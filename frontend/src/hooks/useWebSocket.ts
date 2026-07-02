import { useEffect } from 'react';
import { useDispatch } from 'react-redux';
import { AppDispatch, store } from '../store';
import { applyWsUpdate, syncBooks, fetchDeletePermission, removeBook } from '../store/booksSlice';
import { Book } from '../types';

type Handler = (data: never) => void;

let ws: WebSocket | null = null;
let backoff = 500;
const listeners = new Map<string, Set<Handler>>();
const pending: string[] = [];

function fire(event: string, data: unknown) {
  listeners.get(event)?.forEach(cb => (cb as (d: unknown) => void)(data));
}

function on(event: string, cb: Handler): () => void {
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  set.add(cb);
  return () => { set!.delete(cb); };
}

function ensureSocket(): WebSocket {
  if (ws) return ws;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${location.host}/ws`);
  ws = socket;

  socket.onopen = () => {
    backoff = 500;
    pending.splice(0).forEach(msg => socket.send(msg));
    fire('connect', undefined);
  };
  socket.onmessage = e => {
    try {
      const { event, data } = JSON.parse(e.data);
      fire(event, data);
    } catch {
      /* ignore malformed frames */
    }
  };
  socket.onclose = () => {
    if (ws === socket) ws = null;
    setTimeout(ensureSocket, backoff);
    backoff = Math.min(backoff * 2, 10_000);
  };
  socket.onerror = () => socket.close();
  return socket;
}

function isConnected(): boolean {
  return ws?.readyState === WebSocket.OPEN;
}

function emit(event: string, data: unknown) {
  const msg = JSON.stringify({ event, data });
  const socket = ensureSocket();
  if (socket.readyState === WebSocket.OPEN) socket.send(msg);
  else pending.push(msg);
}

export function requestBook(bookId: string) {
  emit('subscribe-to-book', { bookId });
}

// Subscribe to raw book:update payloads (e.g. segment/sentence events the editor
// needs but that don't live in the redux store). Returns an unsubscribe fn.
export function onBookUpdate(
  cb: (data: { bookId: string } & Record<string, unknown>) => void
): () => void {
  ensureSocket();
  return on('book:update', cb as Handler);
}

function lastUpdateFromStore(): string | undefined {
  let max: string | undefined;
  for (const b of store.getState().books.books) {
    if (b.updatedAt && (!max || b.updatedAt > max)) max = b.updatedAt;
  }
  return max;
}

export function useWebSocket() {
  const dispatch = useDispatch<AppDispatch>();

  useEffect(() => {
    dispatch(fetchDeletePermission());
    ensureSocket();

    const onConnect = () => {
      emit('subscribe-to-books', { lastUpdate: lastUpdateFromStore() });
    };
    const offConnect = on('connect', onConnect);
    const offSync = on('books:sync', ((books: Book[]) => {
      dispatch(syncBooks(books));
    }) as Handler);
    const offUpdate = on('book:update', ((data: { bookId: string; updatedAt?: string } & Record<string, unknown>) => {
      dispatch(applyWsUpdate(data));
    }) as Handler);
    const offDeleted = on('book:deleted', ((data: { bookId: string }) => {
      dispatch(removeBook(data.bookId));
    }) as Handler);

    if (isConnected()) onConnect();

    return () => {
      offConnect();
      offSync();
      offUpdate();
      offDeleted();
    };
  }, [dispatch]);
}
