import { useState } from 'react';
import { useDispatch } from 'react-redux';
import { AppDispatch } from '../store';
import { addVoice, removeVoice, regenerateVoice } from '../store/booksSlice';
import { Book } from '../types';
import { bookVoices, friendlyVoice, chapterStatus } from '../lib/format';
import GenerateVoiceModal from './GenerateVoiceModal';
import ConfirmDialog from './ConfirmDialog';

interface Props {
  book: Book;
  activeVoice?: string;
  onSelectVoice?: (voice: string) => void;
  editable?: boolean;
  allowModify?: boolean;
}

function isVoiceGenerating(book: Book, voice: string): boolean {
  return book.chapters.some(c => {
    const s = chapterStatus(c, [voice]);
    return s === 'generating' || s === 'pending' || s === 'stale';
  });
}

export default function VoiceManager({ book, activeVoice, onSelectVoice, editable, allowModify }: Props) {
  const dispatch = useDispatch<AppDispatch>();
  const [showAdd, setShowAdd] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState<string | null>(null);
  const voices = bookVoices(book);
  const selectable = !!onSelectVoice;

  const handleRemove = (e: React.MouseEvent, voice: string) => {
    e.stopPropagation();
    if (voices.length <= 1) return;
    setRemoving(voice);
  };

  const handleRegenerate = (e: React.MouseEvent, voice: string) => {
    e.stopPropagation();
    setRegenerating(voice);
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
              {editable && allowModify && !generating && (
                <button
                  className="text-gray-500 hover:text-amber-400 leading-none"
                  onClick={e => handleRegenerate(e, voice)}
                  title="Regenerate this voice"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                </button>
              )}
              {editable && allowModify && voices.length > 1 && (
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
        <GenerateVoiceModal
          bookId={book._id}
          exclude={voices}
          onConfirm={voices => { dispatch(addVoice({ bookId: book._id, voice: voices })); setShowAdd(false); }}
          onClose={() => setShowAdd(false)}
        />
      )}

      {removing && (
        <ConfirmDialog
          title="Remove voice?"
          message={`The ${friendlyVoice(removing)} narration and its audio will be deleted.`}
          confirmLabel="Remove"
          danger
          onConfirm={() => { dispatch(removeVoice({ bookId: book._id, voice: removing })); setRemoving(null); }}
          onClose={() => setRemoving(null)}
        />
      )}

      {regenerating && (
        <ConfirmDialog
          title="Regenerate voice?"
          message={`The ${friendlyVoice(regenerating)} narration will be re-rendered from scratch for every chapter.`}
          confirmLabel="Regenerate"
          onConfirm={() => { dispatch(regenerateVoice({ bookId: book._id, voice: regenerating })); setRegenerating(null); }}
          onClose={() => setRegenerating(null)}
        />
      )}
    </div>
  );
}
