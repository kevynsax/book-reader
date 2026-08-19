import { useEffect, useState } from 'react';
import { useDispatch } from 'react-redux';
import { AppDispatch } from '../store';
import { updateVoiceRoles } from '../store/booksSlice';
import { Book, SentenceRole } from '../types';
import { useVoiceLabel } from '../hooks/useVoiceLabel';
import VoicePicker from './VoicePicker';
import { t } from '../i18n';

const ROLES: { role: SentenceRole; label: string }[] = [
  { role: 'title',        label: t('Title') },
  { role: 'quoteMale',    label: t('Masculine quote') },
  { role: 'quoteFemale',  label: t('Feminine quote') },
  { role: 'quoteChild',   label: t('Child quote') },
  { role: 'quoteDefault', label: t('Other quotes') },
];

type Roles = Record<string, Partial<Record<SentenceRole, string>>>;

const roleAt = (src: Roles | undefined, voice: string, role: SentenceRole) => src?.[voice]?.[role] ?? '';

// Per book voice, pick who reads titles and each flavour of quote — the server
// stales the affected audio and re-renders the alternative takes on save.
export default function VoiceRolesSection({ book }: { book: Book }) {
  const dispatch = useDispatch<AppDispatch>();
  const label = useVoiceLabel(book.voices);
  const [draft, setDraft] = useState<Roles>(() => book.voiceRoles ?? {});
  const [saving, setSaving] = useState(false);

  useEffect(() => { setDraft(book.voiceRoles ?? {}); }, [book._id]);

  const dirty = book.voices.some(v =>
    ROLES.some(r => roleAt(draft, v, r.role) !== roleAt(book.voiceRoles, v, r.role)));

  const save = async () => {
    setSaving(true);
    try {
      const voiceRoles: Roles = {};
      for (const v of book.voices) {
        const entry: Partial<Record<SentenceRole, string>> = {};
        for (const { role } of ROLES) {
          const val = roleAt(draft, v, role);
          if (val) entry[role] = val;
        }
        if (Object.keys(entry).length) voiceRoles[v] = entry;
      }
      await dispatch(updateVoiceRoles({ bookId: book._id, voiceRoles })).unwrap();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (!book.voices?.length) return null;

  return (
    <div className="card space-y-4">
      <div>
        <h3 className="font-semibold text-gray-100">{t('Voices by role')}</h3>
        <p className="text-xs text-gray-500 mt-0.5">{t('Choose who reads titles and quotes; empty keeps the narrator.')}</p>
      </div>

      {book.voices.map(v => (
        <div key={v} className="rounded-lg border border-gray-800 bg-gray-900/40 px-3 py-2.5 space-y-1.5">
          <p className="text-xs font-medium text-gray-300">{label(v)}</p>
          {ROLES.map(({ role, label: roleLabel }) => (
            <div key={role} className="flex items-center gap-2">
              <span className="label mb-0 w-36 shrink-0">{roleLabel}</span>
              <VoicePicker
                className="max-w-[14rem]"
                value={roleAt(draft, v, role)}
                disabled={saving}
                emptyLabel={t('Same voice')}
                onChange={val => setDraft(d => ({ ...d, [v]: { ...d[v], [role]: val } }))}
              />
            </div>
          ))}
        </div>
      ))}

      <div className="flex justify-end">
        <button className="btn-primary text-sm" disabled={!dirty || saving} onClick={save}>
          {saving ? t('Saving…') : t('Save')}
        </button>
      </div>
    </div>
  );
}
