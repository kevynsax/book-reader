import { useEffect } from 'react';
import { io, Socket } from 'socket.io-client';
import { useDispatch } from 'react-redux';
import { AppDispatch, store } from '../store';
import { applyWsUpdate, syncBooks, fetchDeletePermission } from '../store/booksSlice';
import { Book } from '../types';

let socket: Socket | null = null;

function getSocket(): Socket {
  if (!socket) {
    socket = io({ path: '/socket.io', transports: ['websocket', 'polling'] });
  }
  return socket;
}

export function requestBook(bookId: string) {
  getSocket().emit('subscribe-to-book', { bookId });
}

// Subscribe to raw book:update payloads (e.g. segment/sentence events the editor
// needs but that don't live in the redux store). Returns an unsubscribe fn.
export function onBookUpdate(
  cb: (data: { bookId: string } & Record<string, unknown>) => void
): () => void {
  const s = getSocket();
  s.on('book:update', cb);
  return () => { s.off('book:update', cb); };
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
    const s = getSocket();

    const onConnect = () => {
      s.emit('subscribe-to-books', { lastUpdate: lastUpdateFromStore() });
    };

    const onSync = (books: Book[]) => {
      dispatch(syncBooks(books));
    };

    const onUpdate = (data: { bookId: string; updatedAt?: string } & Record<string, unknown>) => {
      dispatch(applyWsUpdate(data));
    };

    s.on('connect', onConnect);
    s.on('books:sync', onSync);
    s.on('book:update', onUpdate);

    if (s.connected) onConnect();

    return () => {
      s.off('connect', onConnect);
      s.off('books:sync', onSync);
      s.off('book:update', onUpdate);
    };
  }, [dispatch]);
}
