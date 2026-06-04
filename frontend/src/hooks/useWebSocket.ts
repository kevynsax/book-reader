import { useEffect } from 'react';
import { io, Socket } from 'socket.io-client';
import { useDispatch } from 'react-redux';
import { AppDispatch, store } from '../store';
import { applyWsUpdate, syncBooks } from '../store/booksSlice';
import { Book } from '../types';

let socket: Socket | null = null;

function getSocket(): Socket {
  if (!socket) {
    socket = io({ path: '/socket.io', transports: ['websocket', 'polling'] });
  }
  return socket;
}

// Ask the server to push a single book into the store (direct navigation or a freshly
// uploaded book). The reply comes back on books:sync. Emits are buffered until connected.
export function requestBook(bookId: string) {
  getSocket().emit('subscribe-to-book', { bookId });
}

// Newest updatedAt across the books we already have (hydrated from localStorage). The
// server uses it to send back only what changed since; empty cache → full sync.
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

    // Already connected (socket reused across mounts): subscribe immediately.
    if (s.connected) onConnect();

    return () => {
      s.off('connect', onConnect);
      s.off('books:sync', onSync);
      s.off('book:update', onUpdate);
    };
  }, [dispatch]);
}
