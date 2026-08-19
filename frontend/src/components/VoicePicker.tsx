import { useMemo } from 'react';
import { useVoiceNames } from '../hooks/useVoiceLabel';

interface Props {
  value: string;
  onChange: (v: string) => void;
  emptyLabel: string;
  className?: string;
  disabled?: boolean;
  title?: string;
}

// One dropdown offering every voice the fleet can speak, grouped by engine,
// plus an "unset" first option whose meaning the caller names.
export default function VoicePicker({ value, onChange, emptyLabel, className, disabled, title }: Props) {
  const voiceNames = useVoiceNames();
  const voiceOptions = useMemo(
    () => Object.entries(voiceNames)
      .map(([engine, byId]) => ({
        engine,
        voices: Object.entries(byId)
          .map(([bare, name]) => ({ value: `${engine}:${bare}`, name }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.engine.localeCompare(b.engine)),
    [voiceNames],
  );

  return (
    <select
      className={`input text-[11px] py-1 px-1.5${className ? ` ${className}` : ''}`}
      value={value}
      disabled={disabled}
      onChange={e => onChange(e.target.value)}
      title={title}
    >
      <option value="">{emptyLabel}</option>
      {voiceOptions.map(g => (
        <optgroup key={g.engine} label={g.engine}>
          {g.voices.map(o => <option key={o.value} value={o.value}>{o.name}</option>)}
        </optgroup>
      ))}
    </select>
  );
}
