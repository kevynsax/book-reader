import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { RootState } from '../store';
import { requestBook } from '../hooks/useWebSocket';
import { bookVoices, fmtRemaining, hasPlayableAudio, trackFor } from '../lib/format';
import AudioPlayer from '../components/AudioPlayer';
import VoiceManager from '../components/VoiceManager';
import SentenceEditor from '../components/SentenceEditor';

const VOICE_KEY = (id: string) => `br_voice_${id}`;

export default function PlayerPage() {
  const { id }   = useParams<{ id: string }>();
  const navigate = useNavigate();
  const book     = useSelector((s: RootState) => s.books.books.find(b => b._id === id));
  const [remaining, setRemaining] = useState(0);
  const [chapterIdx, setChapterIdx] = useState(-1);
  const [showEditor, setShowEditor] = useState(false);
  const [activeVoice, setActiveVoice] = useState<string>(() =>
    (id && localStorage.getItem(VOICE_KEY(id))) || ''
  );

  useEffect(() => { if (id) requestBook(id); }, [id]);

  const voices = book ? bookVoices(book) : [];
  useEffect(() => {
    if (voices.length === 0) return;
    if (!voices.includes(activeVoice)) setActiveVoice(voices[0]);
  }, [voices.join(','), activeVoice]);

  const selectVoice = (v: string) => {
    setActiveVoice(v);
    if (id) { try { localStorage.setItem(VOICE_KEY(id), v); } catch { } }
  };

  // Allow the player while audio is still generating, as long as at least one
  // chapter is ready; only bounce back to editing when there's nothing to play.
  const playable = book ? hasPlayableAudio(book) : false;
  useEffect(() => {
    if (book && book.status !== 'complete' && !playable) {
      navigate(`/books/${id}/edit`, { replace: true });
    }
  }, [book?.status, playable, id, navigate]);

  if (!book) {
    return <div className="min-h-screen flex items-center justify-center"><p className="text-gray-500">Loading…</p></div>;
  }

  const generating = book.status === 'generating_audio';
  const readyCount = book.chapters.filter(c => trackFor(c, activeVoice)?.audioStatus === 'complete').length;

  return (
    <div className="min-h-screen">
      <header className="border-b border-gray-800 bg-gray-900/50 backdrop-blur sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center gap-4">
          <button className="flex items-center gap-2 text-gray-500 hover:text-gray-300 transition-colors flex-1 min-w-0" onClick={() => navigate('/')}>
            <svg className="w-5 h-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            <span className="text-lg font-semibold">Library</span>
          </button>
          <button className="btn-secondary text-sm" onClick={() => navigate(`/books/${book._id}/edit`)}>Edit</button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-6 space-y-5">

        <div className="card flex gap-5 items-start">
          <div className="w-36 aspect-[2/3] rounded-lg overflow-hidden bg-gray-800 flex items-center justify-center shrink-0">
            <img
              key={book.coverVersion ?? 0}
              src={`/api/books/${book._id}/cover?v=${book.coverVersion ?? 0}`}
              alt="Cover"
              className="w-full h-full object-cover"
              onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
            />
          </div>
          <div className="space-y-2 text-sm text-gray-400 min-w-0 flex-1">
            <p className="text-gray-200 font-medium text-base truncate">{book.name || 'Untitled'}</p>
            {book.totalPages > 0 && <p>{book.totalPages} pages</p>}
            <VoiceManager book={book} activeVoice={activeVoice} onSelectVoice={selectVoice} editable />
            {remaining > 60 && (
              <p className="pt-1 text-gray-400">{fmtRemaining(remaining)} left</p>
            )}
          </div>
        </div>

        {generating && (
          <button
            className="w-full flex items-center justify-between gap-3 rounded-lg border border-amber-700/60 bg-amber-950/20 px-4 py-2.5 text-sm hover:bg-amber-950/40 transition-colors"
            onClick={() => navigate(`/books/${book._id}/edit`)}
          >
            <span className="flex items-center gap-2 text-amber-300 min-w-0">
              <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shrink-0" />
              <span className="truncate">Generating audio · {readyCount}/{book.chapters.length} chapters ready</span>
            </span>
            <span className="text-amber-400/80 shrink-0">View progress →</span>
          </button>
        )}

        <AudioPlayer
          bookId={book._id}
          chapters={book.chapters}
          voice={activeVoice}
          onProgress={setRemaining}
          onChapterChange={setChapterIdx}
        />

        {chapterIdx >= 0 && (
          <div className="space-y-3">
            <button
              className="btn-secondary w-full justify-center text-sm"
              onClick={() => setShowEditor(v => !v)}
            >
              {showEditor ? 'Hide sentence editor' : 'Edit sentences in this chapter'}
            </button>
            {showEditor && (
              <SentenceEditor bookId={book._id} chapterIdx={chapterIdx} voice={activeVoice} />
            )}
          </div>
        )}

      </main>
    </div>
  );
}
