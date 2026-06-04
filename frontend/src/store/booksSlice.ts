import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { Book, Chapter, OcrPage, Progress, VoiceTrack } from '../types';
import { api } from '../api/booksApi';
import { loadPersistedBooks } from './persist';

interface BooksState {
  books: Book[];
  loading: boolean;
  error: string | null;
}

const persistedBooks = loadPersistedBooks();
const initialState: BooksState = {
  books: persistedBooks,
  loading: persistedBooks.length === 0,
  error: null,
};

export const updateChapters = createAsyncThunk(
  'books/updateChapters',
  async ({ bookId, chapters }: { bookId: string; chapters: { title: string; startPage: number; startChar: number }[] }) => {
    await api.patch(`/api/books/${bookId}/chapters`, { chapters });
  }
);

export const confirmChapters = createAsyncThunk(
  'books/confirmChapters',
  async ({ bookId, chapters, voice }: { bookId: string; chapters: { title: string; startPage: number; startChar: number }[]; voice?: string }) => {
    await api.put(`/api/books/${bookId}/chapters`, { chapters, voice });
    return bookId;
  }
);

export const generateBook = createAsyncThunk(
  'books/generate',
  async (bookId: string) => {
    await api.post(`/api/books/${bookId}/generate`);
    return bookId;
  }
);

export const deleteBook = createAsyncThunk('books/delete', async (bookId: string) => {
  await api.delete(`/api/books/${bookId}`);
  return bookId;
});

export const renameBook = createAsyncThunk(
  'books/rename',
  async ({ bookId, name }: { bookId: string; name: string }) => {
    await api.patch(`/api/books/${bookId}`, { name });
  }
);

export const addVoice = createAsyncThunk(
  'books/addVoice',
  async ({ bookId, voice }: { bookId: string; voice: string }) => {
    await api.post(`/api/books/${bookId}/voices`, { voice });
  }
);

export const removeVoice = createAsyncThunk(
  'books/removeVoice',
  async ({ bookId, voice }: { bookId: string; voice: string }) => {
    await api.delete(`/api/books/${bookId}/voices/${encodeURIComponent(voice)}`);
  }
);

const booksSlice = createSlice({
  name: 'books',
  initialState,
  reducers: {
    syncBooks(state, action: PayloadAction<Book[]>) {
      state.loading = false;
      for (const incoming of action.payload) {
        const idx = state.books.findIndex(b => b._id === incoming._id);
        if (idx === -1) state.books.unshift(incoming);
        else state.books[idx] = incoming;
      }
      state.books.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    applyWsUpdate(state, action: PayloadAction<{ bookId: string } & Record<string, unknown>>) {
      const { bookId, ...patch } = action.payload;
      const idx = state.books.findIndex(b => b._id === bookId);
      if (idx === -1) return;

      const book = state.books[idx];

      if (patch.updatedAt) book.updatedAt = patch.updatedAt as string;
      if (patch.name) book.name = patch.name as string;
      if (patch.status) book.status = patch.status as Book['status'];
      if (patch.progress) book.progress = patch.progress as Progress;
      if (patch.totalPages) book.totalPages = patch.totalPages as number;
      if (patch.coverImagePath) {
        book.coverImagePath = patch.coverImagePath as string;
        book.coverVersion = (book.coverVersion ?? 0) + 1;
      }
      if (patch.errorMessage) book.errorMessage = patch.errorMessage as string;

      if (patch.voices) book.voices = patch.voices as string[];

      if (patch.chapters) book.chapters = patch.chapters as Chapter[];

      if (patch.ocrPage) {
        const up = patch.ocrPage as { page: number; text?: string; status?: OcrPage['status'] };
        const pageIdx = book.ocrPages.findIndex(p => p.page === up.page);
        if (pageIdx !== -1) {
          if (up.text !== undefined) book.ocrPages[pageIdx].text = up.text;
          if (up.status !== undefined) book.ocrPages[pageIdx].status = up.status;
        }
      }

      if (patch.ocrPages) book.ocrPages = patch.ocrPages as OcrPage[];

      if (patch.chapterUpdate) {
        const cu = patch.chapterUpdate as {
          idx: number; voice?: string; audioStatus: VoiceTrack['audioStatus'];
          audioPath?: string; audioDurationSecs?: number;
        };
        const chapter = book.chapters[cu.idx];
        if (chapter) {
          const voice = cu.voice ?? book.voices?.[0];
          if (!chapter.tracks) chapter.tracks = [];
          let track = chapter.tracks.find(t => t.voice === voice);
          if (!track && voice) {
            track = { voice, audioStatus: cu.audioStatus };
            chapter.tracks.push(track);
          }
          if (track) {
            track.audioStatus = cu.audioStatus;
            if (cu.audioPath) track.audioPath = cu.audioPath;
            if (cu.audioDurationSecs !== undefined) track.audioDurationSecs = cu.audioDurationSecs;
          }
        }
      }
    },
  },
  extraReducers: builder => {
    builder
      .addCase(deleteBook.fulfilled, (state, action) => {
        state.books = state.books.filter(b => b._id !== action.payload);
      });
  },
});

export const { syncBooks, applyWsUpdate } = booksSlice.actions;
export default booksSlice.reducer;
