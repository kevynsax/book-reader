import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { requestBook } from '../../hooks/useWebSocket';
import { uploadBook } from '../../api/booksApi';
import { UploadFormData } from '../../types';
import { t } from '../../i18n';
import Step1BookInfo from './Step1BookInfo';
import Step2PageSelection from './Step2PageSelection';

const INIT: UploadFormData = {
  name: '',
  file: null,
  summaryPage: 0,
  coverPage: 0,
  firstPage: 0,
  lastPage: 0,
  voice: 'pt-BR-FranciscaNeural',
};

interface Props {
  onClose: () => void;
}

export default function UploadWizard({ onClose }: Props) {
  const navigate = useNavigate();
  const [step, setStep] = useState<1 | 2>(1);
  const [formData, setFormData] = useState<UploadFormData>(INIT);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patch = (p: Partial<UploadFormData>) => setFormData(prev => ({ ...prev, ...p }));

  const handleSubmit = async () => {
    if (!formData.file) return;
    setSubmitting(true);
    setError(null);

    try {
      const fd = new FormData();
      fd.append('name', formData.name);
      fd.append('file', formData.file);
      fd.append('summaryPage', String(formData.summaryPage));
      fd.append('coverPage', String(formData.coverPage));
      fd.append('firstPage', String(formData.firstPage));
      fd.append('lastPage', String(formData.lastPage));
      fd.append('voice', formData.voice);

      const { bookId } = await uploadBook(fd);
      requestBook(bookId);
      onClose();
      navigate(`/books/${bookId}/edit`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Upload failed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 rounded-2xl border border-gray-700 w-full max-w-lg shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <div className="flex items-center gap-3">
            {step === 2 && (
              <button
                className="text-gray-500 hover:text-gray-300 transition-colors"
                onClick={() => setStep(1)}
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
            )}
            <div>
              <h2 className="text-lg font-semibold text-gray-100">{t('Add book')}</h2>
              <p className="text-sm text-gray-500 mt-0.5">{t('Step {step} of 2', { step })}</p>
            </div>
          </div>
          <button className="text-gray-500 hover:text-gray-300" onClick={onClose}>
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6">
          {error && (
            <div className="mb-4 p-3 bg-red-900/30 border border-red-800 rounded-lg text-sm text-red-300">
              {error}
            </div>
          )}

          {step === 1 ? (
            <Step1BookInfo
              data={formData}
              onChange={patch}
              onNext={() => setStep(2)}
            />
          ) : (
            <Step2PageSelection
              data={formData}
              onChange={patch}
              onBack={() => setStep(1)}
              onSubmit={handleSubmit}
              submitting={submitting}
            />
          )}
        </div>
      </div>
    </div>
  );
}
