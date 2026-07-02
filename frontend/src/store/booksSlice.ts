import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import axios from 'axios';
import { Book, Chapter, OcrPage, Progress, VoiceProgress, VoiceTrack } from '../types';
import { api } from '../api/booksApi';
import { loadPersistedBooks } from './persist';

interface BooksState {
  books: Book[];
  loading: boolean;
  error: string | null;
  canDelete: boolean;
}

const persistedBooks = loadPersistedBooks();
const initialState: BooksState = {
  books: persistedBooks,
  loading: persistedBooks.length === 0,
  error: null,
  canDelete: false,
};

export const updateChapters = createAsyncThunk(
  'books/updateChapters',
  async ({ bookId, chapters }: { bookId: string; chapters: { title: string; startPage: number; startChar: number }[] }) => {
    await api.patch(`/api/books/${bookId}/chapters`, { chapters });
  }
);

export const confirmChapters = createAsyncThunk(
  'books/confirmChapters',
  async ({ bookId, chapters, voices }: { bookId: string; chapters: { title: string; startPage: number; startChar: number }[]; voices?: string[] }) => {
    await api.put(`/api/books/${bookId}/chapters`, { chapters, voices });
    return bookId;
  }
);

export const updatePageText = createAsyncThunk(
  'books/updatePageText',
  async ({ bookId, page, text }: { bookId: string; page: number; text: string }) => {
    await api.put(`/api/books/${bookId}/pages/${page}/text`, { text });
  }
);

export const reocrPage = createAsyncThunk(
  'books/reocrPage',
  async ({ bookId, page }: { bookId: string; page: number }) => {
    await api.post(`/api/books/${bookId}/pages/${page}/reocr`);
  }
);

export const generateBook = createAsyncThunk(
  'books/generate',
  async (bookId: string) => {
    await api.post(`/api/books/${bookId}/generate`);
    return bookId;
  }
);

export const stopBook = createAsyncThunk(
  'books/stop',
  async (bookId: string) => {
    await api.post(`/api/books/${bookId}/stop`);
    return bookId;
  }
);

interface ReimportConfig {
  coverPage: number;
  summaryPages: number[];
  firstPage: number;
  lastPage: number;
}

export const reprocessBook = createAsyncThunk(
  'books/reprocess',
  async ({ bookId, config }: { bookId: string; config?: ReimportConfig }) => {
    await api.post(`/api/books/${bookId}/reprocess`, config ?? {});
    return bookId;
  }
);

export const resumeBook = createAsyncThunk(
  'books/resume',
  async (bookId: string) => {
    await api.post(`/api/books/${bookId}/resume`);
    return bookId;
  }
);

export const dismissBookError = createAsyncThunk(
  'books/dismissError',
  async (bookId: string) => {
    await api.post(`/api/books/${bookId}/dismiss-error`);
    return bookId;
  }
);

export const deleteBook = createAsyncThunk('books/delete', async (bookId: string) => {
  await api.delete(`/api/books/${bookId}`);
  return bookId;
});

export const fetchDeletePermission = createAsyncThunk('books/canDelete', async () => {
  const { data } = await api.get<{ canDelete: boolean }>('/api/books/can-delete');
  return data.canDelete;
});

export const renameBook = createAsyncThunk(
  'books/rename',
  async ({ bookId, name }: { bookId: string; name: string }) => {
    await api.patch(`/api/books/${bookId}`, { name });
  }
);

export const addVoice = createAsyncThunk(
  'books/addVoice',
  async ({ bookId, voice }: { bookId: string; voice: string | string[] }) => {
    const voices = Array.isArray(voice) ? voice : [voice];
    await api.post(`/api/books/${bookId}/voices`, { voices });
  }
);

export const removeVoice = createAsyncThunk(
  'books/removeVoice',
  async ({ bookId, voice }: { bookId: string; voice: string }) => {
    await api.delete(`/api/books/${bookId}/voices/${encodeURIComponent(voice)}`);
  }
);

