import { useRef } from 'react';
import { UploadFormData } from '../../types';

interface Props {
  data: UploadFormData;
  onChange: (patch: Partial<UploadFormData>) => void;
  onNext: () => void;
}

export default function Step1BookInfo({ data, onChange, onNext }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);

  const canProceed = data.file !== null;

  return (
    <div className="space-y-5">
      <div>
        <label className="label">PDF file</label>
        <div
          className="border-2 border-dashed border-gray-700 rounded-lg p-8 text-center cursor-pointer hover:border-amber-600 transition-colors"
          onClick={() => fileRef.current?.click()}
          onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f?.type === 'application/pdf') onChange({ file: f }); }}
          onDragOver={e => e.preventDefault()}
        >
          {data.file ? (
            <div>
              <svg className="w-8 h-8 text-amber-500 mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <p className="text-gray-300 font-medium">{data.file.name}</p>
              <p className="text-gray-500 text-sm">{(data.file.size / 1024 / 1024).toFixed(1)} MB</p>
            </div>
          ) : (
            <div>
              <svg className="w-8 h-8 text-gray-600 mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              <p className="text-gray-400">Drop a PDF here or <span className="text-amber-500">browse</span></p>
              <p className="text-gray-600 text-sm mt-1">PDF only</p>
            </div>
          )}
        </div>
        <input ref={fileRef} type="file" accept="application/pdf" className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) onChange({ file: f }); }} />
      </div>

      <button className="btn-primary w-full justify-center" disabled={!canProceed} onClick={onNext}>
        Next: Select pages
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </button>
    </div>
  );
}
