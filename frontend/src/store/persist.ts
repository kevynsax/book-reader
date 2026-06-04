import { Book } from '../types';

const BOOKS_KEY = 'books:data';

// The book list is no longer fetched via REST — it's hydrated from here on startup and
// kept fresh by the WebSocket delta-sync, so it must survive reloads in localStorage.
export function loadPersistedBooks(): Book[] {
  try {
    const raw = localStorage.getItem(BOOKS_KEY);
    return raw ? (JSON.parse(raw) as Book[]) : [];
  } catch {
    return [];
  }
}

export function persistBooks(books: Book[]): void {
  try {
    localStorage.setItem(BOOKS_KEY, JSON.stringify(books));
  } catch {
    /* quota exceeded or serialization error — non-fatal */
  }
}
