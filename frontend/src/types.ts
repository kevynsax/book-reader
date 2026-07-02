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

export interface VoiceTrack {
  voice: string;
  audioPath?: string;
  audioDurationSecs?: number;
  audioStatus: AudioStatus;
  audioError?: string;
}

// Read-along: a spoken sentence and its start/end time (seconds) in the chapter audio.
export interface TimelineEntry {
  text: string;
  start: number;
  end: number;
}

// An editable sentence with its audio segment status, for the sentence editor.
export interface EditableSentence {
  _id: string;
  order: number;
  text: string;
  audioStatus: AudioStatus;
  audioError?: string;
}

// A selectable TTS engine/model returned by GET /api/models.
export interface TtsModel {
  id: string;
  label: string;
}

export interface TtsServer {
  id: string;
  label: string;
  url: string;
  online: boolean;
  state?: string;
  activeModel?: string;
  backend?: string;
  models: { id: string; label: string }[];
}

export interface Chapter {
  _id: string;
  title: string;
  startPage: number;
  startChar: number;
  tracks: VoiceTrack[];
}

export interface OcrPage {
  page: number;
  text: string;
  readText?: string;
  language: string;
  status: 'pending' | 'processing' | 'complete' | 'error';
  error?: string;
}

export interface Progress {
  current: number;
  total: number;
  message: string;
}

export interface VoiceProgress extends Progress {
  voice: string;
  chapterIdx: number;
}

export interface Book {
  _id: string;
  name: string;
  status: BookStatus;
  folderPath: string;
  filePath: string;
  coverImagePath?: string;
  summaryPages: number[];
  coverPage: number;
  firstPage: number;
  lastPage: number;
  totalPages: number;
  voices: string[];
  chapters: Chapter[];
  ocrPages: OcrPage[];
  progress: Progress;
  // Transient (socket-only, never persisted): set while a chapter's sentences are
  // being split for TTS, cleared (null) when done. Drives a separate progress bar.
  splitProgress?: Progress | null;
  // Transient (socket-only): live segment progress per voice — several voices
  // can render concurrently (one lane per TTS model), each with its own bar.
  voiceProgress?: Record<string, VoiceProgress>;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  coverVersion?: number;
}

export interface UploadFormData {
  name: string;
  file: File | null;
  summaryPages: number[];
  coverPage: number;
  firstPage: number;
  lastPage: number;
  voice: string;
}
