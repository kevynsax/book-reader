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
  language: string;
  status: 'pending' | 'processing' | 'complete' | 'error';
}

export interface Progress {
  current: number;
  total: number;
  message: string;
}

export interface Book {
  _id: string;
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
  chapters: Chapter[];
  ocrPages: OcrPage[];
  progress: Progress;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  coverVersion?: number;
}

export interface UploadFormData {
  name: string;
  file: File | null;
  summaryPage: number;
  coverPage: number;
  firstPage: number;
  lastPage: number;
  voice: string;
}
