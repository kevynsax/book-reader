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

export interface IVoiceTrack {
  voice: string;
  audioPath?: string;
  audioDurationSecs?: number;
  audioStatus: AudioStatus;
}

export interface IChapter {
  _id: Types.ObjectId;
  title: string;
  startPage: number;
  startChar: number;
  tracks: Types.DocumentArray<IVoiceTrack & Document>;
}

export interface IOcrPage {
  page: number;
  text: string;
  language: string;
  status: 'pending' | 'processing' | 'complete' | 'error';
}

export interface IBook extends Document {
  name: string;
  status: BookStatus;
  folderPath: string;
  filePath: string;
  coverImagePath?: string;
  summaryPage: number;
  coverPage: number;
  firstPage: number;
  lastPage: number;
  totalPages: number;
  voices: string[];
  chapters: Types.DocumentArray<IChapter & Document>;
  ocrPages: IOcrPage[];
  progress: { current: number; total: number; message: string };
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
}

export function trackForVoice(
  chapter: IChapter,
  voice: string
): (IVoiceTrack & Document) | undefined {
  return chapter.tracks.find(t => t.voice === voice);
}

export function freshTracks(voices: string[]): IVoiceTrack[] {
  return voices.map(voice => ({ voice, audioStatus: 'pending' as AudioStatus }));
}

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
  },
  { _id: false }
);

const ChapterSchema = new Schema<IChapter>({
  title: { type: String, required: true },
  startPage: { type: Number, required: true },
  startChar: { type: Number, default: 0 },
  tracks: { type: [VoiceTrackSchema], default: [] },
});

const OcrPageSchema = new Schema<IOcrPage>({
  page: { type: Number, required: true },
  text: { type: String, default: '' },
  language: { type: String, default: 'unknown' },
  status: {
    type: String,
    enum: ['pending', 'processing', 'complete', 'error'],
    default: 'pending',
  },
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
    folderPath: { type: String, required: true },
    filePath: { type: String, required: true },
    coverImagePath: { type: String },
    summaryPage: { type: Number, required: true },
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
    voices: { type: [String], default: ['pf_dora'] },
  },
  { timestamps: true }
);

export const Book = mongoose.model<IBook>('Book', BookSchema);

export async function migrateLegacyVoices(): Promise<void> {
  const col = mongoose.connection.collection('books');
  const cursor = col.find({ voices: { $exists: false } });

  for await (const b of cursor) {
    const voice: string = b.voice || 'pf_dora';
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
