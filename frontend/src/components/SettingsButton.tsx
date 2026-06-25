import { useState } from 'react';
import ConfirmDialog from './ConfirmDialog';
import { t } from '../i18n';

export default function SettingsButton() {
  const [confirming, setConfirming] = useState(false);

  const clearCache = () => {
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
    window.location.reload();
  };

  return (
    <>
      <button
        className="fixed bottom-4 left-4 z-20 p-3 rounded-full bg-gray-800/80 border border-gray-700 text-gray-400 hover:text-amber-500 hover:border-amber-500/50 backdrop-blur shadow-lg transition-colors"
        onClick={() => setConfirming(true)}
        title={t('Clear cache')}
        aria-label={t('Clear cache')}
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </button>

      {confirming && (
        <ConfirmDialog
          title={t('Clear cache?')}
          message={t('Cached library data on this device will be cleared and reloaded from the server.')}
          confirmLabel={t('Clear cache')}
          onConfirm={clearCache}
          onClose={() => setConfirming(false)}
        />
      )}
    </>
  );
}
