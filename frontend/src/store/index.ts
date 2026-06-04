import { configureStore } from '@reduxjs/toolkit';
import booksReducer from './booksSlice';
import { persistBooks } from './persist';

export const store = configureStore({
  reducer: { books: booksReducer },
});

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
