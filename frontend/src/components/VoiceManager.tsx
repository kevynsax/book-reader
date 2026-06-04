import { useState } from 'react';
import { useDispatch } from 'react-redux';
import { AppDispatch } from '../store';
import { addVoice, removeVoice } from '../store/booksSlice';
import { Book } from '../types';
import { bookVoices, friendlyVoice, chapterStatus } from '../lib/format';
import AddVoiceModal from './AddVoiceModal';

interface Props {
  book: Book;
  // Player mode: highlight the active voice and let the user switch playback to another.
  activeVoice?: string;
  onSelectVoice?: (voice: string) => void;
  // Show the add/remove controls. Off during the import flow (before audio exists).
  editable?: boolean;
}

// Is this voice still rendering across the book's chapters?
function isVoiceGenerating(book: Book, voice: string): boolean {
  return book.chapters.some(c => {
    const s = chapterStatus(c, [voice]);
    return s === 'generating' || s === 'pending' || s === 'stale';
  });
}

export default function VoiceManager({ book, activeVoice, onSelectVoice, editable }: Props) {
  const dispatch = useDispatch<AppDispatch>();
  const [showAdd, setShowAdd] = useState(false);
  const voices = bookVoices(book);
  const selectable = !!onSelectVoice;

  const handleRemove = (e: React.MouseEvent, voice: string) => {
    e.stopPropagation();
    if (voices.length <= 1) return;
    if (!confirm(`Remove the ${friendlyVoice(voice)} voice and its audio?`)) return;
    dispatch(removeVoice({ bookId: book._id, voice }));
  };

  return (
    <div className="space-y-1.5">
      <p className="text-xs text-gray-500">Voices</p>
      <div className="flex flex-wrap items-center gap-2">
        {voices.map(voice => {
          const active = selectable && voice === activeVoice;
          const generating = isVoiceGenerating(book, voice);
          return (
            <span
              key={voice}
              className={`inline-flex items-center gap-1.5 rounded-full pl-3 pr-2 py-1 text-sm border transition-colors ${
                active
                  ? 'border-amber-500 bg-amber-600/20 text-amber-300'
                  : 'border-gray-700 bg-gray-800 text-gray-300'
              } ${selectable ? 'cursor-pointer hover:border-gray-500' : ''}`}
              onClick={() => onSelectVoice?.(voice)}
            >
              {generating && (
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" title="Generating…" />
              )}
              {friendlyVoice(voice)}
              {editable && voices.length > 1 && (
                <button
                  className="text-gray-500 hover:text-red-400 leading-none text-base"
                  onClick={e => handleRemove(e, voice)}
                  title="Remove voice"
                >
                  ×
                </button>
              )}
            </span>
          );
        })}

        {editable && (
          <button
            className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm border border-dashed border-gray-600 text-gray-400 hover:border-amber-500 hover:text-amber-400 transition-colors"
            onClick={() => setShowAdd(true)}
          >
            <span className="text-base leading-none">+</span> Add
          </button>
        )}
      </div>

      {showAdd && (
        <AddVoiceModal
          existing={voices}
          onAdd={voice => { dispatch(addVoice({ bookId: book._id, voice })); setShowAdd(false); }}
          onClose={() => setShowAdd(false)}
        />
      )}
    </div>
  );
}
