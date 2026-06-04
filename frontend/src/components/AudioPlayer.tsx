import { useState, useRef, useEffect, useCallback } from 'react';
import { Chapter } from '../types';
import { fmtRemaining, trackFor } from '../lib/format';

interface Props {
  bookId: string;
  chapters: Chapter[];
  // Which voice to play. Only chapters whose track for this voice is ready show up.
  voice: string;
  // Reports seconds left to hear across the whole book, kept live as it plays.
  onProgress?: (remaining: number) => void;
}

function fmt(s: number): string {
  if (!isFinite(s) || s < 0) return '0:00';
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}:${m.toString().padStart(2, '0')}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
  }
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}

const POS_KEY  = (id: string) => `br_pos_${id}`;
const DUR_KEY  = (id: string, voice: string) => `br_dur_${id}_${voice}`;

function loadJson<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? '') ?? fallback; }
  catch { return fallback; }
}

export default function AudioPlayer({ bookId, chapters, voice, onProgress }: Props) {
  const audioRef   = useRef<HTMLAudioElement>(null);
  const idxRef     = useRef(0);
  const seekOnLoad = useRef(-1);
  const lastSave   = useRef(0);

  const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
  const [speed, setSpeed] = useState(1);

  const readyChapters = chapters.filter(c => trackFor(c, voice)?.audioStatus === 'complete');

  // Restore saved chapter index
  const [currentIdx, setCurrentIdx] = useState<number>(() => {
    const saved = loadJson<{ chapterIdx: number }>(POS_KEY(bookId), { chapterIdx: 0 });
    return Math.min(saved.chapterIdx, Math.max(0, readyChapters.length - 1));
  });
  const [playing, setPlaying]       = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [speedOpen, setSpeedOpen]   = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration]     = useState(0);
  const [durations, setDurations]   = useState<Record<number, number>>(
    () => loadJson<Record<number, number>>(DUR_KEY(bookId, voice), {})
  );

  // Keep ref in sync for use inside event handlers (avoid stale closures)
  useEffect(() => { idxRef.current = currentIdx; }, [currentIdx]);

  // Switching voice swaps the whole track set: reload its cached durations and
  // clamp the current chapter into the (possibly shorter) ready range.
  useEffect(() => {
    setDurations(loadJson<Record<number, number>>(DUR_KEY(bookId, voice), {}));
    setCurrentIdx(i => Math.min(i, Math.max(0, readyChapters.length - 1)));
  }, [voice]); // eslint-disable-line react-hooks/exhaustive-deps

  const chapter  = readyChapters[currentIdx];
  const audioUrl = chapter
    ? `/api/books/${bookId}/chapters/${chapters.indexOf(chapter)}/audio?voice=${encodeURIComponent(voice)}`
    : null;

  // Save position to localStorage
  const savePos = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    try {
      localStorage.setItem(POS_KEY(bookId), JSON.stringify({
        chapterIdx: idxRef.current,
        time: audio.currentTime,
      }));
    } catch {}
  }, [bookId]);

  // Load new chapter URL + optionally seek to saved position
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !audioUrl) return;
    audio.src = audioUrl;
    audio.playbackRate = speed;
    audio.load();
    setCurrentTime(0);
    setDuration(0);

    // Restore saved seek position for the initial chapter load only
    const saved = loadJson<{ chapterIdx: number; time: number }>(POS_KEY(bookId), { chapterIdx: 0, time: 0 });
    if (saved.chapterIdx === currentIdx && saved.time > 1) {
      seekOnLoad.current = saved.time;
    }

    if (playing) audio.play().catch(() => setPlaying(false));
  }, [audioUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // Audio event listeners
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onPlay    = () => setPlaying(true);
    const onPause   = () => { setPlaying(false); savePos(); };
    const onEnded   = () => {
      if (idxRef.current < readyChapters.length - 1) {
        setCurrentIdx(i => i + 1);
      } else {
        setPlaying(false);
      }
    };
    const onLoaded  = () => {
      const d = audio.duration;
      setDuration(d);
      if (seekOnLoad.current > 0 && seekOnLoad.current < d) {
        audio.currentTime = seekOnLoad.current;
        seekOnLoad.current = -1;
      }
      setDurations(prev => {
        const next = { ...prev, [idxRef.current]: d };
        try { localStorage.setItem(DUR_KEY(bookId, voice), JSON.stringify(next)); } catch {}
        return next;
      });
    };
    const onTimeUpd = () => {
      setCurrentTime(audio.currentTime);
      if (audio.currentTime - lastSave.current >= 5) {
        savePos();
        lastSave.current = audio.currentTime;
      }
    };

    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('loadedmetadata', onLoaded);
    audio.addEventListener('timeupdate', onTimeUpd);
    return () => {
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('loadedmetadata', onLoaded);
      audio.removeEventListener('timeupdate', onTimeUpd);
    };
  }, [bookId, voice, readyChapters.length, savePos]);

  const applySpeed = (next: number) => {
    setSpeed(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
    setSpeedOpen(false);
  };

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) audio.pause();
    else audio.play().catch(() => {});
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    audio.currentTime = ((e.clientX - rect.left) / rect.width) * duration;
  };

  // Jump forward/backward within the current chapter (seconds).
  const skip = (delta: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const max = audio.duration || duration || Infinity;
    audio.currentTime = Math.min(max, Math.max(0, audio.currentTime + delta));
  };

  // Progress metrics from localStorage durations
  const totalDuration  = Object.values(durations).reduce((a, b) => a + b, 0);
  const listenedInPrev = readyChapters
    .slice(0, currentIdx)
    .reduce((acc, _, i) => acc + (durations[i] ?? 0), 0);
  const listenedTotal  = listenedInPrev + currentTime;
  const pctListened    = totalDuration > 0 ? Math.min(100, Math.round((listenedTotal / totalDuration) * 100)) : 0;
  const remaining      = totalDuration > 0 ? totalDuration - listenedTotal : 0;

  // Surface the remaining time to the parent (cover section) as it changes.
  useEffect(() => { onProgress?.(remaining); }, [remaining, onProgress]);

  if (readyChapters.length === 0) return (
    <div className="card text-center text-gray-500 py-8">No audio ready yet.</div>
  );

  const pct = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="card space-y-4">
      <audio ref={audioRef} preload="metadata" />

      {/* Chapter title + time */}
      <div className="flex items-baseline justify-between">
        <p className="text-sm font-medium text-gray-200 truncate flex-1 mr-4">
          <span className="text-gray-500">Chapter {currentIdx + 1} of {readyChapters.length} · </span>
          {chapter?.title ?? '…'}
        </p>
        <span className="text-xs text-gray-500 font-mono shrink-0">
          {fmt(currentTime)} / {fmt(duration)}
        </span>
      </div>

      {/* Scrubber */}
      <div className="progress-bar cursor-pointer" onClick={seek}>
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>

      {/* Controls */}
      <div className="flex items-center justify-center gap-2">
        {/* Previous chapter */}
        <button className="p-1.5 text-gray-300 hover:text-amber-400 transition-colors disabled:opacity-30 disabled:hover:text-gray-300"
          onClick={() => { savePos(); setCurrentIdx(i => Math.max(0, i - 1)); }}
          disabled={currentIdx === 0}
          title="Previous chapter">
          <svg className="w-8 h-8" fill="currentColor" viewBox="0 0 24 24">
            <rect x="4.3" y="4.5" width="2.2" height="15" rx="1" />
            <path d="M18 5.14v13.72a1 1 0 01-1.54.84L7.12 12.84a1 1 0 010-1.68l9.34-6.86A1 1 0 0118 5.14z" />
          </svg>
        </button>

        {/* Back 30 seconds */}
        <button className="p-1.5 text-gray-300 hover:text-amber-400 transition-colors disabled:opacity-30 disabled:hover:text-gray-300"
          onClick={() => skip(-30)}
          title="Back 30 seconds">
          <svg className="w-8 h-8" viewBox="0 0 24 24">
            <path d="M11 4.5a7.5 7.5 0 1 1 -7.5 7.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M11 1.8 L7.8 4.5 L11 7.2 Z" fill="currentColor" />
            <text x="12" y="15.5" textAnchor="middle" fontSize="8" fontWeight="700" fill="currentColor">30</text>
          </svg>
        </button>

        {/* Play / Pause */}
        <button
          className="text-gray-100 hover:text-amber-400 transition-colors"
          onClick={togglePlay}>
          {playing
            ? <svg className="w-14 h-14" fill="currentColor" viewBox="0 0 24 24"><path fillRule="evenodd" d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12zM9 8.25a.75.75 0 00-.75.75v6c0 .414.336.75.75.75h.75a.75.75 0 00.75-.75V9a.75.75 0 00-.75-.75H9zm5.25 0a.75.75 0 00-.75.75v6c0 .414.336.75.75.75H15a.75.75 0 00.75-.75V9a.75.75 0 00-.75-.75h-.75z" clipRule="evenodd" /></svg>
            : <svg className="w-14 h-14" fill="currentColor" viewBox="0 0 24 24"><path fillRule="evenodd" d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12zm14.024-.983a1.125 1.125 0 010 1.966l-5.603 3.113A1.125 1.125 0 019 15.113V8.887c0-.857.921-1.4 1.671-.983l5.603 3.113z" clipRule="evenodd" /></svg>
          }
        </button>

        {/* Forward 30 seconds */}
        <button className="p-1.5 text-gray-300 hover:text-amber-400 transition-colors disabled:opacity-30 disabled:hover:text-gray-300"
          onClick={() => skip(30)}
          title="Forward 30 seconds">
          <svg className="w-8 h-8" viewBox="0 0 24 24">
            <path d="M13 4.5a7.5 7.5 0 1 0 7.5 7.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M13 1.8 L16.2 4.5 L13 7.2 Z" fill="currentColor" />
            <text x="12" y="15.5" textAnchor="middle" fontSize="8" fontWeight="700" fill="currentColor">30</text>
          </svg>
        </button>

        {/* Next chapter */}
        <button className="p-1.5 text-gray-300 hover:text-amber-400 transition-colors disabled:opacity-30 disabled:hover:text-gray-300"
          onClick={() => { savePos(); setCurrentIdx(i => Math.min(readyChapters.length - 1, i + 1)); }}
          disabled={currentIdx >= readyChapters.length - 1}
          title="Next chapter">
          <svg className="w-8 h-8" fill="currentColor" viewBox="0 0 24 24">
            <path d="M6 5.14v13.72a1 1 0 001.54.84l9.34-6.86a1 1 0 000-1.68L7.54 4.3A1 1 0 006 5.14z" />
            <rect x="17.5" y="4.5" width="2.2" height="15" rx="1" />
          </svg>
        </button>

      </div>

      {/* Speed + Chapters */}
      <div className="flex items-start justify-center gap-12">
        <button
          className="flex flex-col items-center gap-1 text-gray-200 hover:text-amber-400 transition-colors"
          onClick={() => setSpeedOpen(true)}
          title="Playback speed"
        >
          <span className="h-6 flex items-center text-sm font-semibold font-mono">{speed}x</span>
          <span className="text-[11px] text-gray-500">Speed</span>
        </button>

        <button
          className="flex flex-col items-center gap-1 text-gray-200 hover:text-amber-400 transition-colors"
          onClick={() => setPickerOpen(true)}
          title="Chapters"
        >
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75zm0 5.25h.007v.008H3.75V12zm0 5.25h.007v.008H3.75v-.008z" />
          </svg>
          <span className="text-[11px] text-gray-500">Chapters</span>
        </button>
      </div>

      {/* Listening progress — stored in browser only */}
      {totalDuration > 0 && (
        <div className="flex items-center justify-between text-xs text-gray-500 pt-1 border-t border-gray-800">
          <span>{pctListened}% listened</span>
          {remaining > 60 && <span className="text-amber-400">{fmtRemaining(remaining)} left</span>}
        </div>
      )}

      {/* Chapter picker popup */}
      {pickerOpen && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
          onClick={e => e.target === e.currentTarget && setPickerOpen(false)}
        >
          <div className="bg-gray-900 rounded-2xl border border-gray-700 w-full max-w-sm shadow-2xl flex flex-col max-h-[80vh]">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800 shrink-0">
              <h2 className="font-semibold text-gray-100">Chapters</h2>
              <button className="text-gray-500 hover:text-gray-300 text-xl leading-none" onClick={() => setPickerOpen(false)}>×</button>
            </div>
            <div className="p-2 overflow-y-auto">
              {readyChapters.map((c, i) => (
                <button
                  key={c._id}
                  className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-colors ${
                    i === currentIdx ? 'bg-amber-600/20 text-amber-400' : 'text-gray-300 hover:bg-gray-800'
                  }`}
                  onClick={() => { setCurrentIdx(i); setPlaying(true); setPickerOpen(false); }}
                >
                  <span className="text-gray-500 mr-2">{i + 1}.</span>{c.title}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Speed picker popup */}
      {speedOpen && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
          onClick={e => e.target === e.currentTarget && setSpeedOpen(false)}
        >
          <div className="bg-gray-900 rounded-2xl border border-gray-700 w-full max-w-xs shadow-2xl flex flex-col">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800 shrink-0">
              <h2 className="font-semibold text-gray-100">Playback speed</h2>
              <button className="text-gray-500 hover:text-gray-300 text-xl leading-none" onClick={() => setSpeedOpen(false)}>×</button>
            </div>
            <div className="p-2">
              {SPEEDS.map(s => (
                <button
                  key={s}
                  className={`w-full text-left px-3 py-2.5 rounded-lg text-sm font-mono transition-colors ${
                    s === speed ? 'bg-amber-600/20 text-amber-400' : 'text-gray-300 hover:bg-gray-800'
                  }`}
                  onClick={() => applySpeed(s)}
                >
                  {s}x{s === 1 && <span className="ml-2 text-gray-500 font-sans">Normal</span>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
