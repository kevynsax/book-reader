import mongoose, { Schema, Document, Types } from 'mongoose';
import { sanitizePageText } from '../lib/sanitize.js';

export type BookStatus =
  | 'uploading'
  | 'splitting_pages'
  | 'extracting_cover'
  | 'reading_title'
  | 'ocr_processing'
  | 'detecting_chapters'
  | 'awaiting_chapter_review'
  | 'generating_audio'
  | 'complete'
  | 'error';

export type AudioStatus = 'pending' | 'stale' | 'generating' | 'complete' | 'error';

// One audio chunk for a single sentence, in one voice. Kept on disk so a typo
// fix only re-renders this segment instead of the whole chapter.
export interface ISegment {
  sentenceId: Types.ObjectId;
  audioPath?: string;
  durationSecs?: number;
  audioStatus: AudioStatus;
  audioError?: string;
}

export interface IVoiceTrack {
  voice: string;
  audioPath?: string;
  audioDurationSecs?: number;
  audioStatus: AudioStatus;
  audioError?: string;
  segments: Types.DocumentArray<ISegment & Document>;
}

// An editable, speech-ready sentence — the source of truth for chapter audio.
// Shared across voices (text is the same); each voice renders its own segment.
export interface ISentence {
  _id: Types.ObjectId;
  order: number;
  // The speech-ready text that is actually synthesized (references/acronyms
  // expanded). `display` is the original reviewed text shown to the reader.
  text: string;
  display?: string;
}

export interface IChapter {
  _id: Types.ObjectId;
  title: string;
  startPage: number;
  startChar: number;
  sentences: Types.DocumentArray<ISentence & Document>;
  tracks: Types.DocumentArray<IVoiceTrack & Document>;
}

export interface IOcrPage {
  page: number;
  text: string;
  // The OCR'd, reviewed text rewritten for speech (references/acronyms expanded).
  // What actually gets read; kept alongside `text` so the review UI can diff them.
  readText?: string;
  language: string;
  status: 'pending' | 'processing' | 'complete' | 'error';
  error?: string;
}