async function postAction(url: string) {
  try {
    await api.post(url);
  } catch (e) {
    const detail = axios.isAxiosError(e) ? e.response?.data?.error : undefined;
    throw new Error(detail ?? (e instanceof Error ? e.message : String(e)));
  }
}

export const regenerateVoice = createAsyncThunk(
  'books/regenerateVoice',
  async ({ bookId, voice }: { bookId: string; voice: string }) => {
    await postAction(`/api/books/${bookId}/voices/${encodeURIComponent(voice)}/regenerate`);
  }
);

export const regenerateChapterVoice = createAsyncThunk(
  'books/regenerateChapterVoice',
  async ({ bookId, chapterIdx, voice }: { bookId: string; chapterIdx: number; voice: string }) => {
    await postAction(`/api/books/${bookId}/chapters/${chapterIdx}/voices/${encodeURIComponent(voice)}/regenerate`);
  }
);

export const continueChapterVoice = createAsyncThunk(
  'books/continueChapterVoice',
  async ({ bookId, chapterIdx, voice }: { bookId: string; chapterIdx: number; voice: string }) => {
    await postAction(`/api/books/${bookId}/chapters/${chapterIdx}/voices/${encodeURIComponent(voice)}/continue`);
  }
);

const booksSlice = createSlice({
  name: 'books',
  initialState,
  reducers: {
    removeBook(state, action: PayloadAction<string>) {
      state.books = state.books.filter(b => b._id !== action.payload);
    },
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
      if ('splitProgress' in patch) book.splitProgress = patch.splitProgress as Progress | null;
      if (patch.voiceProgress) {
        const vp = patch.voiceProgress as VoiceProgress;
        book.voiceProgress = { ...book.voiceProgress, [vp.voice]: vp };
      }
      if (patch.totalPages) book.totalPages = patch.totalPages as number;
      if (patch.coverImagePath) {
        book.coverImagePath = patch.coverImagePath as string;
        book.coverVersion = (book.coverVersion ?? 0) + 1;
      }
      if ('errorMessage' in patch) book.errorMessage = (patch.errorMessage as string) || undefined;

      if (patch.voices) book.voices = patch.voices as string[];

      if (patch.chapters) book.chapters = patch.chapters as Chapter[];

      if (patch.ocrPage) {
        const up = patch.ocrPage as { page: number; text?: string; readText?: string; status?: OcrPage['status']; error?: string };
        const pageIdx = book.ocrPages.findIndex(p => p.page === up.page);
        if (pageIdx !== -1) {
          if (up.text !== undefined) book.ocrPages[pageIdx].text = up.text;
          if (up.readText !== undefined) book.ocrPages[pageIdx].readText = up.readText;
          if (up.status !== undefined) book.ocrPages[pageIdx].status = up.status;
          if ('error' in up) book.ocrPages[pageIdx].error = up.error;
          else if (up.status === 'processing' || up.status === 'complete') book.ocrPages[pageIdx].error = undefined;
        }
      }

      if (patch.ocrPages) book.ocrPages = patch.ocrPages as OcrPage[];

      if (patch.chapterUpdate) {
        const cu = patch.chapterUpdate as {
          idx: number; voice?: string; audioStatus: VoiceTrack['audioStatus'];
          audioPath?: string; audioDurationSecs?: number; audioError?: string;
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
            track.audioError = cu.audioError;
            if (cu.audioPath) track.audioPath = cu.audioPath;
            if (cu.audioDurationSecs !== undefined) track.audioDurationSecs = cu.audioDurationSecs;
          }
          if (voice && cu.audioStatus !== 'generating' && book.voiceProgress?.[voice]?.chapterIdx === cu.idx) {
            delete book.voiceProgress[voice];
          }
        }
      }
    },
  },
  extraReducers: builder => {
    builder
      .addCase(deleteBook.fulfilled, (state, action) => {
        state.books = state.books.filter(b => b._id !== action.payload);
      })
      .addCase(fetchDeletePermission.fulfilled, (state, action) => {
        state.canDelete = action.payload;
      });
  },
});

export const { syncBooks, applyWsUpdate, removeBook } = booksSlice.actions;
export default booksSlice.reducer;
