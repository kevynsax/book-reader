import { useState, useRef, useEffect, useCallback } from 'react';
import { Chapter, TimelineEntry } from '../types';
import { fmtRemaining, trackFor } from '../lib/format';

// Index of the last sentence whose start time has passed (the active line).
function activeLineAt(timeline: TimelineEntry[], t: number): number {
  let lo = 0, hi = timeline.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (timeline[mid].start <= t) { idx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return idx;
}

interface Props {
  bookId: string;
  chapters: Chapter[];
  voice: string;
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

  const [currentIdx, setCurrentIdx] = useState<number>(() => {
    const saved = loadJson<{ chapterIdx: number }>(POS_KEY(bookId), { chapterIdx: 0 });
    return Math.min(saved.chapterIdx, Math.max(0, readyChapters.length - 1));
  });
  const [playing, setPlaying]       = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [speedOpen, setSpeedOpen]   = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration]     = useState(0);

  // Read-along timeline (sentence start/end times). timelineRef is read inside
  // the timeupdate handler to avoid a stale closure.
  const [timeline, setTimeline]   = useState<TimelineEntry[]>([]);
  const timelineRef               = useRef<TimelineEntry[]>([]);
  const [activeLine, setActiveLine] = useState(-1);

  useEffect(() => { idxRef.current = currentIdx; }, [currentIdx]);

  useEffect(() => {
    setCurrentIdx(i => Math.min(i, Math.max(0, readyChapters.length - 1)));
  }, [voice]);

  const chapter    = readyChapters[currentIdx];
  const chapterIdx = chapter ? chapters.indexOf(chapter) : -1;
  const audioUrl   = chapter
    ? `/api/books/${bookId}/chapters/${chapterIdx}/audio?voice=${encodeURIComponent(voice)}`
    : null;

  // Load the read-along timeline for the current chapter/voice (404 => none).
  useEffect(() => {
    setTimeline([]); timelineRef.current = []; setActiveLine(-1);
    if (chapterIdx < 0) return;
    let cancelled = false;
    fetch(`/api/books/${bookId}/chapters/${chapterIdx}/timeline?voice=${encodeURIComponent(voice)}`)
      .then(r => (r.ok ? r.json() : []))
      .then((data: TimelineEntry[]) => {
        if (cancelled) return;
        const t = Array.isArray(data) ? data : [];
        timelineRef.current = t;
        setTimeline(t);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [bookId, chapterIdx, voice]);

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

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !audioUrl) return;
    audio.src = audioUrl;
    audio.playbackRate = speed;
    audio.load();
    setCurrentTime(0);
    setDuration(0);

    const saved = loadJson<{ chapterIdx: number; time: number }>(POS_KEY(bookId), { chapterIdx: 0, time: 0 });
    if (saved.chapterIdx === currentIdx && saved.time > 1) {
      seekOnLoad.current = saved.time;
    }

    if (playing) audio.play().catch(() => setPlaying(false));
  }, [audioUrl]);

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
    };
    const onTimeUpd = () => {
      setCurrentTime(audio.currentTime);
      if (timelineRef.current.length) {
        const idx = activeLineAt(timelineRef.current, audio.currentTime);
        setActiveLine(prev => (prev === idx ? prev : idx));
      }
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

  const seekTo = (time: number) => {
    const audio = audioRef.current;
    if (audio) audio.currentTime = Math.max(0, time);
  };

  const skip = (delta: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const max = audio.duration || duration || Infinity;
    audio.currentTime = Math.min(max, Math.max(0, audio.currentTime + delta));
  };

  const chapterSecs    = readyChapters.map(c => trackFor(c, voice)?.audioDurationSecs ?? 0);
  const totalDuration  = chapterSecs.reduce((a, b) => a + b, 0);
  const listenedInPrev = chapterSecs.slice(0, currentIdx).reduce((a, b) => a + b, 0);
  const listenedTotal  = listenedInPrev + currentTime;
  const pctListened    = totalDuration > 0 ? Math.min(100, Math.round((listenedTotal / totalDuration) * 100)) : 0;
  const remaining      = totalDuration > 0 ? Math.max(0, totalDuration - listenedTotal) : 0;

  useEffect(() => { onProgress?.(remaining); }, [remaining, onProgress]);

  if (readyChapters.length === 0) return (
    <div className="card text-center text-gray-500 py-8">No audio ready yet.</div>
  );

  const pct = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="card space-y-4">
      <audio ref={audioRef} preload="metadata" />

      <div className="flex items-baseline justify-between">
        <p className="text-sm font-medium text-gray-200 truncate flex-1 mr-4">
          <span className="text-gray-500">Chapter {currentIdx + 1} of {readyChapters.length} · </span>
          {chapter?.title ?? '…'}
        </p>
        <span className="text-xs text-gray-500 font-mono shrink-0">
          {fmt(currentTime)} / {fmt(duration)}
        </span>
      </div>

      <div className="progress-bar cursor-pointer" onClick={seek}>
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>

      {timeline.length > 0 && (
        <div className="min-h-[4rem] flex flex-col items-center justify-center text-center gap-1 px-1">
          <p
            className="text-base sm:text-lg text-gray-100 leading-snug cursor-pointer"
            onClick={() => seekTo((activeLine >= 0 ? timeline[activeLine] : timeline[0]).start)}
            title="Replay this line"
          >
            {(activeLine >= 0 ? timeline[activeLine] : timeline[0]).text}
          </p>
          {activeLine + 1 < timeline.length && (
            <p
              className="text-xs text-gray-600 leading-snug line-clamp-1 cursor-pointer hover:text-gray-400"
              onClick={() => seekTo(timeline[activeLine + 1].start)}
              title="Skip ahead"
            >
              {timeline[activeLine + 1].text}
            </p>
          )}
        </div>
      )}

      <div className="flex items-center justify-center gap-2">
        <button className="p-1.5 text-gray-300 hover:text-amber-400 transition-colors disabled:opacity-30 disabled:hover:text-gray-300"
          onClick={() => { savePos(); setCurrentIdx(i => Math.max(0, i - 1)); }}
          disabled={currentIdx === 0}
          title="Previous chapter">
          <svg className="w-8 h-8" fill="currentColor" viewBox="0 0 24 24">
            <rect x="4.3" y="4.5" width="2.2" height="15" rx="1" />
            <path d="M18 5.14v13.72a1 1 0 01-1.54.84L7.12 12.84a1 1 0 010-1.68l9.34-6.86A1 1 0 0118 5.14z" />
          </svg>
        </button>

        <button className="p-1.5 text-gray-300 hover:text-amber-400 transition-colors disabled:opacity-30 disabled:hover:text-gray-300"
          onClick={() => skip(-30)}
          title="Back 30 seconds">
          <svg className="w-8 h-8" viewBox="0 0 24 24">
            <path d="M11 4.5a7.5 7.5 0 1 1 -7.5 7.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M11 1.8 L7.8 4.5 L11 7.2 Z" fill="currentColor" />
            <text x="12" y="15.5" textAnchor="middle" fontSize="8" fontWeight="700" fill="currentColor">30</text>
          </svg>
        </button>

        <button
          className="text-gray-100 hover:text-amber-400 transition-colors"
          onClick={togglePlay}>
          {playing
            ? <svg className="w-14 h-14" fill="currentColor" viewBox="0 0 24 24"><path fillRule="evenodd" d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12zM9 8.25a.75.75 0 00-.75.75v6c0 .414.336.75.75.75h.75a.75.75 0 00.75-.75V9a.75.75 0 00-.75-.75H9zm5.25 0a.75.75 0 00-.75.75v6c0 .414.336.75.75.75H15a.75.75 0 00.75-.75V9a.75.75 0 00-.75-.75h-.75z" clipRule="evenodd" /></svg>
            : <svg className="w-14 h-14" fill="currentColor" viewBox="0 0 24 24"><path fillRule="evenodd" d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12zm14.024-.983a1.125 1.125 0 010 1.966l-5.603 3.113A1.125 1.125 0 019 15.113V8.887c0-.857.921-1.4 1.671-.983l5.603 3.113z" clipRule="evenodd" /></svg>
          }
        </button>

        <button className="p-1.5 text-gray-300 hover:text-amber-400 transition-colors disabled:opacity-30 disabled:hover:text-gray-300"
          onClick={() => skip(30)}
          title="Forward 30 seconds">
          <svg className="w-8 h-8" viewBox="0 0 24 24">
            <path d="M13 4.5a7.5 7.5 0 1 0 7.5 7.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M13 1.8 L16.2 4.5 L13 7.2 Z" fill="currentColor" />
            <text x="12" y="15.5" textAnchor="middle" fontSize="8" fontWeight="700" fill="currentColor">30</text>
          </svg>
        </button>

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

      {totalDuration > 0 && (
        <div className="flex items-center justify-between text-xs text-gray-500 pt-1 border-t border-gray-800">
          <span>{pctListened}% listened</span>
          {remaining > 60 && <span>{fmtRemaining(remaining)} left</span>}
        </div>
      )}

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