export interface IBook extends Document {
  name: string;
  status: BookStatus;
  // Book-wide language (ISO 639-1), detected once from the summary page. Used for
  // speech normalization in place of per-page detection.
  language?: string;
  folderPath: string;
  filePath: string;
  coverImagePath?: string;
  // Pages holding the table of contents / index. The TOC is read from each and
  // the entries merged, so a contents list spanning several pages is supported.
  summaryPages: number[];
  coverPage: number;
  firstPage: number;
  lastPage: number;
  totalPages: number;
  voices: string[];
  chapters: Types.DocumentArray<IChapter & Document>;
  ocrPages: IOcrPage[];
  progress: { current: number; total: number; message: string };
  errorMessage?: string;
  deleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export function trackForVoice(
  chapter: IChapter,
  voice: string
): (IVoiceTrack & Document) | undefined {
  return chapter.tracks.find(t => t.voice === voice);
}

export function freshTracks(voices: string[]) {
  return voices.map(voice => ({ voice, audioStatus: 'pending' as AudioStatus, segments: [] as ISegment[] }));
}

// A track's status derived from its segments (the assembled-chapter readiness).
export function deriveTrackStatus(segments: { audioStatus: AudioStatus }[]): AudioStatus {
  if (segments.length === 0) return 'pending';
  if (segments.some(s => s.audioStatus === 'generating')) return 'generating';
  if (segments.some(s => s.audioStatus === 'error')) return 'error';
  if (segments.some(s => s.audioStatus === 'stale')) return 'stale';
  if (segments.every(s => s.audioStatus === 'complete')) return 'complete';
  return 'pending';
}

// Chapters trimmed for the wire: sentences and per-segment data stay server-side
// (the editor fetches them on demand) to keep sync/update payloads small.
export function serializeChaptersForClient(chapters: IBook['chapters']) {
  return chapters.map(c => ({
    _id: c._id,
    title: c.title,
    startPage: c.startPage,
    startChar: c.startChar,
    tracks: c.tracks.map(t => ({
      voice: t.voice,
      audioPath: t.audioPath,
      audioDurationSecs: t.audioDurationSecs,
      audioStatus: t.audioStatus,
      audioError: t.audioError,
    })),
  }));
}

const SegmentSchema = new Schema<ISegment>(
  {
    sentenceId: { type: Schema.Types.ObjectId, required: true },
    audioPath: { type: String },
    durationSecs: { type: Number },
    audioStatus: {
      type: String,
      enum: ['pending', 'stale', 'generating', 'complete', 'error'],
      default: 'pending',
    },
    audioError: { type: String },
  },
  { _id: false }
);

const VoiceTrackSchema = new Schema<IVoiceTrack>(
  {
    voice: { type: String, required: true },
    audioPath: { type: String },
    audioDurationSecs: { type: Number },
    audioStatus: {
      type: String,
      enum: ['pending', 'stale', 'generating', 'complete', 'error'],
      default: 'pending',
    },
    audioError: { type: String },
    segments: { type: [SegmentSchema], default: [] },
  },
  { _id: false }
);

const SentenceSchema = new Schema<ISentence>({
  order: { type: Number, required: true },
  text: { type: String, default: '' },
  display: { type: String, default: '' },
});

const ChapterSchema = new Schema<IChapter>({
  title: { type: String, required: true },
  startPage: { type: Number, required: true },
  startChar: { type: Number, default: 0 },
  sentences: { type: [SentenceSchema], default: [] },
  tracks: { type: [VoiceTrackSchema], default: [] },
});

const OcrPageSchema = new Schema<IOcrPage>({
  page: { type: Number, required: true },
  text: { type: String, default: '' },
  readText: { type: String },
  language: { type: String, default: 'unknown' },
  status: {
    type: String,
    enum: ['pending', 'processing', 'complete', 'error'],
    default: 'pending',
  },
  error: { type: String },
});

const BookSchema = new Schema<IBook>(
  {
    name: { type: String, default: '' },
    status: {
      type: String,
      enum: [
        'uploading', 'splitting_pages', 'extracting_cover', 'reading_title',
        'ocr_processing', 'detecting_chapters', 'awaiting_chapter_review',
        'generating_audio', 'complete', 'error',
      ],
      default: 'uploading',
    },
    language: { type: String },
    folderPath: { type: String, required: true },
    filePath: { type: String, required: true },
    coverImagePath: { type: String },
    summaryPages: { type: [Number], required: true },
    coverPage: { type: Number, required: true },
    firstPage: { type: Number, required: true },
    lastPage: { type: Number, required: true },
    totalPages: { type: Number, default: 0 },
    chapters: [ChapterSchema],
    ocrPages: [OcrPageSchema],
    progress: {
      current: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
      message: { type: String, default: '' },
    },
    errorMessage: { type: String },
    voices: { type: [String], default: ['chatterbox:pt-BR-FranciscaNeural'] },
    deleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const Book = mongoose.model<IBook>('Book', BookSchema);

export async function migrateLegacyVoices(): Promise<void> {
  const col = mongoose.connection.collection('books');
  const cursor = col.find({ voices: { $exists: false } });

  for await (const b of cursor) {
    const voice: string = b.voice || 'chatterbox:pt-BR-FranciscaNeural';
    const chapters = (b.chapters || []).map((ch: Record<string, unknown>) => {
      if (Array.isArray(ch.tracks)) return ch;
      return {
        ...ch,
        tracks: [{
          voice,
          audioPath: ch.audioPath,
          audioDurationSecs: ch.audioDurationSecs,
          audioStatus: ch.audioStatus || 'pending',
        }],
      };
    });

    await col.updateOne(
      { _id: b._id },
      { $set: { voices: [voice], chapters }, $unset: { voice: '' } }
    );
  }
}

// Older books stored a single `summaryPage`; fold it into the new `summaryPages`
// array so multi-page contents lists are supported uniformly.
export async function migrateSummaryPages(): Promise<void> {
  const col = mongoose.connection.collection('books');
  const cursor = col.find({ summaryPages: { $exists: false } });

  for await (const b of cursor) {
    const page = typeof b.summaryPage === 'number' ? b.summaryPage : 0;
    await col.updateOne(
      { _id: b._id },
      { $set: { summaryPages: page > 0 ? [page] : [] }, $unset: { summaryPage: '' } }
    );
  }
}

export async function migrateSanitizeOcrText(): Promise<void> {
  const col = mongoose.connection.collection('books');
  const cursor = col.find({ 'ocrPages.text': { $regex: /^\s*\{/ } });

  for await (const b of cursor) {
    const ocrPages = (b.ocrPages || []).map((p: Record<string, unknown>) => ({
      ...p,
      text: sanitizePageText(p.text as string),
    }));
    await col.updateOne({ _id: b._id }, { $set: { ocrPages } });
  }
}
