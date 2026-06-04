import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { useWebSocket } from './hooks/useWebSocket';
import LibraryPage from './pages/LibraryPage';
import EditBookPage from './pages/EditBookPage';
import PlayerPage from './pages/PlayerPage';

function AppInner() {
  useWebSocket();
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LibraryPage />} />
        <Route path="/books/:id" element={<PlayerPage />} />
        <Route path="/books/:id/edit" element={<EditBookPage />} />
      </Routes>
    </BrowserRouter>
  );
}

export default function App() {
  return <AppInner />;
}
