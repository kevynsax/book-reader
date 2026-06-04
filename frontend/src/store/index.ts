import { configureStore } from '@reduxjs/toolkit';
import booksReducer from './booksSlice';
import { persistBooks } from './persist';

export const store = configureStore({
  reducer: { books: booksReducer },
});

// Persist the book list after every change. Immer gives the books array a new
// reference whenever anything inside it changes, so this only writes when needed.
let prevBooks = store.getState().books.books;
store.subscribe(() => {
  const books = store.getState().books.books;
  if (books !== prevBooks) {
    prevBooks = books;
    persistBooks(books);
  }
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
